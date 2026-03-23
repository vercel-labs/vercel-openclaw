import { start } from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractTelegramChatId, isTelegramWebhookSecretValid } from "@/server/channels/telegram/adapter";
import { sendMessage } from "@/server/channels/telegram/bot-api";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { OPENCLAW_TELEGRAM_WEBHOOK_PORT } from "@/server/openclaw/config";
import { getSandboxDomain } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const FORWARD_TIMEOUT_MS = 10_000;

function extractUpdateId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { update_id?: unknown };
  if (typeof raw.update_id === "number") {
    return String(raw.update_id);
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secretHeader || !isTelegramWebhookSecretValid(config, secretHeader)) {
    return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: true });
  }

  // Always return 200 to Telegram — any failure here must not cause Telegram
  // to back off and stop delivering webhooks.
  try {
    const updateId = extractUpdateId(payload);
    if (updateId) {
      const accepted = await getStore().acquireLock(channelDedupKey("telegram", updateId), 24 * 60 * 60);
      if (!accepted) {
        return Response.json({ ok: true });
      }
    }

    const op = createOperationContext({
      trigger: "channel.telegram.webhook",
      reason: "incoming telegram webhook",
      requestId: requestId ?? null,
      channel: "telegram",
      dedupId: updateId ?? null,
      sandboxId: meta.sandboxId ?? null,
      snapshotId: meta.snapshotId ?? null,
      status: meta.status,
    });

    logInfo("channels.telegram_webhook_accepted", withOperationContext(op));

    // --- Fast path: forward raw update to OpenClaw's native Telegram handler ---
    // When the sandbox is running, OpenClaw handles the full Telegram lifecycle
    // natively (images, replies, Bot API calls) on port 8787.  This avoids the
    // app-layer image download/re-upload pipeline.
    if (meta.status === "running" && meta.sandboxId) {
      try {
        const sandboxWebhookUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
        const forwardUrl = `${sandboxWebhookUrl}/telegram-webhook`;
        const forwardResponse = await fetch(forwardUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secretHeader,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        if (forwardResponse.ok) {
          logInfo("channels.telegram_fast_path_ok", withOperationContext(op, { sandboxId: meta.sandboxId }));
          return Response.json({ ok: true });
        }
        logWarn("channels.telegram_fast_path_non_ok", withOperationContext(op, {
          status: forwardResponse.status,
          sandboxId: meta.sandboxId,
        }));
      } catch (error) {
        logWarn("channels.telegram_fast_path_failed", withOperationContext(op, {
          error: error instanceof Error ? error.message : String(error),
          sandboxId: meta.sandboxId,
        }));
      }
      // Fall through to queue-based path
    }

    // Send "Starting up" boot message from the webhook route (before workflow)
    // so the user gets immediate feedback. The message ID is passed to the
    // workflow so the step can edit/delete it during processing.
    let bootMessageId: number | null = null;
    const chatId = extractTelegramChatId(payload);
    if (meta.status !== "running" && chatId) {
      try {
        const result = await sendMessage(config.botToken, Number(chatId), "Starting up\u2026 I'll respond in a moment.");
        bootMessageId = result.message_id;
        logInfo("channels.telegram_boot_message_sent", withOperationContext(op, { chatId, bootMessageId }));
      } catch (err) {
        logWarn("channels.telegram_boot_message_failed", withOperationContext(op, {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    try {
      const origin = getPublicOrigin(request);
      await start(drainChannelWorkflow, ["telegram", payload, origin, requestId ?? null, bootMessageId]);
      logInfo("channels.telegram_workflow_started", withOperationContext(op));
    } catch (error) {
      logWarn("channels.telegram_workflow_start_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  } catch (error) {
    logError("channels.telegram_webhook_enqueue_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true });
}
