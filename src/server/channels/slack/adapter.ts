import * as crypto from "node:crypto";

import { RetryableSendError } from "@/server/channels/core/types";
import type {
  ExtractedChannelMessage,
  OpenClawMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { logWarn } from "@/server/log";

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_MAX_AGE_SECONDS = 60 * 5;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_CONVERSATIONS_REPLIES_URL = "https://slack.com/api/conversations.replies";
const SLACK_THREAD_HISTORY_LIMIT = 10;
const SLACK_REQUEST_TIMEOUT_MS = 15_000;

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

export interface SlackExtractedMessage extends ExtractedChannelMessage {
  channel: string;
  threadTs: string;
  ts: string;
  user?: string;
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
  replyText: string,
  fetchFn?: typeof fetch,
): Promise<void> {
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
        text: replyText,
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

  let payload: SlackSendResponse | null = null;
  try {
    payload = (await response.json()) as SlackSendResponse;
  } catch {
    payload = null;
  }

  if (response.status === 429 || response.status >= 500) {
    throw toRetryableSendError(
      `slack_send_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  if (!response.ok || payload?.ok !== true) {
    const detail = typeof payload?.error === "string" ? payload.error : "";
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
      await postSlackReply(config.botToken, message, replyText, fetchFn);
    },

    getSessionKey(message) {
      return `slack:channel:${message.channel}:thread:${message.threadTs}`;
    },
  };
}
