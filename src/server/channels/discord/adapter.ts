import * as crypto from "node:crypto";

import type { DiscordChannelConfig } from "@/shared/channels";
import type {
  ExtractedChannelMessage,
  PlatformAdapter,
  RetryableSendError,
} from "@/server/channels/core/types";
import {
  sendChannelMessage,
  triggerTyping,
} from "@/server/channels/discord/discord-api";

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_PUBLIC_KEY_BYTES = 32;
const DISCORD_SIGNATURE_BYTES = 64;
const DISCORD_MAX_MESSAGE_LENGTH = 2_000;
const DISCORD_TRUNCATION_MARKER = "...";
const DISCORD_REQUEST_TIMEOUT_MS = 15_000;
const DISCORD_MAX_TIMESTAMP_SKEW_SECONDS = 300;
const DISCORD_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PRIORITY_TEXT_OPTION_NAMES = new Set([
  "text",
  "prompt",
  "message",
  "query",
  "input",
  "question",
]);

type DiscordInteractionData = {
  name?: string;
  options?: unknown[];
};

type DiscordInteractionUser = {
  id?: string;
};

type DiscordInteractionPayload = {
  id?: string;
  type?: number;
  token?: string;
  channel_id?: string;
  application_id?: string;
  data?: DiscordInteractionData;
  user?: DiscordInteractionUser;
  member?: {
    user?: DiscordInteractionUser;
  };
};

export interface DiscordExtractedMessage extends ExtractedChannelMessage {
  applicationId: string;
  interactionId: string;
  interactionToken: string;
  channelId: string;
  userId: string;
}

type CreateDiscordAdapterOptions = {
  fetchFn?: typeof fetch;
};

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatOptionValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

type ParsedOptionValue = {
  name: string;
  value: string;
};

function parseOptionValues(options: unknown[]): ParsedOptionValue[] {
  const parsed: ParsedOptionValue[] = [];

  for (const option of options) {
    const record = toObject(option);
    if (!record) {
      continue;
    }

    const name = toStringOrNull(record.name) ?? "";
    const formatted = formatOptionValue(record.value);
    if (formatted) {
      parsed.push({
        name: name.toLowerCase(),
        value: formatted,
      });
    }

    if (Array.isArray(record.options)) {
      parsed.push(...parseOptionValues(record.options));
    }
  }

  return parsed;
}

function resolveCommandText(data: DiscordInteractionData | undefined): string | null {
  if (!data) {
    return null;
  }

  const options = Array.isArray(data.options) ? parseOptionValues(data.options) : [];
  for (const option of options) {
    if (PRIORITY_TEXT_OPTION_NAMES.has(option.name) && option.value.length > 0) {
      return option.value;
    }
  }

  if (options[0]?.value) {
    return options[0].value;
  }

  const commandName = toStringOrNull(data.name);
  return commandName ? `/${commandName}` : null;
}

function resolveUserId(payload: DiscordInteractionPayload): string | null {
  return toStringOrNull(payload.member?.user?.id) ?? toStringOrNull(payload.user?.id);
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const numeric = Number(headerValue);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }

  return undefined;
}

function isDiscordInteractionWebhookExpiredStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function clampDiscordText(text: string): string {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) {
    return text;
  }

  const maxPrefixLength = DISCORD_MAX_MESSAGE_LENGTH - DISCORD_TRUNCATION_MARKER.length;
  return `${text.slice(0, maxPrefixLength)}${DISCORD_TRUNCATION_MARKER}`;
}

function resolveDiscordSplitPoint(text: string, maxLen: number): number {
  const window = text.slice(0, maxLen);

  const doubleNewline = window.lastIndexOf("\n\n");
  if (doubleNewline >= 0) {
    return doubleNewline + 2;
  }

  const singleNewline = window.lastIndexOf("\n");
  if (singleNewline >= 0) {
    return singleNewline + 1;
  }

  const space = window.lastIndexOf(" ");
  if (space >= 0) {
    return space + 1;
  }

  return maxLen;
}

function splitDiscordText(text: string, maxLen = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (!Number.isFinite(maxLen) || maxLen < 1 || text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const splitPoint = resolveDiscordSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint);
  }
  chunks.push(remaining);
  return chunks;
}

function splitDiscordReplyContent(text: string): string[] {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  let chunks = splitDiscordText(text);
  while (true) {
    const totalChunks = chunks.length;
    const adjustedChunks: string[] = [];
    let changed = false;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      if (index === 0) {
        adjustedChunks.push(chunk);
        continue;
      }

      const prefix = `(${index + 1}/${totalChunks}) `;
      const maxContentLength = DISCORD_MAX_MESSAGE_LENGTH - prefix.length;
      if (chunk.length <= maxContentLength) {
        adjustedChunks.push(chunk);
        continue;
      }

      changed = true;
      adjustedChunks.push(...splitDiscordText(chunk, maxContentLength));
    }

    if (!changed) {
      return adjustedChunks;
    }

    chunks = adjustedChunks;
  }
}

function isLikelyNetworkError(error: unknown): boolean {
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
    message.includes("socket") ||
    message.includes("econn") ||
    message.includes("enotfound")
  );
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function isHexWithByteLength(value: string, bytes: number): boolean {
  const normalized = normalizeHex(value);
  return normalized.length === bytes * 2 && /^[0-9a-f]+$/i.test(normalized);
}

function createDiscordEd25519PublicKey(publicKeyHex: string): crypto.KeyObject | null {
  if (!isHexWithByteLength(publicKeyHex, DISCORD_PUBLIC_KEY_BYTES)) {
    return null;
  }

  try {
    const rawPublicKey = Buffer.from(normalizeHex(publicKeyHex), "hex");
    return crypto.createPublicKey({
      key: Buffer.concat([DISCORD_ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export function verifyDiscordRequestSignature(
  rawBody: string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  if (!rawBody || timestamp.trim().length === 0) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || !Number.isInteger(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > DISCORD_MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  if (!isHexWithByteLength(signatureHex, DISCORD_SIGNATURE_BYTES)) {
    return false;
  }

  const publicKey = createDiscordEd25519PublicKey(publicKeyHex);
  if (!publicKey) {
    return false;
  }

  try {
    const message = Buffer.from(`${timestamp}${rawBody}`, "utf8");
    const signature = Buffer.from(normalizeHex(signatureHex), "hex");
    return crypto.verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

function resolveDiscordWebhookMessageUrl(message: DiscordExtractedMessage): string {
  return `https://discord.com/api/v10/webhooks/${message.applicationId}/${message.interactionToken}/messages/@original`;
}

function toRetryableSendError(
  message: string,
  retryAfterSeconds?: number,
  cause?: unknown,
): RetryableSendError {
  const error = new Error(message) as Error & {
    name: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  };
  error.name = "RetryableSendError";
  error.retryAfterSeconds = retryAfterSeconds;
  error.cause = cause;
  return error as RetryableSendError;
}

export function createDiscordAdapter(
  config: DiscordChannelConfig,
  options: CreateDiscordAdapterOptions = {},
): PlatformAdapter<unknown, DiscordExtractedMessage> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return {
    extractMessage(payload: unknown) {
      const interaction = toObject(payload) as DiscordInteractionPayload | null;
      if (!interaction) {
        return { kind: "fail", reason: "invalid_payload" } as const;
      }

      if (interaction.type === DISCORD_INTERACTION_PING) {
        return { kind: "skip", reason: "ping" } as const;
      }

      if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND) {
        return { kind: "skip", reason: "unsupported_interaction_type" } as const;
      }

      const text = resolveCommandText(interaction.data);
      if (!text) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      const interactionToken = toStringOrNull(interaction.token);
      if (!interactionToken) {
        return { kind: "fail", reason: "no_interaction_token" } as const;
      }

      const applicationId = toStringOrNull(interaction.application_id);
      if (!applicationId) {
        return { kind: "fail", reason: "no_application_id" } as const;
      }

      const channelId = toStringOrNull(interaction.channel_id);
      if (!channelId) {
        return { kind: "fail", reason: "no_channel_id" } as const;
      }

      const userId = resolveUserId(interaction);
      if (!userId) {
        return { kind: "fail", reason: "no_user_id" } as const;
      }

      const interactionId = toStringOrNull(interaction.id) ?? "unknown";

      return {
        kind: "message",
        message: {
          text,
          interactionId,
          interactionToken,
          applicationId,
          channelId,
          userId,
        },
      } as const;
    },

    async sendTypingIndicator(message) {
      await triggerTyping(message.channelId, config.botToken, { fetchFn });
    },

    async sendReply(message, replyText) {
      const contentChunks = splitDiscordReplyContent(replyText);
      const initialContent = clampDiscordText(contentChunks[0] ?? "");
      let response: Response;
      try {
        response = await fetchFn(resolveDiscordWebhookMessageUrl(message), {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: initialContent,
          }),
          signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (isLikelyNetworkError(error)) {
          throw toRetryableSendError(
            `discord_followup_network: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            error,
          );
        }
        throw error;
      }

      if (isDiscordInteractionWebhookExpiredStatus(response.status)) {
        for (let index = 0; index < contentChunks.length; index += 1) {
          const chunk = clampDiscordText(contentChunks[index] ?? "");
          const fallbackBaseContent =
            index === 0
              ? `<@${message.userId}> ${chunk}`
              : `(${index + 1}/${contentChunks.length}) ${chunk}`;
          const fallbackContent = clampDiscordText(fallbackBaseContent);

          let fallbackResponse: Response;
          try {
            fallbackResponse = await sendChannelMessage(
              message.channelId,
              config.botToken,
              fallbackContent,
              {
                fetchFn,
                allowedMentionsUserId: message.userId,
              },
            );
          } catch (error) {
            if (isLikelyNetworkError(error)) {
              throw toRetryableSendError(
                `discord_channel_fallback_network: ${error instanceof Error ? error.message : String(error)}`,
                undefined,
                error,
              );
            }
            throw error;
          }

          if (fallbackResponse.status === 429 || fallbackResponse.status >= 500) {
            throw toRetryableSendError(
              `discord_channel_fallback_retryable status=${fallbackResponse.status}`,
              parseRetryAfterSeconds(fallbackResponse.headers.get("retry-after")),
            );
          }

          if (!fallbackResponse.ok) {
            const body = await fallbackResponse.text().catch(() => "");
            const detail = body.slice(0, 200);
            throw new Error(
              detail.length > 0
                ? `discord_channel_fallback_failed status=${fallbackResponse.status} body=${detail}`
                : `discord_channel_fallback_failed status=${fallbackResponse.status}`,
            );
          }
        }
        return;
      }

      if (response.status === 429 || response.status >= 500) {
        throw toRetryableSendError(
          `discord_followup_retryable status=${response.status}`,
          parseRetryAfterSeconds(response.headers.get("retry-after")),
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = body.slice(0, 200);
        throw new Error(
          detail.length > 0
            ? `discord_followup_failed status=${response.status} body=${detail}`
            : `discord_followup_failed status=${response.status}`,
        );
      }
    },

    getSessionKey(message) {
      return `discord:channel:${message.channelId}`;
    },
  };
}
