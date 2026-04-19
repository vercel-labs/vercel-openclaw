import { after } from "next/server";
import * as workflowApi from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractTelegramChatId, isTelegramWebhookSecretValid } from "@/server/channels/telegram/adapter";
import { deleteMessage, sendMessage } from "@/server/channels/telegram/bot-api";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { OPENCLAW_TELEGRAM_WEBHOOK_PORT } from "@/server/openclaw/config";
import { ensureFreshGatewayToken, getSandboxDomain, reconcileStaleRunningStatus } from "@/server/sandbox/lifecycle";
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";
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

type DiagnosticHeaders = {
  server?: string | null;
  contentType?: string | null;
  contentLength?: string | null;
  xPoweredBy?: string | null;
  via?: string | null;
  cacheControl?: string | null;
};

function pickDiagnosticHeaders(headers: Headers): DiagnosticHeaders {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
  };
}

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

async function persistWebhookDiagnostic(
  value: Record<string, unknown>,
): Promise<void> {
  try {
    await getStore().setValue(channelForwardDiagnosticKey(), value, 3600);
  } catch {
    // Best effort only. Diagnostics must never block webhook handling.
  }
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
    const chatId = extractTelegramChatId(payload);
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

    logInfo("channels.telegram_webhook_accepted", withOperationContext(op, {
      chatId,
      receivedAtMs,
      receivedToAcceptedMs: Date.now() - receivedAtMs,
      metaStatus: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
      hasPort3000Url: Boolean(meta.portUrls?.["3000"]),
      hasPort8787Url: Boolean(meta.portUrls?.[String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)]),
      payloadKeys: payload && typeof payload === "object"
        ? Object.keys(payload as Record<string, unknown>).slice(0, 12)
        : [],
    }));
    await persistWebhookDiagnostic({
      phase: "webhook-accepted",
      phaseUpdatedAt: Date.now(),
      channel: "telegram",
      requestId,
      dedupId: updateId ?? null,
      chatId,
      receivedAtMs,
      acceptedAtMs: Date.now(),
      receivedToAcceptedMs: Date.now() - receivedAtMs,
      metaStatus: meta.status,
      sandboxId: meta.sandboxId ?? null,
      snapshotId: meta.snapshotId ?? null,
      hasPort3000Url: Boolean(meta.portUrls?.["3000"]),
      hasPort8787Url: Boolean(meta.portUrls?.[String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)]),
      outcome: "accepted",
    });

    // --- Fast path: forward to OpenClaw's native Telegram handler ---
    // When the sandbox is running, delegate entirely to the native handler on
    // port 8787.  Await the response so the native handler can complete its
    // full processing cycle (including long AI tasks like image generation).
    // Fluid Compute bills only for CPU cycles, not idle wait time.
    //
    // Return 200 only when the native handler genuinely accepted the payload:
    //   - forwardResponse.ok (2xx) AND NOT a "suspicious empty 200" (fast,
    //     empty body — indicates an intermediary swallowed it before reaching
    //     the native handler).
    // Otherwise fall through to the durable workflow. The native handler waits
    // for processing to complete, so a fast empty 200 is evidence the handler
    // was never reached. Non-2xx responses likewise indicate the payload did
    // not get processed, and Telegram will not retry a 200 from us, so a
    // silent drop is worse than the (low) risk of duplicate delivery through
    // the workflow path.
    let effectiveMeta = meta;
    // Gate the fast-path on BOTH status=running AND proof the Telegram handler
    // on port 8787 actually bound during the last restore.  Without this check,
    // the webhook races ahead while lifecycle.ts is still re-registering the
    // Telegram webhook and syncing the secret, causing early forwards to land
    // on a half-ready handler.  telegramListenerReady is set by the fast-restore
    // script (config.ts:~927) after it proves a local 401 on the 8787 route.
    const telegramListenerReady =
      effectiveMeta.lastRestoreMetrics?.telegramListenerReady === true;
    if (effectiveMeta.status === "running" && effectiveMeta.sandboxId && telegramListenerReady) {
      try {
        const sandboxWebhookUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
        const forwardUrl = `${sandboxWebhookUrl}/telegram-webhook`;
        const fastPathStartedAt = Date.now();
        const forwardResponse = await fetch(forwardUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secretHeader,
          },
          body: JSON.stringify(payload),
        });
        const forwardBody = await forwardResponse.text().catch(() => "");
        const forwardHeaders = pickDiagnosticHeaders(forwardResponse.headers);
        const fastPathDurationMs = Date.now() - fastPathStartedAt;
        const suspiciousEmpty200 =
          forwardResponse.status === 200 &&
          fastPathDurationMs < 150 &&
          forwardBody.length === 0;
        if (forwardResponse.ok && !suspiciousEmpty200) {
          logInfo("channels.telegram_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            forwardUrl,
            status: forwardResponse.status,
            durationMs: fastPathDurationMs,
            bodyLength: forwardBody.length,
            bodyHead: forwardBody.slice(0, 200),
            responseHeaders: forwardHeaders,
          }));
          return Response.json({ ok: true });
        }

        // Fast path did not genuinely deliver. Fall through to the workflow
        // wake path so Telegram is not silently dropped.
        logWarn("channels.telegram_fast_path_fallback_to_workflow", withOperationContext(op, {
          reason: suspiciousEmpty200 ? "suspicious_empty_200" : "non_ok",
          status: forwardResponse.status,
          sandboxId: effectiveMeta.sandboxId,
          forwardUrl,
          durationMs: fastPathDurationMs,
          bodyLength: forwardBody.length,
          bodyHead: forwardBody.slice(0, 200),
          responseHeaders: forwardHeaders,
          action: "start_drain_channel_workflow",
        }));
        const staleMeta = effectiveMeta;
        effectiveMeta = await reconcileStaleRunningStatus();
        logInfo("channels.telegram_fast_path_reconciled", withOperationContext(op, {
          previousStatus: staleMeta.status,
          previousSandboxId: staleMeta.sandboxId,
          reconciledStatus: effectiveMeta.status,
          reconciledSandboxId: effectiveMeta.sandboxId,
        }));
      } catch (error) {
        // Network-level failure — sandbox is unreachable, native handler never
        // got the payload.  Reconcile stale status and fall through to the
        // workflow wake path so the message is not lost.
        logWarn("channels.telegram_fast_path_failed", withOperationContext(op, {
          error: error instanceof Error ? error.message : String(error),
          sandboxId: effectiveMeta.sandboxId,
          action: "reconcile_and_wake",
        }));
        const staleMeta = effectiveMeta;
        effectiveMeta = await reconcileStaleRunningStatus();
        logInfo("channels.telegram_fast_path_reconciled", withOperationContext(op, {
          previousStatus: staleMeta.status,
          previousSandboxId: staleMeta.sandboxId,
          reconciledStatus: effectiveMeta.status,
          reconciledSandboxId: effectiveMeta.sandboxId,
        }));
      }
    }

    // Send "Waking up" boot message from the webhook route (before workflow)
    // so the user gets immediate feedback. The message ID is passed to the
    // workflow so the step can edit/delete it during processing.
    let bootMessageId: number | null = null;
    if (effectiveMeta.status !== "running" && chatId) {
      try {
        const result = await sendMessage(config.botToken, Number(chatId), "🦞 Waking up\u2026 one moment.");
        bootMessageId = result.message_id;
        logInfo("channels.telegram_boot_message_sent", withOperationContext(op, {
          chatId,
          bootMessageId,
          receivedToBootMessageMs: Date.now() - receivedAtMs,
        }));
        await persistWebhookDiagnostic({
          phase: "boot-message-sent",
          phaseUpdatedAt: Date.now(),
          channel: "telegram",
          requestId,
          dedupId: updateId ?? null,
          chatId,
          receivedAtMs,
          bootMessageId,
          effectiveStatus: effectiveMeta.status,
          sandboxId: effectiveMeta.sandboxId ?? null,
          outcome: "accepted",
        });
      } catch (err) {
        logWarn("channels.telegram_boot_message_failed", withOperationContext(op, {
          chatId,
          error: err instanceof Error ? err.message : String(err),
          receivedToBootMessageAttemptMs: Date.now() - receivedAtMs,
        }));
        await persistWebhookDiagnostic({
          phase: "boot-message-failed",
          phaseUpdatedAt: Date.now(),
          channel: "telegram",
          requestId,
          dedupId: updateId ?? null,
          chatId,
          receivedAtMs,
          effectiveStatus: effectiveMeta.status,
          sandboxId: effectiveMeta.sandboxId ?? null,
          error: err instanceof Error ? err.message : String(err),
          outcome: "accepted",
        });
      }
    }

    try {
      const origin = getPublicOrigin(request);
      logInfo("channels.telegram_workflow_starting", withOperationContext(op, {
        effectiveStatus: effectiveMeta.status,
        effectiveSandboxId: effectiveMeta.sandboxId,
        bootMessageId,
        handoffDelayMs: Date.now() - receivedAtMs,
      }));
      await telegramWebhookWorkflowRuntime.start(drainChannelWorkflow, [
        "telegram",
        payload,
        origin,
        requestId ?? null,
        bootMessageId,
        receivedAtMs,
        { fallbackTelegramConfig: config },
      ]);
      logInfo("channels.telegram_workflow_started", withOperationContext(op, {
        effectiveStatus: effectiveMeta.status,
        effectiveSandboxId: effectiveMeta.sandboxId,
        bootMessageId,
        handoffDelayMs: Date.now() - receivedAtMs,
      }));
      await persistWebhookDiagnostic({
        phase: "workflow-started",
        phaseUpdatedAt: Date.now(),
        channel: "telegram",
        requestId,
        dedupId: updateId ?? null,
        chatId,
        receivedAtMs,
        bootMessageId,
        effectiveStatus: effectiveMeta.status,
        sandboxId: effectiveMeta.sandboxId ?? null,
        handoffDelayMs: Date.now() - receivedAtMs,
        outcome: "workflow-started",
      });
    } catch (error) {
      // Best-effort clean up the boot message so the user doesn't see an orphan
      // message left over from a failed workflow start on Telegram's retry path.
      if (bootMessageId && chatId) {
        try {
          await deleteMessage(config.botToken, Number(chatId), bootMessageId);
        } catch {
          // Don't let cleanup failure block the error response.
        }
      }
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
      await persistWebhookDiagnostic({
        phase: "workflow-start-failed",
        phaseUpdatedAt: Date.now(),
        channel: "telegram",
        requestId,
        dedupId: updateId ?? null,
        chatId,
        receivedAtMs,
        bootMessageId,
        effectiveStatus: effectiveMeta.status,
        sandboxId: effectiveMeta.sandboxId ?? null,
        error: error instanceof Error ? error.message : String(error),
        dedupLockKey: dedupLock?.key ?? null,
        dedupLockReleaseAttempted: dedupRelease.attempted,
        dedupLockReleased: dedupRelease.released,
        dedupLockReleaseError: dedupRelease.releaseError,
        outcome: "workflow-start-failed",
      });
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
