import * as path from "node:path";
import type {
  ChannelReply,
  ReplyBinarySource,
  ReplyMedia,
} from "@/server/channels/core/types";
import { logInfo, logWarn } from "@/server/log";
import { getSandboxController } from "@/server/sandbox/controller";

export type QueuedChannelJob<TPayload = unknown> = {
  payload: TPayload;
  receivedAt: number;
  origin: string;
  retryCount?: number;
  nextAttemptAt?: number;
  lastError?: string;
  lastRetryAt?: number;
  dedupId?: string;
  /** Root operation ID for end-to-end correlation across webhook → queue → consumer → lifecycle. */
  opId?: string;
  /** Parent operation ID when this job was spawned from another correlated flow. */
  parentOpId?: string | null;
  /** Ingress request ID (x-vercel-id / x-request-id) for end-to-end correlation across async handoffs. */
  requestId?: string | null;
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Retry helpers (used by drain-channel-workflow and launch-verify)
// ---------------------------------------------------------------------------

class RetryableChannelError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryableChannelError";
  }
}

export function isRetryable(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof RetryableChannelError) {
    return true;
  }

  if ((error as { name?: unknown }).name === "RetryableSendError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("socket")
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Sandbox media resolution (used by drain-channel-workflow for rich replies)
// ---------------------------------------------------------------------------

const SANDBOX_HOME_DIR = "/home/vercel-sandbox";
// 20 MB limit for general media (video, audio, documents).
// Telegram accepts up to 50 MB for most file types; Slack up to 1 GB.
// We use a conservative limit to keep serverless memory reasonable.
const MAX_SANDBOX_MEDIA_BYTES = 20 * 1024 * 1024;

export function isSandboxRelativePath(url: string): boolean {
  // Not an absolute URL (no protocol) and not a data URI
  return !url.includes("://") && !url.startsWith("data:");
}

/** Allow only safe characters in filenames to prevent shell injection. */
export function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");
}

/** Accept only normalized absolute paths under /workspace/. */
export function isSafeWorkspaceAbsolutePath(value: string): boolean {
  if (!value.startsWith("/workspace/")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !normalized.startsWith("/workspace/")) {
    return false;
  }

  const relativePath = normalized.slice("/workspace/".length);
  if (!relativePath) {
    return false;
  }

  return relativePath.split("/").every(isSafeFilename);
}

/**
 * Resolve an exact absolute sandbox path into a `kind: "data"` binary source.
 * Only accepts paths that pass `isSafeWorkspaceAbsolutePath`.
 */
export async function resolveExactSandboxPathFromSandbox(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  absolutePath: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  if (!isSafeWorkspaceAbsolutePath(absolutePath)) {
    return null;
  }
  try {
    const buffer = await sandbox.readFileToBuffer({ path: absolutePath });
    if (!buffer || buffer.length === 0) {
      return null;
    }
    if (buffer.length > MAX_SANDBOX_MEDIA_BYTES) {
      logWarn("channels.sandbox_media_too_large", {
        path: absolutePath,
        sizeBytes: buffer.length,
        maxBytes: MAX_SANDBOX_MEDIA_BYTES,
      });
      return null;
    }
    const filename = path.posix.basename(absolutePath);
    const mimeType = inferMimeTypeFromFilename(filename);
    const base64 = buffer.toString("base64");
    logInfo("channels.sandbox_media_resolved", {
      filename,
      path: absolutePath,
      sizeBytes: buffer.length,
      mimeType,
    });
    return { kind: "data", mimeType, base64, filename };
  } catch (error) {
    logWarn("channels.sandbox_media_resolve_failed", {
      error: formatError(error),
      path: absolutePath,
      reason: "read_failed",
    });
    return null;
  }
}

/**
 * Unified resolver: bare filenames go through candidate-dir fan-out,
 * normalized `/workspace/*` paths resolve directly, everything else
 * is rejected.
 */
export async function resolveSandboxUrlSource(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  reference: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  if (isSafeFilename(reference)) {
    return resolveFilenameFromSandbox(sandbox, reference);
  }
  if (isSafeWorkspaceAbsolutePath(reference)) {
    return resolveExactSandboxPathFromSandbox(sandbox, reference);
  }
  logWarn("channels.sandbox_media_unsafe_filename", { filename: reference });
  return null;
}

export function inferMimeTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  // Images
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  // Audio
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  // Video
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  // Documents
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

/** Candidate sandbox directories to search for bare filenames. */
export const SANDBOX_CANDIDATE_DIRS = [
  SANDBOX_HOME_DIR,
  `${SANDBOX_HOME_DIR}/Desktop`,
  `${SANDBOX_HOME_DIR}/Downloads`,
  `${SANDBOX_HOME_DIR}/.openclaw`,
  `${SANDBOX_HOME_DIR}/.openclaw/generated/worker`,
  "/workspace/openclaw-generated/worker",
  "/tmp",
];

/**
 * Try to resolve a bare filename from the sandbox filesystem into a
 * `kind: "data"` binary source.  Returns `null` when the file cannot
 * be found or is too large.
 */
export async function resolveFilenameFromSandbox(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  filename: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  const candidatePaths = SANDBOX_CANDIDATE_DIRS.map(
    (dir) => `${dir}/${filename}`,
  );

  for (const path of candidatePaths) {
    try {
      const buffer = await sandbox.readFileToBuffer({ path });
      if (!buffer || buffer.length === 0) {
        continue;
      }
      if (buffer.length > MAX_SANDBOX_MEDIA_BYTES) {
        logWarn("channels.sandbox_media_too_large", {
          path,
          sizeBytes: buffer.length,
          maxBytes: MAX_SANDBOX_MEDIA_BYTES,
        });
        continue;
      }
      const mimeType = inferMimeTypeFromFilename(filename);
      const base64 = buffer.toString("base64");

      logInfo("channels.sandbox_media_resolved", {
        filename,
        path,
        sizeBytes: buffer.length,
        mimeType,
      });
      return { kind: "data", mimeType, base64, filename };
    } catch {
      continue;
    }
  }

  logWarn("channels.sandbox_media_not_found", { filename, candidatePaths });
  return null;
}

/**
 * Resolve sandbox-relative media references by downloading them from the
 * sandbox.  Handles both the legacy `images` array and the generic `media`
 * array.  HTTPS URLs and data URIs are left untouched.
 */
export async function resolveSandboxMedia(
  reply: ChannelReply,
  sandboxId: string | null,
): Promise<ChannelReply> {
  if (!sandboxId) return reply;

  // Collect all sandbox-relative references from both images and media.
  const hasRelativeImages = reply.images?.some(
    (img) => img.kind === "url" && isSandboxRelativePath(img.url),
  );
  const hasRelativeMedia = reply.media?.some(
    (m) => m.source.kind === "url" && isSandboxRelativePath(m.source.url),
  );

  if (!hasRelativeImages && !hasRelativeMedia) return reply;

  let sandbox;
  try {
    sandbox = await getSandboxController().get({ sandboxId });
  } catch (error) {
    logWarn("channels.sandbox_media_resolve_failed", {
      error: formatError(error),
      reason: "sandbox_unreachable",
    });
    return reply;
  }

  // --- Resolve legacy images ---
  let resolvedImages: NonNullable<ChannelReply["images"]> | undefined;
  if (reply.images && reply.images.length > 0) {
    const out: NonNullable<ChannelReply["images"]> = [];
    for (const image of reply.images) {
      if (image.kind !== "url" || !isSandboxRelativePath(image.url)) {
        out.push(image);
        continue;
      }
      const reference = image.url;
      const resolved = await resolveSandboxUrlSource(sandbox, reference);
      if (resolved) {
        out.push({ ...resolved, alt: image.alt });
      } else {
        out.push(image);
      }
    }
    resolvedImages = out.length > 0 ? out : undefined;
  }

  // --- Resolve generic media ---
  let resolvedMedia: ReplyMedia[] | undefined;
  if (reply.media && reply.media.length > 0) {
    const out: ReplyMedia[] = [];
    for (const entry of reply.media) {
      if (entry.source.kind !== "url" || !isSandboxRelativePath(entry.source.url)) {
        out.push(entry);
        continue;
      }
      const reference = entry.source.url;
      const resolved = await resolveSandboxUrlSource(sandbox, reference);
      if (resolved) {
        const source: ReplyBinarySource = { ...resolved, alt: entry.source.alt };
        out.push({ ...entry, source } as ReplyMedia);
      } else {
        out.push(entry);
      }
    }
    resolvedMedia = out.length > 0 ? out : undefined;
  }

  return {
    text: reply.text,
    images: resolvedImages ?? reply.images,
    media: resolvedMedia ?? reply.media,
  };
}
