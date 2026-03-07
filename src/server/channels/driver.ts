import type { ChannelName } from "@/shared/channels";
import type { SingleMeta } from "@/shared/types";
import { extractReply, toPlainText } from "@/server/channels/core/reply";
import type {
  ExtractedChannelMessage,
  GatewayMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { appendSessionHistory, readSessionHistory } from "@/server/channels/history";
import {
  channelDeadLetterKey,
  channelDrainLockKey,
  channelQueueKey,
} from "@/server/channels/keys";
import { logError, logInfo, logWarn } from "@/server/log";
import {
  ensureSandboxReady,
  getSandboxDomain,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const DRAIN_LOCK_TTL_SECONDS = 10 * 60;
const MAX_RETRY_COUNT = 8;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;
const CHANNEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export type QueuedChannelJob<TPayload = unknown> = {
  payload: TPayload;
  receivedAt: number;
  origin: string;
  retryCount?: number;
  nextAttemptAt?: number;
  lastError?: string;
  lastRetryAt?: number;
};

type DeadLetterEntry = {
  failedAt: number;
  error: string;
  channel: ChannelName;
  job: QueuedChannelJob;
};

type DrainChannelQueueOptions<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
> = {
  channel: ChannelName;
  getConfig(meta: SingleMeta): TConfig | null;
  createAdapter(config: TConfig): PlatformAdapter<TPayload, TMessage>;
};

export async function enqueueChannelJob<TPayload>(
  channel: ChannelName,
  job: QueuedChannelJob<TPayload>,
): Promise<void> {
  const store = getStore();
  await store.enqueue(channelQueueKey(channel), JSON.stringify(job));
  logInfo("channels.job_enqueued", {
    channel,
    receivedAt: job.receivedAt,
    retryCount: job.retryCount ?? 0,
  });
}

export async function getChannelQueueDepth(channel: ChannelName): Promise<number> {
  return getStore().getQueueLength(channelQueueKey(channel));
}

export async function drainChannelQueue<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  options: DrainChannelQueueOptions<TConfig, TPayload, TMessage>,
): Promise<void> {
  const store = getStore();
  const lockKey = channelDrainLockKey(options.channel);
  const lockToken = await store.acquireLock(lockKey, DRAIN_LOCK_TTL_SECONDS);
  if (!lockToken) {
    return;
  }

  const deferredJobs: QueuedChannelJob<TPayload>[] = [];

  try {
    for (;;) {
      const rawJob = await store.dequeue(channelQueueKey(options.channel));
      if (!rawJob) {
        break;
      }

      let job: QueuedChannelJob<TPayload>;
      try {
        job = JSON.parse(rawJob) as QueuedChannelJob<TPayload>;
      } catch (error) {
        await writeDeadLetter(options.channel, {
          failedAt: Date.now(),
          error: formatError(error),
          channel: options.channel,
          job: {
            payload: rawJob,
            origin: process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "unknown",
            receivedAt: Date.now(),
          },
        });
        continue;
      }

      if (
        typeof job.nextAttemptAt === "number" &&
        Number.isFinite(job.nextAttemptAt) &&
        job.nextAttemptAt > Date.now()
      ) {
        deferredJobs.push(job);
        continue;
      }

      try {
        await processChannelJob(options, job);
      } catch (error) {
        if (isRetryable(error)) {
          const retryJob = withRetry(job, error);
          if (retryJob) {
            deferredJobs.push(retryJob);
            logWarn("channels.job_requeued", {
              channel: options.channel,
              error: formatError(error),
              retryCount: retryJob.retryCount ?? 0,
            });
            continue;
          }

          logError("channels.job_retry_exhausted", {
            channel: options.channel,
            error: formatError(error),
          });
          await writeDeadLetter(options.channel, {
            failedAt: Date.now(),
            error: formatError(error),
            channel: options.channel,
            job,
          });
          continue;
        }

        logError("channels.job_failed", {
          channel: options.channel,
          error: formatError(error),
        });
        await writeDeadLetter(options.channel, {
          failedAt: Date.now(),
          error: formatError(error),
          channel: options.channel,
          job,
        });
      }
    }
  } finally {
    for (const job of deferredJobs) {
      await enqueueChannelJob(options.channel, job);
    }

    await store.releaseLock(lockKey, lockToken);
  }
}

async function processChannelJob<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  options: DrainChannelQueueOptions<TConfig, TPayload, TMessage>,
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

  let typingStarted = false;
  try {
    if (adapter.sendTypingIndicator) {
      await adapter.sendTypingIndicator(message);
      typingStarted = true;
    }

    const readyMeta = await ensureSandboxReady({
      origin: resolveAppOrigin(job.origin),
      reason: `channel:${options.channel}`,
    });
    const gatewayUrl = await getSandboxDomain();
    await touchRunningSandbox();

    const messages = adapter.buildGatewayMessages
      ? await adapter.buildGatewayMessages(message)
      : defaultGatewayMessages(message);

    const replyText = await forwardToGateway({
      gatewayUrl,
      gatewayToken: readyMeta.gatewayToken,
      messages,
      sessionKey,
    });

    await adapter.sendReply(message, replyText);
    logInfo("channels.delivery_success", { channel: options.channel });
    if (sessionKey) {
      await appendSessionHistory(options.channel, sessionKey, message.text, replyText);
    }
  } finally {
    if (typingStarted && adapter.clearTypingIndicator) {
      await adapter.clearTypingIndicator(message).catch(() => {});
    }
  }
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
}): Promise<string> {
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
      signal: AbortSignal.timeout(CHANNEL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
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
    throw new Error("gateway_missing_reply");
  }

  return toPlainText(reply);
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

function isRetryable(error: unknown): boolean {
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
  if (typeof maybeRetryAfter === "number" && Number.isFinite(maybeRetryAfter) && maybeRetryAfter > 0) {
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
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (origin) {
    return origin.replace(/\/$/, "");
  }

  throw new Error("NEXT_PUBLIC_APP_URL is required for background channel jobs.");
}

async function writeDeadLetter(
  channel: ChannelName,
  entry: DeadLetterEntry,
): Promise<void> {
  await getStore().enqueue(channelDeadLetterKey(channel), JSON.stringify(entry));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
