import { after } from "next/server";
import * as workflowApi from "workflow/api";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
  type ChannelDedupLock,
} from "@/server/channels/dedup";
import { recordChannelDlqFailure } from "@/server/channels/dlq";
import { refreshChannelFastPathGatewayToken } from "@/server/channels/fast-path-token";
import { recordChannelLastForward } from "@/server/channels/last-forward";
import {
  classifyFastPathException,
  classifyFastPathHttpResult,
  type FastPathClassifierPolicy,
} from "@/server/channels/core/fast-path-classifier";
import {
  FastPathOutcomeKind,
  FastPathSkipReason,
  type FastPathOutcome,
} from "@/server/channels/core/outcomes";
import { planWebhookAfterFastPath } from "@/server/channels/core/webhook-planner";
import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import {
  extractTelegramChatId,
  extractTelegramThreadId,
  isTelegramWebhookSecretValid,
} from "@/server/channels/telegram/adapter";
import { deleteMessage, sendMessage } from "@/server/channels/telegram/bot-api";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { OPENCLAW_TELEGRAM_WEBHOOK_PORT } from "@/server/openclaw/config";
import { getSandboxDomain, markSandboxPortUrlStale, reconcileStaleRunningStatus } from "@/server/sandbox/lifecycle";

// The fast path awaits the native handler's full turn (including long
// AI work like image generation). This timeout guards against wedged
// TCP connections to the sandbox, not against legitimately long turns.
const TELEGRAM_FAST_PATH_FORWARD_TIMEOUT_MS = 10 * 60 * 1000;
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";
import { getInitializedMeta, getStore } from "@/server/store/store";

const TELEGRAM_FAST_PATH_POLICY: FastPathClassifierPolicy = {
  channel: "telegram",
  nativeResponsePolicy: "non-ok-starts-workflow",
  classifySuspiciousEmpty200: true,
  stalePortOnSandboxNotListening: OPENCLAW_TELEGRAM_WEBHOOK_PORT,
};

type TelegramWebhookDedupLock = ChannelDedupLock;

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
    const threadId = extractTelegramThreadId(payload);
    if (updateId) {
      const dedupKey = channelDedupKey("telegram", updateId);
      const dedupResult = await tryAcquireChannelDedupLock({
        channel: "telegram",
        key: dedupKey,
        ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
        requestId: requestId ?? null,
        dedupId: updateId,
      });
      if (dedupResult.kind === "duplicate") {
        return Response.json({ ok: true });
      }
      if (dedupResult.kind === "acquired") {
        dedupLock = dedupResult.lock;
      }
      // degraded: no lock, but continue — webhook must not die on a
      // Redis blip.
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
    let fastPathOutcome: FastPathOutcome | null = null;
    // The fast path should use the live 8787 surface whenever the wrapper
    // believes the sandbox is running. Restore metrics can be absent on fresh
    // creates or stale after recovery, so they are logged as evidence but do
    // not gate warm delivery. If 8787 is actually not ready, the forward below
    // records the concrete failure and falls through to the workflow path.
    const telegramListenerReady =
      effectiveMeta.lastRestoreMetrics?.telegramListenerReady === true;
    const telegramListenerReadinessState = effectiveMeta.lastRestoreMetrics
      ? telegramListenerReady
        ? "verified"
        : "not-ready"
      : "unverified";
    if (effectiveMeta.status === "running" && effectiveMeta.sandboxId) {
      let portUrlStaleMarked = false;
      let fastPathSandboxWebhookUrl: string | null = null;
      const fastPathStartedAt = Date.now();
      const fastPathUpdateIdForRecord = extractUpdateId(payload);
      const fastPathDeliveryIdForRecord = fastPathUpdateIdForRecord
        ? `telegram:${fastPathUpdateIdForRecord}`
        : null;
      try {
        const sandboxWebhookUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
        fastPathSandboxWebhookUrl = sandboxWebhookUrl;
        const forwardUrl = `${sandboxWebhookUrl}/telegram-webhook`;
        logInfo("channels.telegram_fast_path_forwarding", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          forwardUrl,
          telegramListenerReady,
          telegramListenerReadinessState,
          hasPort8787Url: Boolean(effectiveMeta.portUrls?.[String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)]),
        }));
        await refreshChannelFastPathGatewayToken({
          channel: "telegram",
          requestId: requestId ?? null,
          sandboxId: effectiveMeta.sandboxId,
          op,
        });
        const fastPathHeaders: Record<string, string> = {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secretHeader,
        };
        const fastPathUpdateId = fastPathUpdateIdForRecord;
        if (fastPathUpdateId) {
          fastPathHeaders["x-openclaw-delivery-id"] = `telegram:${fastPathUpdateId}`;
        }
        const forwardStartedAt = Date.now();
        const forwardResponse = await fetch(forwardUrl, {
          method: "POST",
          headers: fastPathHeaders,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TELEGRAM_FAST_PATH_FORWARD_TIMEOUT_MS),
        });
        const forwardBody = await forwardResponse.text().catch(() => "");
        const forwardHeaders = pickDiagnosticHeaders(forwardResponse.headers);
        const forwardDurationMs = Date.now() - forwardStartedAt;
        const fastPathDurationMs = Date.now() - fastPathStartedAt;
        fastPathOutcome = classifyFastPathHttpResult({
          policy: TELEGRAM_FAST_PATH_POLICY,
          status: forwardResponse.status,
          ok: forwardResponse.ok,
          bodyHead: forwardBody.slice(0, 200),
          bodyLength: forwardBody.length,
          durationMs: forwardDurationMs,
          transport: "public",
          sandboxUrl: sandboxWebhookUrl,
          sandboxId: effectiveMeta.sandboxId ?? null,
        });
        if (fastPathOutcome.kind === FastPathOutcomeKind.Accepted) {
          const acceptedRoutePlan = planWebhookAfterFastPath({
            channel: "telegram",
            fastPath: fastPathOutcome,
            effectiveStatus: effectiveMeta.status,
            canSendUserNotice: Boolean(chatId),
            policy: { noticeOnWorkflowStart: true },
          });
          logInfo("channels.telegram_webhook_plan", withOperationContext(op, {
            routeOutcome: acceptedRoutePlan.routeOutcome,
            workflowKind: acceptedRoutePlan.workflow.kind,
            workflowReason: acceptedRoutePlan.workflow.kind === "start"
              ? acceptedRoutePlan.workflow.reason
              : null,
            userNoticeKind: acceptedRoutePlan.userNotice.kind,
            userNoticeReason: acceptedRoutePlan.userNotice.reason,
            fastPathKind: acceptedRoutePlan.fastPath?.kind ?? null,
            fastPathReason: acceptedRoutePlan.fastPath && "reason" in acceptedRoutePlan.fastPath
              ? acceptedRoutePlan.fastPath.reason
              : null,
            fastPathClassification: acceptedRoutePlan.fastPath && "classification" in acceptedRoutePlan.fastPath
              ? acceptedRoutePlan.fastPath.classification
              : null,
            effectiveStatus: effectiveMeta.status,
            effectiveSandboxId: effectiveMeta.sandboxId ?? null,
            fastPathFellBackToWorkflow: false,
          }));
          await recordChannelLastForward("telegram", {
            ok: true,
            status: fastPathOutcome.status,
            classification: fastPathOutcome.classification,
            attempts: 1,
            totalMs: fastPathDurationMs,
            transport: fastPathOutcome.transport,
            sandboxUrl: fastPathOutcome.sandboxUrl,
            sandboxId: fastPathOutcome.sandboxId,
            finalReasonHead: fastPathOutcome.bodyHead,
            startedAt: fastPathStartedAt,
            completedAt: Date.now(),
            deliveryId: `telegram:${fastPathUpdateId ?? "?"}`,
          });
          logInfo("channels.telegram_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            forwardUrl,
            status: forwardResponse.status,
            durationMs: fastPathDurationMs,
            forwardDurationMs,
            bodyLength: forwardBody.length,
            bodyHead: forwardBody.slice(0, 200),
            responseHeaders: forwardHeaders,
            suspiciousEmpty200: false,
          }));
          return Response.json({ ok: true });
        }
        if (fastPathOutcome.kind !== FastPathOutcomeKind.FallbackToWorkflow) {
          logWarn("channels.telegram_fast_path_unexpected_outcome", withOperationContext(op, {
            fastPathKind: fastPathOutcome.kind,
            fastPathReason: "reason" in fastPathOutcome ? fastPathOutcome.reason : null,
            status: forwardResponse.status,
            sandboxId: effectiveMeta.sandboxId,
            forwardUrl,
            action: "start_drain_channel_workflow",
          }));
          fastPathOutcome = {
            kind: FastPathOutcomeKind.FallbackToWorkflow,
            reason: "handler-error-policy-start-workflow",
            classification: "handler-error",
            status: forwardResponse.status,
            transport: "public",
            sandboxUrl: sandboxWebhookUrl,
            sandboxId: effectiveMeta.sandboxId ?? null,
            bodyHead: forwardBody.slice(0, 200),
            durationMs: forwardDurationMs,
            shouldReconcile: false,
          };
        }

        // Fast path did not genuinely deliver. Fall through to the workflow
        // wake path so Telegram is not silently dropped. Distinguish gateway
        // errors (502/503/504, sandbox unreachable) from suspicious-empty-200
        // and other non-OK results for log triage.
        const telegramFallbackReason =
          fastPathOutcome.reason === "suspicious-empty-200"
            ? "suspicious_empty_200"
            : fastPathOutcome.reason === "sandbox-not-listening" ||
                fastPathOutcome.reason === "proxy-error"
              ? "gateway_error"
              : "non_ok";
        logWarn(
          telegramFallbackReason === "gateway_error"
            ? "channels.telegram_fast_path_gateway_error"
            : "channels.telegram_fast_path_fallback_to_workflow",
          withOperationContext(op, {
            reason: telegramFallbackReason,
            fastPathKind: fastPathOutcome.kind,
            fastPathReason: fastPathOutcome.reason,
            classification: fastPathOutcome.classification,
            status: fastPathOutcome.status,
            sandboxId: effectiveMeta.sandboxId,
            forwardUrl,
            durationMs: fastPathDurationMs,
            forwardDurationMs: fastPathOutcome.durationMs,
            bodyLength: forwardBody.length,
            bodyHead: fastPathOutcome.bodyHead,
            responseHeaders: forwardHeaders,
            action:
              telegramFallbackReason === "gateway_error"
                ? "reconcile_and_wake"
                : "start_drain_channel_workflow",
          }),
        );
        await recordChannelLastForward("telegram", {
          ok: false,
          status: fastPathOutcome.status,
          classification: fastPathOutcome.classification,
          attempts: 1,
          totalMs: fastPathDurationMs,
          transport: fastPathOutcome.transport,
          sandboxUrl: fastPathOutcome.sandboxUrl,
          sandboxId: fastPathOutcome.sandboxId,
          finalReasonHead: fastPathOutcome.bodyHead,
          startedAt: fastPathStartedAt,
          completedAt: Date.now(),
          deliveryId: fastPathDeliveryIdForRecord,
        });
        if (fastPathOutcome.stalePort && !portUrlStaleMarked) {
          portUrlStaleMarked = true;
          try {
            const staleResult = await markSandboxPortUrlStale(
              effectiveMeta.sandboxId ?? null,
              fastPathOutcome.stalePort,
              fastPathOutcome.stalePortReason ?? "fast-path-not-listening",
            );
            logWarn("channels.telegram_fast_path_dead_port_recorded", withOperationContext(op, {
              sandboxId: effectiveMeta.sandboxId,
              previousSandboxId: meta.sandboxId,
              staleOldUrl: staleResult.oldUrl,
              staleNewUrl: staleResult.newUrl,
              staleRefreshed: staleResult.refreshed,
              metaStatus: effectiveMeta.status,
              action: "start_drain_channel_workflow",
            }));
          } catch (err) {
            logWarn("channels.telegram_fast_path_port_url_refresh_failed", withOperationContext(op, {
              error: err instanceof Error ? err.message : String(err),
              sandboxId: effectiveMeta.sandboxId,
            }));
          }
        }
        if (fastPathOutcome.shouldReconcile) {
          const staleMeta = effectiveMeta;
          effectiveMeta = await reconcileStaleRunningStatus();
          logInfo("channels.telegram_fast_path_reconciled", withOperationContext(op, {
            previousStatus: staleMeta.status,
            previousSandboxId: staleMeta.sandboxId,
            reconciledStatus: effectiveMeta.status,
            reconciledSandboxId: effectiveMeta.sandboxId,
          }));
        }
      } catch (error) {
        // Network-level failure or AbortSignal timeout — sandbox may or
        // may not have received the payload. Reconcile stale status and
        // fall through to the workflow wake path so the message is not
        // lost. TimeoutError indicates the TCP connection wedged for
        // longer than the fast-path budget.
        const isAbort =
          error instanceof Error && error.name === "TimeoutError";
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        fastPathOutcome = classifyFastPathException({
          policy: TELEGRAM_FAST_PATH_POLICY,
          error,
          durationMs: Date.now() - fastPathStartedAt,
          transport: "public",
          sandboxUrl: fastPathSandboxWebhookUrl,
          sandboxId: effectiveMeta.sandboxId ?? null,
        });
        logWarn("channels.telegram_fast_path_failed", withOperationContext(op, {
          error: errorMessage,
          errorName: error instanceof Error ? error.name : undefined,
          sandboxId: effectiveMeta.sandboxId,
          action: "reconcile_and_wake",
          reason: fastPathOutcome.reason,
          fastPathKind: fastPathOutcome.kind,
          classification: fastPathOutcome.classification,
          indeterminateDelivery: fastPathOutcome.indeterminateDelivery === true,
          fastPathTimeoutMs: isAbort
            ? TELEGRAM_FAST_PATH_FORWARD_TIMEOUT_MS
            : null,
        }));
        await recordChannelLastForward("telegram", {
          ok: false,
          status: fastPathOutcome.status,
          classification: fastPathOutcome.classification,
          attempts: 1,
          totalMs: fastPathOutcome.durationMs,
          transport: fastPathOutcome.transport,
          sandboxUrl: fastPathOutcome.sandboxUrl,
          sandboxId: fastPathOutcome.sandboxId,
          finalReasonHead: fastPathOutcome.bodyHead,
          startedAt: fastPathStartedAt,
          completedAt: Date.now(),
          deliveryId: fastPathDeliveryIdForRecord,
        });
        const staleMeta = effectiveMeta;
        effectiveMeta = await reconcileStaleRunningStatus();
        logInfo("channels.telegram_fast_path_reconciled", withOperationContext(op, {
          previousStatus: staleMeta.status,
          previousSandboxId: staleMeta.sandboxId,
          reconciledStatus: effectiveMeta.status,
          reconciledSandboxId: effectiveMeta.sandboxId,
        }));
        // suppress unused-var lint for sandbox URL when fetch never returned
        void fastPathSandboxWebhookUrl;
      }
    } else {
      fastPathOutcome = {
        kind: FastPathOutcomeKind.NotAttempted,
        reason:
          effectiveMeta.status !== "running"
            ? FastPathSkipReason.SandboxStatusNotRunning
            : FastPathSkipReason.MissingSandboxId,
        initialStatus: effectiveMeta.status,
        sandboxId: effectiveMeta.sandboxId ?? null,
      };
      logInfo("channels.telegram_fast_path_skipped", withOperationContext(op, {
        reason:
          effectiveMeta.status !== "running"
            ? `sandbox_status_${effectiveMeta.status}`
            : "no_sandbox_id",
        status: effectiveMeta.status,
        sandboxId: effectiveMeta.sandboxId,
        telegramListenerReady,
      }));
    }

    const routePlan = planWebhookAfterFastPath({
      channel: "telegram",
      fastPath: fastPathOutcome ?? {
        kind: FastPathOutcomeKind.NotAttempted,
        reason: FastPathSkipReason.UnsupportedPayload,
        initialStatus: effectiveMeta.status,
        sandboxId: effectiveMeta.sandboxId ?? null,
      },
      effectiveStatus: effectiveMeta.status,
      canSendUserNotice: Boolean(chatId),
      policy: { noticeOnWorkflowStart: true },
    });
    const fastPathFellBackToWorkflow =
      routePlan.fastPath?.kind === FastPathOutcomeKind.FallbackToWorkflow;
    logInfo("channels.telegram_webhook_plan", withOperationContext(op, {
      routeOutcome: routePlan.routeOutcome,
      workflowKind: routePlan.workflow.kind,
      workflowReason: routePlan.workflow.kind === "start" ? routePlan.workflow.reason : null,
      userNoticeKind: routePlan.userNotice.kind,
      userNoticeReason: routePlan.userNotice.reason,
      fastPathKind: routePlan.fastPath?.kind ?? null,
      fastPathReason: routePlan.fastPath && "reason" in routePlan.fastPath
        ? routePlan.fastPath.reason
        : null,
      fastPathClassification: routePlan.fastPath && "classification" in routePlan.fastPath
        ? routePlan.fastPath.classification
        : null,
      effectiveStatus: effectiveMeta.status,
      effectiveSandboxId: effectiveMeta.sandboxId ?? null,
      fastPathFellBackToWorkflow,
    }));

    if (routePlan.workflow.kind !== "start") {
      return Response.json({ ok: true });
    }

    // Send "Waking up" boot message from the webhook route (before workflow)
    // so the user gets immediate feedback. The message ID is passed to the
    // workflow so the step can edit/delete it during processing.
    let bootMessageId: number | null = null;
    if (routePlan.userNotice.kind === "send-before-workflow" && chatId) {
      try {
        const result = await sendMessage(
          config.botToken,
          Number(chatId),
          "🦞 Waking up\u2026 one moment.",
          threadId !== null ? { messageThreadId: threadId } : undefined,
        );
        bootMessageId = result.message_id;
        logInfo("channels.telegram_boot_message_sent", withOperationContext(op, {
          chatId,
          bootMessageId,
          effectiveStatus: effectiveMeta.status,
          userNoticeReason: routePlan.userNotice.reason,
          workflowReason: routePlan.workflow.reason,
          fastPathFellBackToWorkflow,
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
          userNoticeReason: routePlan.userNotice.reason,
          workflowReason: routePlan.workflow.reason,
          fastPathFellBackToWorkflow,
          sandboxId: effectiveMeta.sandboxId ?? null,
          outcome: "accepted",
        });
      } catch (err) {
        logWarn("channels.telegram_boot_message_failed", withOperationContext(op, {
          chatId,
          effectiveStatus: effectiveMeta.status,
          userNoticeReason: routePlan.userNotice.reason,
          workflowReason: routePlan.workflow.reason,
          fastPathFellBackToWorkflow,
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
          userNoticeReason: routePlan.userNotice.reason,
          workflowReason: routePlan.workflow.reason,
          fastPathFellBackToWorkflow,
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
        workflowReason: routePlan.workflow.reason,
        userNoticeKind: routePlan.userNotice.kind,
        userNoticeReason: routePlan.userNotice.reason,
        handoffDelayMs: Date.now() - receivedAtMs,
      }));
      await telegramWebhookWorkflowRuntime.start(drainChannelWorkflow, [
        {
          version: 1,
          channel: "telegram",
          payload,
          origin,
          requestId: requestId ?? null,
          bootMessageId,
          receivedAtMs,
          workflowHandoff: { fallbackTelegramConfig: config },
        },
      ]);
      logInfo("channels.telegram_workflow_started", withOperationContext(op, {
        effectiveStatus: effectiveMeta.status,
        effectiveSandboxId: effectiveMeta.sandboxId,
        bootMessageId,
        workflowReason: routePlan.workflow.reason,
        userNoticeKind: routePlan.userNotice.kind,
        userNoticeReason: routePlan.userNotice.reason,
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
        workflowReason: routePlan.workflow.reason,
        userNoticeKind: routePlan.userNotice.kind,
        userNoticeReason: routePlan.userNotice.reason,
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
      const tgDeliveryId = updateId
        ? `telegram:${updateId}`
        : `telegram:request:${requestId ?? receivedAtMs}`;
      await recordChannelDlqFailure({
        channel: "telegram",
        deliveryId: tgDeliveryId,
        phase: "workflow-start-failed",
        terminal: false,
        retryable: true,
        requestId: requestId ?? null,
        receivedAtMs,
        error,
        diag: {
          updateId,
          chatId,
          bootMessageId,
          dedupLockReleased: dedupRelease.released,
        },
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
