import * as crypto from "node:crypto";

import type { TelegramChannelConfig } from "@/shared/channels";
import { toPlainText } from "@/server/channels/core/reply";
import { startKeepAlive } from "@/server/channels/core/processing-indicator";
import { RetryableSendError } from "@/server/channels/core/types";
import type {
  GatewayMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { logWarn } from "@/server/log";
import {
  deleteMessage,
  downloadFile,
  editMessageText,
  getFile,
  isRetryableTelegramSendError,
  sendChatAction,
  sendMessage,
  sendPhoto,
  TelegramApiError,
  TELEGRAM_MAX_CAPTION_LEN,
} from "@/server/channels/telegram/bot-api";

export interface TelegramExtractedMessage {
  text: string;
  chatId: string;
  photoFileId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export function normalizeTelegramSlashCommand(
  rawText: string,
  botUsername: string,
): { shouldHandle: boolean; text: string } {
  const trimmed = rawText.trim();
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/iu.exec(trimmed);
  if (!match) {
    return { shouldHandle: true, text: rawText };
  }

  const [, command, mentionedBot, args = ""] = match;
  if (mentionedBot && mentionedBot.toLowerCase() !== botUsername.toLowerCase()) {
    return { shouldHandle: false, text: rawText };
  }

  return {
    shouldHandle: true,
    text: `/${command}${args.length > 0 ? ` ${args}` : ""}`,
  };
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

function extractTelegramPhotoFileId(update: unknown): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const payload = update as Record<string, unknown>;
  const message = payload.message ?? payload.edited_message ?? payload.channel_post;
  if (!message || typeof message !== "object") {
    return null;
  }

  const photos = (message as Record<string, unknown>).photo;
  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  // Telegram sends photos as an array of PhotoSize sorted by size.
  // The last element is the highest resolution.
  const largest = photos[photos.length - 1];
  if (!largest || typeof largest !== "object") {
    return null;
  }

  const fileId = (largest as Record<string, unknown>).file_id;
  return typeof fileId === "string" && fileId.length > 0 ? fileId : null;
}

function extractTelegramCaption(update: unknown): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const payload = update as Record<string, unknown>;
  const message = payload.message ?? payload.edited_message ?? payload.channel_post;
  if (!message || typeof message !== "object") {
    return null;
  }

  const caption = (message as Record<string, unknown>).caption;
  if (typeof caption !== "string" || caption.length === 0) {
    return null;
  }

  return caption;
}

function inferMimeTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function inferImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/svg+xml") return "svg";
  return "png";
}

function toRetryableSendError(
  message: string,
  retryAfterSeconds?: number,
  cause?: unknown,
): RetryableSendError {
  return new RetryableSendError(message, { retryAfterSeconds, cause });
}

export function createTelegramAdapter(
  config: TelegramChannelConfig,
): PlatformAdapter<unknown, TelegramExtractedMessage> {
  return {
    extractMessage(payload: unknown) {
      const text = extractTelegramText(payload);
      const photoFileId = extractTelegramPhotoFileId(payload);
      const caption = extractTelegramCaption(payload);

      if (!text && !photoFileId) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      const chatId = extractTelegramChatId(payload);
      if (!chatId) {
        return { kind: "fail", reason: "no_chat_id" } as const;
      }

      const rawMessageText = text ?? caption ?? "";
      const normalized = normalizeTelegramSlashCommand(rawMessageText, config.botUsername);
      if (!normalized.shouldHandle) {
        return { kind: "skip", reason: "command_for_other_bot" } as const;
      }

      return {
        kind: "message",
        message: {
          text: normalized.text,
          chatId,
          ...(photoFileId ? { photoFileId } : {}),
        },
      } as const;
    },

    async buildGatewayMessages(
      message: TelegramExtractedMessage,
    ): Promise<GatewayMessage[]> {
      const history = message.history ?? [];

      if (!message.photoFileId) {
        return [
          ...history,
          { role: "user", content: message.text },
        ];
      }

      try {
        const file = await getFile(config.botToken, message.photoFileId);
        if (!file.file_path) {
          logWarn("channels.telegram_photo_no_file_path", {
            fileId: message.photoFileId,
          });
          return [
            ...history,
            { role: "user", content: message.text || "[photo]" },
          ];
        }

        const buffer = await downloadFile(config.botToken, file.file_path);

        // Reject photos larger than 5 MB to avoid excessive memory usage
        // from base64 encoding (~33% overhead) and downstream payload limits.
        const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
        if (buffer.length > MAX_PHOTO_BYTES) {
          logWarn("channels.telegram_photo_too_large", {
            fileId: message.photoFileId,
            sizeBytes: buffer.length,
            maxBytes: MAX_PHOTO_BYTES,
          });
          return [
            ...history,
            { role: "user", content: message.text || "[photo too large to process]" },
          ];
        }

        const mimeType = inferMimeTypeFromPath(file.file_path);
        const base64 = buffer.toString("base64");
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const contentParts: Array<
          | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
          | { type: "text"; text: string }
        > = [
          { type: "image_url", image_url: { url: dataUrl, detail: "auto" as const } },
        ];

        if (message.text) {
          contentParts.push({ type: "text", text: message.text });
        }

        return [
          ...history,
          { role: "user", content: contentParts },
        ];
      } catch (error) {
        logWarn("channels.telegram_photo_download_failed", {
          fileId: message.photoFileId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [
          ...history,
          { role: "user", content: message.text || "[photo — download failed]" },
        ];
      }
    },

    async startProcessingIndicator(message) {
      return startKeepAlive(async () => {
        await sendChatAction(config.botToken, Number(message.chatId), "typing");
      }, 4_000);
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

    async sendReplyRich(message, reply) {
      const images = reply.images ?? [];
      if (images.length === 0) {
        await this.sendReply(message, toPlainText(reply));
        return;
      }

      const chatId = Number(message.chatId);
      const replyText = reply.text;

      try {
        for (let i = 0; i < images.length; i++) {
          const image = images[i]!;
          // Only the first image gets a caption
          // sendPhoto captions are limited to 1024 chars; truncate here,
          // and the overflow sendMessage below handles the full text.
          const caption =
            i === 0 && replyText
              ? replyText.slice(0, TELEGRAM_MAX_CAPTION_LEN)
              : undefined;

          if (image.kind === "url") {
            await sendPhoto(config.botToken, chatId, { kind: "url", url: image.url }, caption);
          } else {
            const buffer = Buffer.from(image.base64, "base64");
            const extension = inferImageExtension(image.mimeType);
            const filename = image.filename ?? `openclaw-image.${extension}`;
            await sendPhoto(
              config.botToken,
              chatId,
              { kind: "buffer", buffer, filename, mimeType: image.mimeType },
              caption,
            );
          }
        }

        // If caption was truncated, send the remainder as a separate text message
        if (replyText && replyText.length > TELEGRAM_MAX_CAPTION_LEN) {
          const overflow = replyText.slice(TELEGRAM_MAX_CAPTION_LEN);
          if (overflow.length > 0) {
            await sendMessage(config.botToken, chatId, overflow);
          }
        }
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

    async sendBootMessage(message, text) {
      const chatId = Number(message.chatId);
      const result = await sendMessage(config.botToken, chatId, text);
      const messageId = result.message_id;

      return {
        async update(newText: string) {
          try {
            await editMessageText(config.botToken, chatId, messageId, newText);
          } catch {
            // Non-fatal — boot message updates are cosmetic
          }
        },
        async clear() {
          try {
            await deleteMessage(config.botToken, chatId, messageId);
          } catch {
            // Non-fatal — message may already be gone
          }
        },
      };
    },

    getSessionKey(message) {
      return `telegram:dm:${message.chatId}`;
    },
  };
}
