import * as crypto from "node:crypto";

import type { WhatsAppChannelConfig } from "@/shared/channels";
import { startKeepAlive } from "@/server/channels/core/processing-indicator";
import { RetryableSendError } from "@/server/channels/core/types";
import type {
  GatewayMessage,
  PlatformAdapter,
  ReplyMedia,
} from "@/server/channels/core/types";
import type { WhatsAppMediaType } from "@/server/channels/whatsapp/whatsapp-api";
import {
  isRetryableWhatsAppSendError,
  markAsRead,
  sendMediaMessage,
  sendMessage,
  uploadMedia,
} from "@/server/channels/whatsapp/whatsapp-api";

export interface WhatsAppExtractedMessage {
  text: string;
  from: string;
  messageId: string;
  phoneNumberId: string;
  name?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

type WhatsAppWebhookMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: {
    body?: string;
  };
};

type WhatsAppWebhookValue = {
  metadata?: {
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: {
      name?: string;
    };
    wa_id?: string;
  }>;
  messages?: WhatsAppWebhookMessage[];
};

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

function replyMediaTypeToWhatsApp(type: ReplyMedia["type"]): WhatsAppMediaType {
  switch (type) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "file":
      return "document";
  }
}

/**
 * Send a single media item to a WhatsApp recipient.
 *
 * - URL sources are sent directly via the WhatsApp `link` field.
 * - Data (base64) sources are uploaded to WhatsApp's media endpoint first,
 *   then sent via the returned media id.
 */
async function sendMediaItem(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  media: ReplyMedia,
  caption?: string,
): Promise<void> {
  const waType = replyMediaTypeToWhatsApp(media.type);

  if (media.source.kind === "url") {
    await sendMediaMessage(accessToken, phoneNumberId, to, waType, { link: media.source.url }, {
      caption,
      filename: media.type === "file" ? filenameFromUrl(media.source.url) : undefined,
    });
    return;
  }

  // Data source: upload first, then send by id.
  const buffer = Buffer.from(media.source.base64, "base64");
  const filename = media.source.filename ?? `attachment.${extensionFromMime(media.source.mimeType)}`;
  const mediaId = await uploadMedia(accessToken, phoneNumberId, media.source.mimeType, buffer, filename);
  await sendMediaMessage(accessToken, phoneNumberId, to, waType, { id: mediaId }, {
    caption,
    filename: media.type === "file" ? filename : undefined,
  });
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const last = url.split("/").pop();
    return last && last.includes(".") ? last : undefined;
  } catch {
    return undefined;
  }
}

function extensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "application/pdf": "pdf",
  };
  return map[mimeType] ?? "bin";
}

// ---------------------------------------------------------------------------

function toRetryableSendError(
  message: string,
  cause?: unknown,
): RetryableSendError {
  return new RetryableSendError(message, { cause });
}

function getFirstValue(payload: unknown): WhatsAppWebhookValue | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const entry = (payload as { entry?: unknown[] }).entry;
  if (!Array.isArray(entry) || entry.length === 0) {
    return null;
  }

  const firstEntry = entry[0];
  if (!firstEntry || typeof firstEntry !== "object") {
    return null;
  }

  const changes = (firstEntry as { changes?: unknown[] }).changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return null;
  }

  const firstChange = changes[0];
  if (!firstChange || typeof firstChange !== "object") {
    return null;
  }

  const value = (firstChange as { value?: unknown }).value;
  return value && typeof value === "object" ? (value as WhatsAppWebhookValue) : null;
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function isWhatsAppSignatureValid(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  return timingSafeEqualHex(expected, received);
}

export function extractWhatsAppMessageId(payload: unknown): string | null {
  const message = getFirstValue(payload)?.messages?.[0];
  return typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
}

export function createWhatsAppAdapter(
  config: WhatsAppChannelConfig,
): PlatformAdapter<unknown, WhatsAppExtractedMessage> {
  return {
    extractMessage(payload) {
      const value = getFirstValue(payload);
      const message = value?.messages?.[0];
      if (!message) {
        return { kind: "skip", reason: "no_messages" } as const;
      }

      if (message.type !== "text") {
        return { kind: "skip", reason: "unsupported_message_type" } as const;
      }

      const text = message.text?.body?.trim();
      if (!text) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      const senderWaId = value?.contacts?.[0]?.wa_id ?? message.from;
      if (typeof senderWaId !== "string" || senderWaId.length === 0) {
        return { kind: "fail", reason: "no_sender" } as const;
      }

      if (typeof message.id !== "string" || message.id.length === 0) {
        return { kind: "fail", reason: "no_message_id" } as const;
      }

      const phoneNumberId = value?.metadata?.phone_number_id ?? config.phoneNumberId;
      if (typeof phoneNumberId !== "string" || phoneNumberId.length === 0) {
        return { kind: "fail", reason: "no_phone_number_id" } as const;
      }

      return {
        kind: "message",
        message: {
          text,
          from: senderWaId,
          messageId: message.id,
          phoneNumberId,
          name: value?.contacts?.[0]?.profile?.name,
        },
      } as const;
    },

    async sendReply(message, replyText) {
      try {
        await sendMessage(config.accessToken ?? "", message.phoneNumberId, message.from, replyText);
      } catch (error) {
        if (isRetryableWhatsAppSendError(error)) {
          throw toRetryableSendError(
            `whatsapp_send_retryable: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }

        throw error;
      }
    },

    async sendReplyRich(message, reply) {
      const media = reply.media ?? [];
      const legacyImages = (!reply.media || reply.media.length === 0) ? (reply.images ?? []) : [];
      const hasMedia = media.length > 0 || legacyImages.length > 0;

      if (!hasMedia) {
        // Text-only reply — fast path.
        await this.sendReply(message, reply.text);
        return;
      }

      const accessToken = config.accessToken ?? "";
      const { phoneNumberId, from } = message;
      const sendMediaFallback = async (name: string) => {
        await sendMessage(
          accessToken,
          phoneNumberId,
          from,
          `(${name} attachment could not be delivered on WhatsApp)`,
        );
      };

      // Send the text portion first (if non-empty).
      if (reply.text.trim().length > 0) {
        await this.sendReply(message, reply.text);
      }

      // Deliver each generic media item natively.
      for (const item of media) {
        try {
          await sendMediaItem(accessToken, phoneNumberId, from, item);
        } catch (error) {
          if (isRetryableWhatsAppSendError(error)) {
            throw toRetryableSendError(
              `whatsapp_send_retryable: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
          }

          // Graceful degradation — never emit "[inline ...]" placeholders.
          const name =
            item.source.kind === "data" && item.source.filename
              ? item.source.filename
              : item.type;
          await sendMediaFallback(name);
        }
      }

      // Legacy images (deprecated path).
      for (const image of legacyImages) {
        try {
          const legacyMedia: ReplyMedia = {
            type: "image",
            source: image,
          };
          await sendMediaItem(accessToken, phoneNumberId, from, legacyMedia);
        } catch (error) {
          if (isRetryableWhatsAppSendError(error)) {
            throw toRetryableSendError(
              `whatsapp_send_retryable: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
          }

          await sendMediaFallback("image");
        }
      }
    },

    buildGatewayMessages(message): GatewayMessage[] {
      return [
        ...(message.history ?? []),
        { role: "user", content: message.text },
      ];
    },

    getSessionKey(message) {
      return `whatsapp:dm:${message.from}`;
    },

    async sendBootMessage(message, text) {
      await sendMessage(
        config.accessToken ?? "",
        message.phoneNumberId,
        message.from,
        text,
      );

      return {
        async update() {
          // WhatsApp does not support editing sent messages.
        },
        async clear() {
          // Deletion is not supported by the API client.
        },
      };
    },

    async sendTypingIndicator(message) {
      await markAsRead(config.accessToken ?? "", message.phoneNumberId, message.messageId);
    },

    async startProcessingIndicator(message) {
      return startKeepAlive(async () => {
        await markAsRead(config.accessToken ?? "", message.phoneNumberId, message.messageId);
      }, 4_000);
    },
  };
}
