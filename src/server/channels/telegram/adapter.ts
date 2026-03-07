import * as crypto from "node:crypto";

import type { TelegramChannelConfig } from "@/shared/channels";
import type { PlatformAdapter, RetryableSendError } from "@/server/channels/core/types";
import {
  isRetryableTelegramSendError,
  sendChatAction,
  sendMessage,
  TelegramApiError,
} from "@/server/channels/telegram/bot-api";

export interface TelegramExtractedMessage {
  text: string;
  chatId: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function isTelegramWebhookSecretValid(
  config: TelegramChannelConfig,
  secretHeader: string,
  nowMs = Date.now(),
): boolean {
  if (timingSafeEqual(secretHeader, config.webhookSecret)) {
    return true;
  }

  return Boolean(
    config.previousWebhookSecret &&
      typeof config.previousSecretExpiresAt === "number" &&
      config.previousSecretExpiresAt > nowMs &&
      timingSafeEqual(secretHeader, config.previousWebhookSecret),
  );
}

function extractTelegramChatId(update: unknown): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const payload = update as Record<string, unknown>;
  const message = payload.message ?? payload.edited_message ?? payload.channel_post;
  if (message && typeof message === "object") {
    const chat = (message as Record<string, unknown>).chat;
    if (chat && typeof chat === "object") {
      const chatId = (chat as Record<string, unknown>).id;
      if (typeof chatId === "number") {
        return String(chatId);
      }
    }
  }

  return null;
}

function extractTelegramText(update: unknown): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const payload = update as Record<string, unknown>;
  const message = payload.message ?? payload.edited_message ?? payload.channel_post;
  if (!message || typeof message !== "object") {
    return null;
  }

  const text = (message as Record<string, unknown>).text;
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  return text;
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

export function createTelegramAdapter(
  config: TelegramChannelConfig,
): PlatformAdapter<unknown, TelegramExtractedMessage> {
  return {
    extractMessage(payload: unknown) {
      const text = extractTelegramText(payload);
      if (!text) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      const chatId = extractTelegramChatId(payload);
      if (!chatId) {
        return { kind: "fail", reason: "no_chat_id" } as const;
      }

      return {
        kind: "message",
        message: {
          text,
          chatId,
        },
      } as const;
    },

    async sendTypingIndicator(message) {
      await sendChatAction(config.botToken, Number(message.chatId), "typing");
    },

    async sendReply(message, replyText) {
      try {
        await sendMessage(config.botToken, Number(message.chatId), replyText);
      } catch (error) {
        if (isRetryableTelegramSendError(error)) {
          const retryAfterSeconds =
            error instanceof TelegramApiError ? error.retry_after ?? undefined : undefined;
          throw toRetryableSendError(
            `telegram_send_retryable: ${error instanceof Error ? error.message : String(error)}`,
            retryAfterSeconds,
            error,
          );
        }
        throw error;
      }
    },

    getSessionKey(message) {
      return `telegram:dm:${message.chatId}`;
    },
  };
}
