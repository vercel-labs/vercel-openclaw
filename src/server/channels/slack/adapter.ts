import * as crypto from "node:crypto";

import { RetryableSendError } from "@/server/channels/core/types";
import type {
  ChannelReply,
  ExtractedChannelMessage,
  OpenClawMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import type { ProcessingIndicator } from "@/server/channels/core/processing-indicator";
import { logInfo, logWarn } from "@/server/log";

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_MAX_AGE_SECONDS = 60 * 5;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_DELETE_MESSAGE_URL = "https://slack.com/api/chat.delete";
const SLACK_UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update";
const SLACK_CONVERSATIONS_REPLIES_URL = "https://slack.com/api/conversations.replies";
const SLACK_FILES_GET_UPLOAD_URL_EXTERNAL_URL = "https://slack.com/api/files.getUploadURLExternal";
const SLACK_FILES_COMPLETE_UPLOAD_EXTERNAL_URL = "https://slack.com/api/files.completeUploadExternal";
const SLACK_THREAD_HISTORY_LIMIT = 10;
const SLACK_REQUEST_TIMEOUT_MS = 15_000;
const SLACK_PROCESSING_PLACEHOLDER_TEXT = "_Thinking..._";
const SLACK_FALLBACK_IMAGE_TEXT = "Sent an image.";
const SLACK_DEFAULT_IMAGE_ALT_TEXT = "Image from OpenClaw";
const SLACK_MAX_BLOCK_IMAGES = 5;

type SlackConfig = {
  signingSecret: string;
  botToken: string;
};

type SlackEventPayload = {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    user?: string;
  };
};

type SlackSendResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
};

type SlackThreadReply = {
  subtype?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  user?: string;
};

type SlackConversationsRepliesResponse = SlackSendResponse & {
  messages?: SlackThreadReply[];
};

type SlackFilesGetUploadURLExternalResponse = SlackSendResponse & {
  upload_url?: string;
  file_id?: string;
};

type SlackSectionBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

type SlackImageBlock = {
  type: "image";
  image_url: string;
  alt_text: string;
};

type SlackBlock = SlackSectionBlock | SlackImageBlock;

type SlackReplyPayload = {
  text: string;
  blocks?: SlackBlock[];
};

type SlackDecodedImageData = {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  altText: string;
};

export interface SlackExtractedMessage extends ExtractedChannelMessage {
  channel: string;
  threadTs: string;
  ts: string;
  user?: string;
  processingPlaceholderTs?: string;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lowerMessage = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("econn") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("socket")
  );
}

function toSlackPayload(payload: unknown): SlackEventPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return payload as SlackEventPayload;
}

function toSlackHistoryRole(reply: SlackThreadReply): OpenClawMessage["role"] {
  return reply.bot_id ? "assistant" : "user";
}

function toRetryableSendError(
  message: string,
  retryAfterSeconds?: number,
  cause?: unknown,
): RetryableSendError {
  return new RetryableSendError(message, { retryAfterSeconds, cause });
}

function parseRetryAfterSeconds(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) {
    return undefined;
  }

  const numeric = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }

  return numeric;
}

function isSlackProcessingPlaceholder(
  reply: Pick<SlackThreadReply, "text" | "bot_id">,
): boolean {
  return Boolean(
    reply.bot_id &&
      typeof reply.text === "string" &&
      reply.text.trim() === SLACK_PROCESSING_PLACEHOLDER_TEXT,
  );
}

function canFallbackFromPlaceholderUpdateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("error=message_not_found") ||
    error.message.includes("error=cant_update_message")
  );
}

async function updateProcessingPlaceholder(
  botToken: string,
  channel: string,
  ts: string,
  textOrPayload: string | SlackReplyPayload,
  fetchFn?: typeof fetch,
): Promise<void> {
  const messagePayload: SlackReplyPayload =
    typeof textOrPayload === "string"
      ? { text: textOrPayload }
      : textOrPayload;
  const runFetch = fetchFn ?? globalThis.fetch;
  let response: Response;

  try {
    response = await runFetch(SLACK_UPDATE_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel,
        ts,
        text: messagePayload.text,
        ...(messagePayload.blocks ? { blocks: messagePayload.blocks } : {}),
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_processing_placeholder_update_network: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let responsePayload: SlackSendResponse | null = null;
  try {
    responsePayload = (await response.json()) as SlackSendResponse;
  } catch {
    responsePayload = null;
  }

  if (response.status === 429 || response.status >= 500) {
    throw toRetryableSendError(
      `slack_processing_placeholder_update_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  if (!response.ok || responsePayload?.ok !== true) {
    const detail = typeof responsePayload?.error === "string" ? responsePayload.error : "";
    throw new Error(
      detail
        ? `slack_processing_placeholder_update_failed: status=${response.status} error=${detail}`
        : `slack_processing_placeholder_update_failed: status=${response.status}`,
    );
  }

  logInfo("channels.slack_processing_placeholder_updated", {
    channel,
    ts,
  });
}

async function fetchSlackThreadHistory(options: {
  botToken: string;
  channel: string;
  threadTs: string;
  currentTs: string;
  fetchFn?: typeof fetch;
}): Promise<OpenClawMessage[]> {
  try {
    const fetchFn = options.fetchFn ?? globalThis.fetch;
    const url = new URL(SLACK_CONVERSATIONS_REPLIES_URL);
    url.searchParams.set("channel", options.channel);
    url.searchParams.set("ts", options.threadTs);
    url.searchParams.set("inclusive", "true");
    url.searchParams.set("limit", String(SLACK_THREAD_HISTORY_LIMIT));

    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.botToken}`,
      },
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return [];
    }

    let payload: SlackConversationsRepliesResponse | null = null;
    try {
      payload = (await response.json()) as SlackConversationsRepliesResponse;
    } catch {
      payload = null;
    }

    if (!payload?.ok || !Array.isArray(payload.messages)) {
      return [];
    }

    const history: OpenClawMessage[] = [];
    for (const reply of payload.messages) {
      if (!reply?.text || !reply.ts || reply.ts === options.currentTs) {
        continue;
      }
      if (reply.subtype && reply.subtype !== "bot_message") {
        continue;
      }
      if (isSlackProcessingPlaceholder(reply)) {
        continue;
      }
      history.push({
        role: toSlackHistoryRole(reply),
        content: reply.text,
      });
    }

    return history.slice(-SLACK_THREAD_HISTORY_LIMIT);
  } catch (error) {
    logWarn("channels.slack_history_fetch_failed", {
      channel: options.channel,
      threadTs: options.threadTs,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function postSlackReply(
  botToken: string,
  message: SlackExtractedMessage,
  replyTextOrPayload: string | SlackReplyPayload,
  fetchFn?: typeof fetch,
): Promise<void> {
  const messagePayload: SlackReplyPayload =
    typeof replyTextOrPayload === "string"
      ? { text: replyTextOrPayload }
      : replyTextOrPayload;
  const runFetch = fetchFn ?? globalThis.fetch;
  let response: Response;

  try {
    response = await runFetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: message.channel,
        thread_ts: message.threadTs,
        text: messagePayload.text,
        ...(messagePayload.blocks ? { blocks: messagePayload.blocks } : {}),
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_send_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let responsePayload: SlackSendResponse | null = null;
  try {
    responsePayload = (await response.json()) as SlackSendResponse;
  } catch {
    responsePayload = null;
  }

  if (response.status === 429 || response.status >= 500) {
    throw toRetryableSendError(
      `slack_send_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  if (!response.ok || responsePayload?.ok !== true) {
    const detail = typeof responsePayload?.error === "string" ? responsePayload.error : "";
    throw new Error(
      detail ? `slack_send_failed: status=${response.status} error=${detail}` : `slack_send_failed: status=${response.status}`,
    );
  }
}

export function isValidSlackSignature(options: {
  signingSecret: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  if (!options.signatureHeader || !options.timestampHeader) {
    return false;
  }

  const timestamp = Number.parseInt(options.timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const [version, signature] = options.signatureHeader.split("=", 2);
  if (version !== SLACK_SIGNATURE_VERSION || !signature) {
    return false;
  }

  const baseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${options.rawBody}`;
  const expected = crypto
    .createHmac("sha256", options.signingSecret)
    .update(baseString)
    .digest("hex");

  return timingSafeEqual(expected, signature);
}

export function getSlackUrlVerificationChallenge(payload: unknown): string | null {
  const parsed = toSlackPayload(payload);
  if (parsed?.type === "url_verification" && typeof parsed.challenge === "string") {
    return parsed.challenge;
  }

  return null;
}

async function postProcessingPlaceholder(
  botToken: string,
  channel: string,
  threadTs: string,
  fetchFn?: typeof fetch,
): Promise<string> {
  const runFetch = fetchFn ?? globalThis.fetch;
  let response: Response;

  try {
    response = await runFetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text: SLACK_PROCESSING_PLACEHOLDER_TEXT,
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_processing_placeholder_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let payload: SlackSendResponse | null = null;
  try {
    payload = (await response.json()) as SlackSendResponse;
  } catch {
    payload = null;
  }

  if (response.status === 429 || response.status >= 500) {
    throw toRetryableSendError(
      `slack_processing_placeholder_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  if (!response.ok || payload?.ok !== true || typeof payload.ts !== "string" || payload.ts.length === 0) {
    const detail = typeof payload?.error === "string" ? payload.error : "";
    throw new Error(
      detail
        ? `slack_processing_placeholder_failed: status=${response.status} error=${detail}`
        : `slack_processing_placeholder_failed: status=${response.status}`,
    );
  }

  logInfo("channels.slack_processing_placeholder_posted", {
    channel,
    threadTs,
    placeholderTs: payload.ts,
  });

  return payload.ts;
}

async function deleteProcessingPlaceholder(
  botToken: string,
  channel: string,
  ts: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  const runFetch = fetchFn ?? globalThis.fetch;
  let response: Response;

  try {
    response = await runFetch(SLACK_DELETE_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel,
        ts,
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_processing_placeholder_delete_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let payload: SlackSendResponse | null = null;
  try {
    payload = (await response.json()) as SlackSendResponse;
  } catch {
    payload = null;
  }

  if (response.status === 429 || response.status >= 500) {
    throw toRetryableSendError(
      `slack_processing_placeholder_delete_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  const detail = typeof payload?.error === "string" ? payload.error : "";
  if (detail === "message_not_found") {
    logInfo("channels.slack_processing_placeholder_already_gone", {
      channel,
      ts,
    });
    return;
  }

  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      detail
        ? `slack_processing_placeholder_delete_failed: status=${response.status} error=${detail}`
        : `slack_processing_placeholder_delete_failed: status=${response.status}`,
    );
  }

  logInfo("channels.slack_processing_placeholder_deleted", {
    channel,
    ts,
  });
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toReplyImages(reply: ChannelReply): NonNullable<ChannelReply["images"]> {
  return reply.images ?? [];
}

function isReplyImageKind(
  image: NonNullable<ChannelReply["images"]>[number],
  kind: "url" | "data",
): boolean {
  return image.kind === kind;
}

function toReplyImageUrl(
  image: NonNullable<ChannelReply["images"]>[number],
): string | undefined {
  if (image.kind === "url") {
    return image.url;
  }
  return undefined;
}

function toReplyImageAltText(
  image: NonNullable<ChannelReply["images"]>[number],
): string {
  return image.alt ?? SLACK_DEFAULT_IMAGE_ALT_TEXT;
}

function toSlackFallbackText(reply: ChannelReply): string {
  const text = toNonEmptyString(reply.text);
  return text ?? SLACK_FALLBACK_IMAGE_TEXT;
}

function toDataReplyImages(
  reply: ChannelReply,
): Array<Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }>> {
  return toReplyImages(reply).filter(
    (image): image is Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }> =>
      isReplyImageKind(image, "data"),
  );
}

export function toSlackBlocks(reply: ChannelReply): SlackBlock[] | undefined {
  const blocks: SlackBlock[] = [];
  const replyText = toNonEmptyString(reply.text);
  if (replyText) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: replyText,
      },
    });
  }

  let urlImageCount = 0;
  for (const image of toReplyImages(reply)) {
    if (urlImageCount >= SLACK_MAX_BLOCK_IMAGES) {
      break;
    }

    if (!isReplyImageKind(image, "url")) {
      continue;
    }

    const imageUrl = toReplyImageUrl(image);
    if (!imageUrl) {
      continue;
    }

    blocks.push({
      type: "image",
      image_url: imageUrl,
      alt_text: toReplyImageAltText(image),
    });
    urlImageCount += 1;
  }

  return blocks.length > 0 ? blocks : undefined;
}

function toImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpg";
  }
  if (normalized === "image/gif") {
    return "gif";
  }
  if (normalized === "image/webp") {
    return "webp";
  }
  if (normalized === "image/svg+xml") {
    return "svg";
  }
  return "png";
}

function sanitizeImageFilename(filename: string): string {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "openclaw-image";
}

function decodeReplyImageData(
  image: Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }>,
): SlackDecodedImageData {
  let base64Payload = image.base64.trim();
  let inferredMimeType: string | undefined;
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(base64Payload);
  if (dataUrlMatch) {
    inferredMimeType = toNonEmptyString(dataUrlMatch[1]);
    base64Payload = dataUrlMatch[2] ?? "";
  }

  const normalizedBase64 = base64Payload
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  if (normalizedBase64.length === 0 || normalizedBase64.length % 4 === 1) {
    throw new Error("slack_upload_prepare_failed: invalid base64 image data");
  }

  if (/[^A-Za-z0-9+/=]/.test(normalizedBase64)) {
    throw new Error("slack_upload_prepare_failed: invalid base64 characters");
  }

  const bytes = Buffer.from(normalizedBase64, "base64");
  if (bytes.length === 0) {
    throw new Error("slack_upload_prepare_failed: decoded image is empty");
  }

  const mimeType = image.mimeType ?? inferredMimeType ?? "image/png";
  const extension = toImageExtension(mimeType);
  const explicitFilename = toNonEmptyString(image.filename);
  const filename = explicitFilename
    ? sanitizeImageFilename(explicitFilename)
    : `openclaw-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  return {
    bytes,
    filename: filename.includes(".") ? filename : `${filename}.${extension}`,
    mimeType,
    altText: toReplyImageAltText(image),
  };
}

async function uploadSlackImageData(
  botToken: string,
  message: SlackExtractedMessage,
  image: Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }>,
  fetchFn?: typeof fetch,
): Promise<void> {
  const runFetch = fetchFn ?? globalThis.fetch;
  const decoded = decodeReplyImageData(image);

  // Step 1: Get upload URL
  let getUploadResponse: Response;
  try {
    getUploadResponse = await runFetch(SLACK_FILES_GET_UPLOAD_URL_EXTERNAL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        filename: decoded.filename,
        length: decoded.bytes.length,
        alt_txt: decoded.altText,
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_upload_prepare_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let getUploadJson: SlackFilesGetUploadURLExternalResponse | null = null;
  try {
    getUploadJson = (await getUploadResponse.json()) as SlackFilesGetUploadURLExternalResponse;
  } catch {
    getUploadJson = null;
  }

  const getUploadErrorCode = typeof getUploadJson?.error === "string" ? getUploadJson.error : null;
  const getUploadFailureMessage = `slack_upload_prepare_failed: status=${getUploadResponse.status}${
    getUploadErrorCode ? ` error=${getUploadErrorCode}` : ""
  }`;
  const getUploadRetryAfterSeconds = parseRetryAfterSeconds(
    getUploadResponse.headers.get("retry-after"),
  );

  if (getUploadResponse.status === 429 || getUploadResponse.status >= 500) {
    throw toRetryableSendError(getUploadFailureMessage, getUploadRetryAfterSeconds);
  }

  if (!getUploadResponse.ok || getUploadJson?.ok !== true) {
    throw new Error(getUploadFailureMessage);
  }

  const uploadUrl = toNonEmptyString(getUploadJson?.upload_url);
  const fileId = toNonEmptyString(getUploadJson?.file_id);
  if (!uploadUrl || !fileId) {
    throw new Error("slack_upload_prepare_failed: missing upload_url or file_id");
  }

  // Step 2: Upload file bytes
  const formData = new FormData();
  formData.set("filename", decoded.filename);
  formData.set("length", String(decoded.bytes.length));
  formData.set(
    "file",
    new Blob([Uint8Array.from(decoded.bytes)], { type: decoded.mimeType }),
    decoded.filename,
  );

  let uploadResponse: Response;
  try {
    uploadResponse = await runFetch(uploadUrl, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_upload_transfer_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  const uploadFailureMessage = `slack_upload_transfer_failed: status=${uploadResponse.status}`;
  const uploadRetryAfterSeconds = parseRetryAfterSeconds(uploadResponse.headers.get("retry-after"));
  if (uploadResponse.status === 429 || uploadResponse.status >= 500) {
    throw toRetryableSendError(uploadFailureMessage, uploadRetryAfterSeconds);
  }

  if (!uploadResponse.ok) {
    throw new Error(uploadFailureMessage);
  }

  // Step 3: Complete upload and attach to thread
  let completeUploadResponse: Response;
  try {
    completeUploadResponse = await runFetch(SLACK_FILES_COMPLETE_UPLOAD_EXTERNAL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        files: [{ id: fileId, title: decoded.filename }],
        channel_id: message.channel,
        thread_ts: message.threadTs,
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw toRetryableSendError(
        `slack_upload_complete_network: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
    throw error;
  }

  let completeUploadJson: SlackSendResponse | null = null;
  try {
    completeUploadJson = (await completeUploadResponse.json()) as SlackSendResponse;
  } catch {
    completeUploadJson = null;
  }

  const completeUploadErrorCode =
    typeof completeUploadJson?.error === "string" ? completeUploadJson.error : null;
  const completeUploadFailureMessage = `slack_upload_complete_failed: status=${completeUploadResponse.status}${
    completeUploadErrorCode ? ` error=${completeUploadErrorCode}` : ""
  }`;
  const completeUploadRetryAfterSeconds = parseRetryAfterSeconds(
    completeUploadResponse.headers.get("retry-after"),
  );

  if (completeUploadResponse.status === 429 || completeUploadResponse.status >= 500) {
    throw toRetryableSendError(completeUploadFailureMessage, completeUploadRetryAfterSeconds);
  }

  if (!completeUploadResponse.ok || completeUploadJson?.ok !== true) {
    throw new Error(completeUploadFailureMessage);
  }

  logInfo("channels.slack_image_uploaded", {
    channel: message.channel,
    threadTs: message.threadTs,
    filename: decoded.filename,
    fileId,
  });
}

export function createSlackAdapter(
  config: SlackConfig,
  options: { fetchFn?: typeof fetch } = {},
): PlatformAdapter<unknown, SlackExtractedMessage> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return {
    async extractMessage(payload: unknown) {
      const parsed = toSlackPayload(payload);
      if (!parsed) {
        return { kind: "fail", reason: "invalid_payload" } as const;
      }

      if (parsed.type !== "event_callback") {
        return { kind: "skip", reason: "unsupported_payload_type" } as const;
      }

      const event = parsed.event;
      if (!event || event.type !== "message") {
        return { kind: "skip", reason: "unsupported_event_type" } as const;
      }

      if (event.bot_id || event.subtype === "bot_message") {
        return { kind: "skip", reason: "bot_message" } as const;
      }

      if (event.subtype && event.subtype !== "file_share") {
        return { kind: "skip", reason: `unsupported_subtype:${event.subtype}` } as const;
      }

      if (typeof event.text !== "string" || event.text.trim().length === 0) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      if (typeof event.channel !== "string" || event.channel.length === 0) {
        return { kind: "fail", reason: "no_channel" } as const;
      }

      if (typeof event.ts !== "string" || event.ts.length === 0) {
        return { kind: "fail", reason: "no_ts" } as const;
      }

      const threadTs =
        typeof event.thread_ts === "string" && event.thread_ts.length > 0
          ? event.thread_ts
          : event.ts;

      const history =
        threadTs !== event.ts
          ? await fetchSlackThreadHistory({
              botToken: config.botToken,
              channel: event.channel,
              threadTs,
              currentTs: event.ts,
              fetchFn,
            })
          : undefined;

      return {
        kind: "message",
        message: {
          text: event.text.trim(),
          channel: event.channel,
          threadTs,
          ts: event.ts,
          user: typeof event.user === "string" ? event.user : undefined,
          history,
        },
      } as const;
    },

    async sendReply(message, replyText) {
      const placeholderTs = message.processingPlaceholderTs;

      if (placeholderTs) {
        try {
          await updateProcessingPlaceholder(
            config.botToken,
            message.channel,
            placeholderTs,
            replyText,
            fetchFn,
          );
          message.processingPlaceholderTs = undefined;
          return;
        } catch (error) {
          if (!canFallbackFromPlaceholderUpdateError(error)) {
            throw error;
          }

          logWarn("channels.slack_processing_placeholder_update_fallback", {
            channel: message.channel,
            threadTs: message.threadTs,
            placeholderTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await postSlackReply(config.botToken, message, replyText, fetchFn);

      if (placeholderTs) {
        try {
          await deleteProcessingPlaceholder(
            config.botToken,
            message.channel,
            placeholderTs,
            fetchFn,
          );
          message.processingPlaceholderTs = undefined;
        } catch (error) {
          logWarn("channels.slack_processing_placeholder_delete_failed_after_reply", {
            channel: message.channel,
            threadTs: message.threadTs,
            placeholderTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    async sendReplyRich(message, reply) {
      const slackPayload: SlackReplyPayload = {
        text: toSlackFallbackText(reply),
        blocks: toSlackBlocks(reply),
      };
      const dataImages = toDataReplyImages(reply);

      const placeholderTs = message.processingPlaceholderTs;

      if (placeholderTs) {
        try {
          await updateProcessingPlaceholder(
            config.botToken,
            message.channel,
            placeholderTs,
            slackPayload,
            fetchFn,
          );
          message.processingPlaceholderTs = undefined;

          for (const image of dataImages) {
            await uploadSlackImageData(config.botToken, message, image, fetchFn);
          }
          return;
        } catch (error) {
          if (!canFallbackFromPlaceholderUpdateError(error)) {
            throw error;
          }

          logWarn("channels.slack_processing_placeholder_update_fallback", {
            channel: message.channel,
            threadTs: message.threadTs,
            placeholderTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await postSlackReply(config.botToken, message, slackPayload, fetchFn);

      for (const image of dataImages) {
        await uploadSlackImageData(config.botToken, message, image, fetchFn);
      }

      if (placeholderTs) {
        try {
          await deleteProcessingPlaceholder(
            config.botToken,
            message.channel,
            placeholderTs,
            fetchFn,
          );
          message.processingPlaceholderTs = undefined;
        } catch (error) {
          logWarn("channels.slack_processing_placeholder_delete_failed_after_reply", {
            channel: message.channel,
            threadTs: message.threadTs,
            placeholderTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    async startProcessingIndicator(message): Promise<ProcessingIndicator> {
      const placeholderTs = await postProcessingPlaceholder(
        config.botToken,
        message.channel,
        message.threadTs,
        fetchFn,
      );

      message.processingPlaceholderTs = placeholderTs;

      return {
        async stop() {
          const ts = message.processingPlaceholderTs;
          message.processingPlaceholderTs = undefined;

          if (!ts) {
            return;
          }

          await deleteProcessingPlaceholder(
            config.botToken,
            message.channel,
            ts,
            fetchFn,
          );
        },
      };
    },

    async sendBootMessage(message, text) {
      const runFetch = fetchFn;
      let response: Response;

      try {
        response = await runFetch(SLACK_POST_MESSAGE_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: message.channel,
            thread_ts: message.threadTs,
            text,
          }),
          signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Non-fatal — fall through to return a no-op handle
        return { async update() {}, async clear() {} };
      }

      let payload: SlackSendResponse | null = null;
      try {
        payload = (await response.json()) as SlackSendResponse;
      } catch {
        payload = null;
      }

      const bootTs = payload?.ok === true && typeof payload.ts === "string" ? payload.ts : null;
      if (!bootTs) {
        return { async update() {}, async clear() {} };
      }

      return {
        async update(newText: string) {
          try {
            await updateProcessingPlaceholder(
              config.botToken,
              message.channel,
              bootTs,
              newText,
              fetchFn,
            );
          } catch {
            // Non-fatal — boot message updates are cosmetic
          }
        },
        async clear() {
          try {
            await deleteProcessingPlaceholder(
              config.botToken,
              message.channel,
              bootTs,
              fetchFn,
            );
          } catch {
            // Non-fatal — message may already be gone
          }
        },
      };
    },

    getSessionKey(message) {
      return `slack:channel:${message.channel}:thread:${message.threadTs}`;
    },
  };
}
