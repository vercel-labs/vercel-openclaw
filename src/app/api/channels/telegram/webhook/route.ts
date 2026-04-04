import * as workflowApi from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractTelegramChatId, isTelegramWebhookSecretValid } from "@/server/channels/telegram/adapter";
import { sendMessage } from "@/server/channels/telegram/bot-api";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { OPENCLAW_TELEGRAM_WEBHOOK_PORT } from "@/server/openclaw/config";
import { getSandboxDomain, reconcileStaleRunningStatus } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

type TelegramWebhookDedupLock = {
  key: string;
  token: string;
};

type TelegramWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const telegramWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

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

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseTelegramWebhookDedupLockForRetry(
  lock: TelegramWebhookDedupLock | null,
): Promise<TelegramWebhookDedupReleaseResult> {
  if (!lock) {
    return { attempted: false, released: false, releaseError: null };
  }

  try {
    await getStore().releaseLock(lock.key, lock.token);
    return { attempted: true, released: true, releaseError: null };
  } catch (error) {
    return {
      attempted: true,
      released: false,
      releaseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const receivedAtMs = Date.now();
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

  // Return 200 only after the update is handled or successfully handed off.
  // If workflow start fails after dedup lock acquisition, return 500 so
  // Telegram can redeliver the same update.
  let dedupLock: TelegramWebhookDedupLock | null = null;
  try {
    const updateId = extractUpdateId(payload);
    if (updateId) {
      const dedupKey = channelDedupKey("telegram", updateId);
      const dedupToken = await getStore().acquireLock(dedupKey, 24 * 60 * 60);
      if (!dedupToken) {
        return Response.json({ ok: true });
      }
      dedupLock = {
        key: dedupKey,
        token: dedupToken,
      };
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

    // --- Fast path: forward to OpenClaw's native Telegram handler ---
    // When the sandbox is running, delegate entirely to the native handler on
    // port 8787.  Await the response so the native handler can complete its
    // full processing cycle (including long AI tasks like image generation).
    // Fluid Compute bills only for CPU cycles, not idle wait time.
    //
    // On ANY HTTP response (2xx or not), return 200 — the native handler
    // received the payload and may have started processing.  Falling through
    // to the workflow would forward the same payload again, causing duplicate
    // delivery (e.g. the same image sent multiple times).
    //
    // Only on network-level failure (fetch throws — connection refused, DNS
    // failure) is it safe to fall through: the native handler never received
    // the payload, so the workflow can retry without duplication.
    let effectiveMeta = meta;
    if (effectiveMeta.status === "running" && effectiveMeta.sandboxId) {
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
        });
        if (forwardResponse.ok) {
          logInfo("channels.telegram_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
          }));
        } else {
          logWarn("channels.telegram_fast_path_non_ok", withOperationContext(op, {
            status: forwardResponse.status,
            sandboxId: effectiveMeta.sandboxId,
          }));
        }
        return Response.json({ ok: true });
      } catch (error) {
        // Network-level failure — sandbox is unreachable, native handler never
        // got the payload.  Reconcile stale status and fall through to the
        // workflow wake path so the message is not lost.
        logWarn("channels.telegram_fast_path_failed", withOperationContext(op, {
          error: error instanceof Error ? error.message : String(error),
          sandboxId: effectiveMeta.sandboxId,
          action: "reconcile_and_wake",
        }));
        effectiveMeta = await reconcileStaleRunningStatus();
      }
    }

    // Send "Waking up" boot message from the webhook route (before workflow)
    // so the user gets immediate feedback. The message ID is passed to the
    // workflow so the step can edit/delete it during processing.
    let bootMessageId: number | null = null;
    const chatId = extractTelegramChatId(payload);
    if (effectiveMeta.status !== "running" && chatId) {
      try {
        const result = await sendMessage(config.botToken, Number(chatId), "🦞 Waking up\u2026 one moment.");
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
      await telegramWebhookWorkflowRuntime.start(drainChannelWorkflow, ["telegram", payload, origin, requestId ?? null, bootMessageId, receivedAtMs]);
      logInfo("channels.telegram_workflow_started", withOperationContext(op));
    } catch (error) {
      const dedupRelease = await releaseTelegramWebhookDedupLockForRetry(dedupLock);
      logWarn("channels.telegram_workflow_start_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        attemptedAction: "start_drain_channel_workflow",
        dedupLockKey: dedupLock?.key ?? null,
        dedupLockReleaseAttempted: dedupRelease.attempted,
        dedupLockReleased: dedupRelease.released,
        dedupLockReleaseError: dedupRelease.releaseError,
        retryable: true,
      }));
      return workflowStartFailedResponse();
    }

    return Response.json({ ok: true });
  } catch (error) {
    const dedupRelease = await releaseTelegramWebhookDedupLockForRetry(dedupLock);
    logError("channels.telegram_webhook_unexpected_failure", {
      requestId: requestId ?? null,
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return workflowStartFailedResponse();
  }
}
