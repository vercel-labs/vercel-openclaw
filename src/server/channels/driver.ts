import { createHash } from "node:crypto";

import type { ChannelName } from "@/shared/channels";
import type { SingleMeta } from "@/shared/types";
import { extractReply, toPlainText } from "@/server/channels/core/reply";
import { startPlatformProcessingIndicator } from "@/server/channels/core/processing-indicator";
import type {
  ChannelReply,
  ExtractedChannelMessage,
  GatewayMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { appendSessionHistory, readSessionHistory } from "@/server/channels/history";
import {
  channelFailedKey,
  channelDedupKey,
  channelDrainLockKey,
  channelProcessingKey,
  channelQueueKey,
} from "@/server/channels/keys";
import { logError, logInfo, logWarn } from "@/server/log";
import { getPublicOriginFromHint } from "@/server/public-url";
import {
  ensureSandboxReady,
  getSandboxDomain,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const CHANNEL_PROCESSING_INDICATOR_DELAY_MS = 800;
const DRAIN_LOCK_TTL_SECONDS = 10 * 60;
const CHANNEL_DEDUP_TTL_SECONDS = 5 * 60;
const CHANNEL_VISIBILITY_TIMEOUT_SECONDS = 20 * 60;
const MAX_RETRY_COUNT = 8;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;
const CHANNEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS = 25_000;
export const DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS = 15;

export type QueuedChannelJob<TPayload = unknown> = {
  payload: TPayload;
  receivedAt: number;
  origin: string;
  retryCount?: number;
  nextAttemptAt?: number;
  lastError?: string;
  lastRetryAt?: number;
  dedupId?: string;
};

type FailedEntry = {
  failedAt: number;
  error: string;
  channel: ChannelName;
  job: QueuedChannelJob<unknown>;
};

type LeasedChannelQueueEntry = {
  job: string;
  leasedAt: number;
  visibilityTimeoutAt: number;
};

export type ChannelJobOptions<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
> = {
  channel: ChannelName;
  getConfig(meta: SingleMeta): TConfig | null;
  createAdapter(config: TConfig): PlatformAdapter<TPayload, TMessage>;
  /** Override sandbox readiness timeout (ms). Defaults to DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS. */
  sandboxReadyTimeoutMs?: number;
  /** Override gateway request timeout (ms). Defaults to DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
};

type DrainChannelQueueOptions<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
> = ChannelJobOptions<TConfig, TPayload, TMessage>;

export async function enqueueChannelJob<TPayload>(
  channel: ChannelName,
  job: QueuedChannelJob<TPayload>,
): Promise<void> {
  const store = getStore();
  const queueKey = channelQueueKey(channel);
  const rawJob = JSON.stringify(job);
  const isRetry = (job.retryCount ?? 0) > 0 || typeof job.nextAttemptAt === "number";

  if (isRetry) {
    await store.enqueueFront(queueKey, rawJob);
    logInfo("channels.job_enqueued", {
      channel,
      receivedAt: job.receivedAt,
      retryCount: job.retryCount ?? 0,
      deduped: false,
    });
    return;
  }

  const dedupId = resolveJobDedupId(channel, job);
  const dedupResult = await store.enqueueUnique(
    queueKey,
    channelDedupKey(channel, dedupId),
    CHANNEL_DEDUP_TTL_SECONDS,
    rawJob,
  );

  if (!dedupResult.enqueued) {
    logInfo("channels.job_deduped", {
      channel,
      dedupId,
      receivedAt: job.receivedAt,
    });
    return;
  }

  logInfo("channels.job_enqueued", {
    channel,
    receivedAt: job.receivedAt,
    retryCount: job.retryCount ?? 0,
    deduped: false,
  });
}

export async function getChannelQueueDepth(channel: ChannelName): Promise<number> {
  const store = getStore();
  const [queued, processing] = await Promise.all([
    store.getQueueLength(channelQueueKey(channel)),
    store.getQueueLength(channelProcessingKey(channel)),
  ]);

  return queued + processing;
}

export async function drainChannelQueue<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  options: DrainChannelQueueOptions<TConfig, TPayload, TMessage>,
): Promise<void> {
  const store = getStore();
  const queueKey = channelQueueKey(options.channel);
  const processingKey = channelProcessingKey(options.channel);
  const lockKey = channelDrainLockKey(options.channel);
  const lockToken = await store.acquireLock(lockKey, DRAIN_LOCK_TTL_SECONDS);
  if (!lockToken) {
    return;
  }

  try {
    const recovered = await store.requeueExpiredLeases(
      queueKey,
      processingKey,
      Date.now(),
    );
    if (recovered > 0) {
      logWarn("channels.processing_recovered", {
        channel: options.channel,
        recovered,
      });
    }

    for (;;) {
      const leasedValue = await store.leaseQueueItem(
        queueKey,
        processingKey,
        Date.now(),
        CHANNEL_VISIBILITY_TIMEOUT_SECONDS,
      );
      if (!leasedValue) {
        break;
      }

      const leasedEntry = parseLeasedChannelQueueEntry(leasedValue);
      let job: QueuedChannelJob<TPayload>;
      try {
        job = JSON.parse(leasedEntry.job) as QueuedChannelJob<TPayload>;
      } catch (error) {
        await store.ackQueueItem(processingKey, leasedValue);
        await writeFailed(options.channel, {
          failedAt: Date.now(),
          error: formatError(error),
          channel: options.channel,
          job: {
            payload: leasedEntry.job,
            origin: process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "unknown",
            receivedAt: Date.now(),
          },
        });
        continue;
      }

      const now = Date.now();
      if (
        typeof job.nextAttemptAt === "number" &&
        Number.isFinite(job.nextAttemptAt) &&
        job.nextAttemptAt > now
      ) {
        const parkedLease = serializeLeasedChannelQueueEntry(
          leasedEntry.job,
          job.nextAttemptAt,
        );
        const parked = await store.updateQueueLease(
          processingKey,
          leasedValue,
          parkedLease,
        );

        if (!parked) {
          logWarn("channels.job_park_failed", {
            channel: options.channel,
            retryCount: job.retryCount ?? 0,
          });
        }

        continue;
      }

      try {
        await processChannelJob(options, job);
        const acknowledged = await store.ackQueueItem(processingKey, leasedValue);
        if (!acknowledged) {
          logWarn("channels.job_ack_missing", {
            channel: options.channel,
          });
        }
      } catch (error) {
        if (isRetryable(error)) {
          const retryJob = withRetry(job, error);
          if (retryJob) {
            const retryLease = serializeLeasedChannelQueueEntry(
              JSON.stringify(retryJob),
              retryJob.nextAttemptAt ??
                Date.now() + CHANNEL_VISIBILITY_TIMEOUT_SECONDS * 1000,
            );
            const updated = await store.updateQueueLease(
              processingKey,
              leasedValue,
              retryLease,
            );

            if (!updated) {
              logWarn("channels.job_retry_park_failed", {
                channel: options.channel,
                error: formatError(error),
                retryCount: retryJob.retryCount ?? 0,
              });
            } else {
              logWarn("channels.job_requeued", {
                channel: options.channel,
                error: formatError(error),
                retryCount: retryJob.retryCount ?? 0,
              });
            }

            continue;
          }

          logError("channels.job_retry_exhausted", {
            channel: options.channel,
            error: formatError(error),
          });
          await writeFailed(options.channel, {
            failedAt: Date.now(),
            error: formatError(error),
            channel: options.channel,
            job,
          });
          await store.ackQueueItem(processingKey, leasedValue);
          continue;
        }

        logError("channels.job_failed", {
          channel: options.channel,
          error: formatError(error),
        });
        await writeFailed(options.channel, {
          failedAt: Date.now(),
          error: formatError(error),
          channel: options.channel,
          job,
        });
        await store.ackQueueItem(processingKey, leasedValue);
      }
    }
  } finally {
    await store.releaseLock(lockKey, lockToken);
  }
}

export async function runWithProcessingIndicator<
  TMessage extends ExtractedChannelMessage,
  TResult,
>(
  params: {
    channel: ChannelName;
    adapter: PlatformAdapter<unknown, TMessage>;
    message: TMessage;
    delayMs?: number;
    onError?: (error: unknown) => void;
  },
  run: () => Promise<TResult>,
): Promise<TResult> {
  const processingIndicator = await startPlatformProcessingIndicator(
    params.adapter,
    params.message,
    {
      delayMs: params.delayMs ?? CHANNEL_PROCESSING_INDICATOR_DELAY_MS,
      onError: params.onError ?? ((indicatorError) => {
        logWarn("channels.processing_indicator_failed", {
          channel: params.channel,
          error: formatError(indicatorError),
        });
      }),
    },
  );

  try {
    return await run();
  } finally {
    await processingIndicator.stop().catch(() => {});
  }
}

export async function processChannelJob<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  options: ChannelJobOptions<TConfig, TPayload, TMessage>,
  job: QueuedChannelJob<TPayload>,
): Promise<void> {
  const meta = await getInitializedMeta();
  const config = options.getConfig(meta);
  if (!config) {
    throw new Error(`${options.channel}_not_configured`);
  }

  const adapter = options.createAdapter(config);
  const extracted = await adapter.extractMessage(job.payload);
  if (extracted.kind === "skip") {
    logInfo("channels.job_skipped", {
      channel: options.channel,
      reason: extracted.reason,
    });
    return;
  }

  if (extracted.kind === "fail") {
    throw new Error(extracted.reason);
  }

  const message = extracted.message;
  const sessionKey = adapter.getSessionKey?.(message);
  if (sessionKey && (!message.history || message.history.length === 0)) {
    message.history = await readSessionHistory(options.channel, sessionKey);
  }

  const sandboxReadyTimeoutMs =
    options.sandboxReadyTimeoutMs ?? DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS;

  await runWithProcessingIndicator(
    {
      channel: options.channel,
      adapter: adapter as PlatformAdapter<unknown, TMessage>,
      message,
    },
    async () => {
      logInfo("channels.wake_requested", {
        channel: options.channel,
        sandboxReadyTimeoutMs,
      });

      let readyMeta: Awaited<ReturnType<typeof ensureSandboxReady>>;
      let gatewayUrl: string;
      try {
        readyMeta = await ensureSandboxReady({
          origin: resolveAppOrigin(job.origin),
          reason: `channel:${options.channel}`,
          timeoutMs: sandboxReadyTimeoutMs,
        });
        gatewayUrl = await getSandboxDomain();
        logInfo("channels.wake_ready", {
          channel: options.channel,
        });
      } catch (sandboxError) {
        logWarn("channels.wake_retry_scheduled", {
          channel: options.channel,
          error: formatError(sandboxError),
          retryAfterSeconds: DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS,
        });
        throw new RetryableChannelError(
          `sandbox_not_ready: ${formatError(sandboxError)}`,
          DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS,
        );
      }
      await touchRunningSandbox();

      const messages = adapter.buildGatewayMessages
        ? await adapter.buildGatewayMessages(message)
        : defaultGatewayMessages(message);

      const hasImageParts = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
      );

      logInfo("channels.gateway_request_started", {
        channel: options.channel,
        requestTimeoutMs,
        messageCount: messages.length,
        hasImageParts,
      });

      const reply = await forwardToGateway({
        gatewayUrl,
        gatewayToken: readyMeta.gatewayToken,
        messages,
        sessionKey,
        requestTimeoutMs,
      });

      const replyText = toPlainText(reply);
      const imageCount = reply.images?.length ?? 0;

      logInfo("channels.gateway_response_received", {
        channel: options.channel,
        replyTextLength: reply.text.length,
        imageCount,
        imageKinds: reply.images?.map((img) => img.kind) ?? [],
        usingSendReplyRich: Boolean(adapter.sendReplyRich),
      });

      if (adapter.sendReplyRich) {
        await adapter.sendReplyRich(message, reply);
      } else {
        await adapter.sendReply(message, replyText);
      }
      logInfo("channels.platform_reply_sent", {
        channel: options.channel,
        imageCount,
      });
      logInfo("channels.delivery_success", { channel: options.channel });
      if (sessionKey) {
        await appendSessionHistory(options.channel, sessionKey, message.text, replyText);
      }
    },
  );
}

function defaultGatewayMessages(
  message: ExtractedChannelMessage,
): GatewayMessage[] {
  return [
    ...(message.history ?? []),
    { role: "user", content: message.text },
  ];
}

async function forwardToGateway(options: {
  gatewayUrl: string;
  gatewayToken: string;
  messages: GatewayMessage[];
  sessionKey?: string;
  requestTimeoutMs?: number;
}): Promise<ChannelReply> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS;
  const url = new URL("/v1/chat/completions", options.gatewayUrl).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.gatewayToken}`,
  };
  if (options.sessionKey) {
    headers["x-openclaw-session-key"] = options.sessionKey;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "default",
        messages: options.messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      logWarn("channels.gateway_request_timeout", {
        timeoutMs,
      });
    }
    throw toRetryableErrorIfNeeded(error);
  }

  if (response.status === 410) {
    throw new RetryableChannelError("sandbox_gone");
  }

  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new RetryableChannelError(
      `gateway_retryable_${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      body.length > 0
        ? `gateway_failed status=${response.status} body=${body}`
        : `gateway_failed status=${response.status}`,
    );
  }

  const body = await response.text();
  if (!body) {
    throw new RetryableChannelError("gateway_empty_response");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`gateway_invalid_json: ${formatError(error)}`);
  }

  const reply = extractReply(payload);
  if (!reply) {
    logWarn("channels.gateway_missing_reply", {
      bodyLength: body.length,
    });
    throw new Error("gateway_missing_reply");
  }

  return reply;
}

class RetryableChannelError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryableChannelError";
  }
}

function resolveJobDedupId<TPayload>(
  channel: ChannelName,
  job: QueuedChannelJob<TPayload>,
): string {
  const explicitDedupId = job.dedupId?.trim();
  if (explicitDedupId) {
    return explicitDedupId;
  }

  try {
    return createHash("sha256")
      .update(channel)
      .update(":")
      .update(JSON.stringify(job.payload))
      .digest("hex");
  } catch {
    return createHash("sha256")
      .update(channel)
      .update(":")
      .update(String(job.receivedAt))
      .update(":")
      .update(job.origin)
      .digest("hex");
  }
}

function parseLeasedChannelQueueEntry(raw: string): LeasedChannelQueueEntry {
  try {
    const parsed = JSON.parse(raw) as Partial<LeasedChannelQueueEntry>;
    if (typeof parsed.job === "string") {
      return {
        job: parsed.job,
        leasedAt: typeof parsed.leasedAt === "number" ? parsed.leasedAt : 0,
        visibilityTimeoutAt:
          typeof parsed.visibilityTimeoutAt === "number"
            ? parsed.visibilityTimeoutAt
            : 0,
      };
    }
  } catch {
    // Fall through to legacy/raw-entry handling.
  }

  return {
    job: raw,
    leasedAt: 0,
    visibilityTimeoutAt: 0,
  };
}

function serializeLeasedChannelQueueEntry(
  rawJob: string,
  visibilityTimeoutAt: number,
): string {
  const envelope: LeasedChannelQueueEntry = {
    job: rawJob,
    leasedAt: Date.now(),
    visibilityTimeoutAt,
  };

  return JSON.stringify(envelope);
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

function isTimeoutError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message.toLowerCase().includes("timeout") ||
    error.message.toLowerCase().includes("timed out")
  );
}

function toRetryableErrorIfNeeded(error: unknown): Error {
  if (isRetryable(error)) {
    return new RetryableChannelError(formatError(error));
  }

  return error instanceof Error ? error : new Error(String(error));
}

function withRetry<TPayload>(
  job: QueuedChannelJob<TPayload>,
  error: unknown,
): QueuedChannelJob<TPayload> | null {
  const retryCount = (job.retryCount ?? 0) + 1;
  if (retryCount > MAX_RETRY_COUNT) {
    return null;
  }

  const retryAfterSeconds = getRetryAfterSeconds(error);
  const retryDelayMs = computeRetryDelayMs(retryCount - 1, retryAfterSeconds);
  return {
    ...job,
    retryCount,
    nextAttemptAt: Date.now() + retryDelayMs,
    lastRetryAt: Date.now(),
    lastError: formatError(error),
  };
}

function getRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof RetryableChannelError) {
    return error.retryAfterSeconds;
  }

  const maybeRetryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (
    typeof maybeRetryAfter === "number" &&
    Number.isFinite(maybeRetryAfter) &&
    maybeRetryAfter > 0
  ) {
    return maybeRetryAfter;
  }

  return undefined;
}

function computeRetryDelayMs(
  previousRetryCount: number,
  retryAfterSeconds?: number,
): number {
  const exponentialDelayMs = Math.min(
    RETRY_BACKOFF_MAX_MS,
    RETRY_BACKOFF_BASE_MS * (2 ** Math.max(0, previousRetryCount)),
  );

  const retryAfterDelayMs =
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? Math.min(RETRY_BACKOFF_MAX_MS, Math.ceil(retryAfterSeconds * 1000))
      : 0;

  return Math.max(exponentialDelayMs, retryAfterDelayMs);
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const numeric = Number(headerValue);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }

  const timestamp = Date.parse(headerValue);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const waitSeconds = Math.ceil((timestamp - Date.now()) / 1000);
  return waitSeconds > 0 ? waitSeconds : undefined;
}

function resolveAppOrigin(origin: string | null | undefined): string {
  return getPublicOriginFromHint(origin);
}

async function writeFailed(
  channel: ChannelName,
  entry: FailedEntry,
): Promise<void> {
  await getStore().enqueue(channelFailedKey(channel), JSON.stringify(entry));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
