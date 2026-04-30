import * as workflowApi from "workflow/api";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
  type ChannelDedupLock,
} from "@/server/channels/dedup";
import { recordChannelDlqFailure } from "@/server/channels/dlq";
import { refreshChannelFastPathGatewayToken } from "@/server/channels/fast-path-token";
import { hasWhatsAppBusinessCredentials } from "@/shared/channels";
import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { createWhatsAppAdapter, extractWhatsAppMessageId, isWhatsAppSignatureValid } from "@/server/channels/whatsapp/adapter";
import { sendMessage } from "@/server/channels/whatsapp/whatsapp-api";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getSandboxDomain, reconcileStaleRunningStatus } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";
const WHATSAPP_FORWARD_HEADERS = [
  "x-hub-signature-256",
  "content-type",
] as const;
// The fast path awaits the native handler's full turn (long AI work
// like image generation). Guard against wedged TCP connections only.
const WHATSAPP_FAST_PATH_FORWARD_TIMEOUT_MS = 10 * 60 * 1000;

type WhatsAppWebhookDedupLock = ChannelDedupLock;

type WhatsAppWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const whatsappWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseWhatsAppWebhookDedupLockForRetry(
  lock: WhatsAppWebhookDedupLock | null,
): Promise<WhatsAppWebhookDedupReleaseResult> {
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

function extractChallenge(url: URL): {
  mode: string | null;
  token: string | null;
  challenge: string | null;
} {
  return {
    mode: url.searchParams.get("hub.mode"),
    token: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
  };
}

export async function GET(request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  const config = meta.channels.whatsapp;
  if (!hasWhatsAppBusinessCredentials(config)) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const { mode, token, challenge } = extractChallenge(new URL(request.url));
  if (mode === "subscribe" && token === config.verifyToken && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return unauthorizedResponse();
}

export async function POST(request: Request): Promise<Response> {
  const receivedAtMs = Date.now();
  const requestId = extractRequestId(request);
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const meta = await getInitializedMeta();
  const config = meta.channels.whatsapp;
  if (!hasWhatsAppBusinessCredentials(config)) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  if (!isWhatsAppSignatureValid(config.appSecret, rawBody, signatureHeader)) {
    logWarn("channels.whatsapp_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      hasSignature: Boolean(signatureHeader),
      bodyLength: rawBody.length,
    });
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    logWarn("channels.whatsapp_webhook_rejected", {
      reason: "invalid_json",
      requestId,
      bodyLength: rawBody.length,
    });
    return Response.json({ ok: true });
  }

  let dedupLock: WhatsAppWebhookDedupLock | null = null;
  try {
    const messageId = extractWhatsAppMessageId(payload);
    if (messageId) {
      const dedupKey = channelDedupKey("whatsapp", messageId);
      const dedupResult = await tryAcquireChannelDedupLock({
        channel: "whatsapp",
        key: dedupKey,
        ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
        requestId: requestId ?? null,
        dedupId: messageId,
      });
      if (dedupResult.kind === "duplicate") {
        return Response.json({ ok: true });
      }
      if (dedupResult.kind === "acquired") {
        dedupLock = dedupResult.lock;
      }
      // degraded: continue without lock.
    }

    const op = createOperationContext({
      trigger: "channel.whatsapp.webhook",
      reason: "incoming whatsapp webhook",
      requestId: requestId ?? null,
      channel: "whatsapp",
      dedupId: messageId ?? null,
      sandboxId: meta.sandboxId ?? null,
      snapshotId: meta.snapshotId ?? null,
      status: meta.status,
    });

    logInfo("channels.whatsapp_webhook_accepted", withOperationContext(op, {
      bodyLength: rawBody.length,
      hasMessageId: Boolean(messageId),
    }));

    // --- Fast path: forward to OpenClaw's native WhatsApp handler ---
    // When the sandbox is running, delegate entirely to the native handler.
    // Await the response so the native handler can complete its full
    // processing cycle (including long AI tasks like image generation).
    // Fluid Compute bills only for CPU cycles, not idle wait time.
    //
    // Return 200 when the native handler succeeds, or when it returns a
    // non-gateway HTTP error that proves the handler received the payload.
    // Gateway-level 502/503/504 responses and network failures mean the
    // sandbox process may be unreachable, so reconcile and fall through to the
    // workflow wake path.
    let effectiveMeta = meta;
    if (effectiveMeta.status === "running" && effectiveMeta.sandboxId) {
      const forwardHeaders: Record<string, string> = {};
      for (const headerName of WHATSAPP_FORWARD_HEADERS) {
        const headerValue = request.headers.get(headerName);
        if (headerValue) {
          forwardHeaders[headerName] = headerValue;
        }
      }
      const messageIdForForward = extractWhatsAppMessageId(payload);
      const fastPathDeliveryId = messageIdForForward
        ? `whatsapp:${messageIdForForward}`
        : null;
      if (fastPathDeliveryId) {
        forwardHeaders["x-openclaw-delivery-id"] = fastPathDeliveryId;
      }

      try {
        const sandboxUrl = await getSandboxDomain();
        await refreshChannelFastPathGatewayToken({
          channel: "whatsapp",
          requestId: requestId ?? null,
          sandboxId: effectiveMeta.sandboxId,
          op,
        });
        const forwardResponse = await fetch(`${sandboxUrl}/whatsapp-webhook`, {
          method: "POST",
          headers: forwardHeaders,
          body: rawBody,
          signal: AbortSignal.timeout(WHATSAPP_FAST_PATH_FORWARD_TIMEOUT_MS),
        });
        if (forwardResponse.ok) {
          logInfo("channels.whatsapp_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            deliveryId: fastPathDeliveryId,
          }));
          return Response.json({ ok: true });
        }

        if (forwardResponse.status === 502 || forwardResponse.status === 503 || forwardResponse.status === 504) {
          logWarn("channels.whatsapp_fast_path_gateway_error", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            status: forwardResponse.status,
            action: "reconcile_and_wake",
          }));
          effectiveMeta = await reconcileStaleRunningStatus();
        } else {
          logWarn("channels.whatsapp_fast_path_non_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            status: forwardResponse.status,
          }));
          return Response.json({ ok: true });
        }
      } catch (error) {
        // Network-level failure or AbortSignal timeout — sandbox may or
        // may not have received the payload. Reconcile stale status and
        // fall through to workflow wake path.
        const isAbort =
          error instanceof Error && error.name === "TimeoutError";
        logWarn("channels.whatsapp_fast_path_failed", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
          action: "reconcile_and_wake",
          reason: isAbort ? "fast_path_forward_timeout" : "network_error",
          indeterminateDelivery: isAbort,
          fastPathTimeoutMs: isAbort
            ? WHATSAPP_FAST_PATH_FORWARD_TIMEOUT_MS
            : null,
        }));
        effectiveMeta = await reconcileStaleRunningStatus();
      }
    }

    let bootMessageId: string | null = null;
    if (effectiveMeta.status !== "running") {
      try {
        const adapter = createWhatsAppAdapter(config);
        const extracted = await adapter.extractMessage(payload);
        if (extracted.kind === "message") {
          const result = await sendMessage(
            config.accessToken,
            config.phoneNumberId,
            extracted.message.from,
            "🦞 Waking up\u2026 one moment.",
          );
          bootMessageId = result.id;
          logInfo("channels.whatsapp_boot_message_sent", withOperationContext(op, {
            bootMessageId,
            to: extracted.message.from,
          }));
        }
      } catch (error) {
        logWarn("channels.whatsapp_boot_message_failed", withOperationContext(op, {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    try {
      const origin = getPublicOrigin(request);
      await whatsappWebhookWorkflowRuntime.start(drainChannelWorkflow, [
        {
          version: 1,
          channel: "whatsapp",
          payload,
          origin,
          requestId: requestId ?? null,
          bootMessageId,
          receivedAtMs,
        },
      ]);
      logInfo("channels.whatsapp_workflow_started", withOperationContext(op));
    } catch (error) {
      const dedupRelease = await releaseWhatsAppWebhookDedupLockForRetry(dedupLock);
      logWarn("channels.whatsapp_workflow_start_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        attemptedAction: "start_drain_channel_workflow",
        dedupLockKey: dedupLock?.key ?? null,
        dedupLockReleaseAttempted: dedupRelease.attempted,
        dedupLockReleased: dedupRelease.released,
        dedupLockReleaseError: dedupRelease.releaseError,
        retryable: true,
      }));
      const whatsappMessageId = extractWhatsAppMessageId(payload);
      const waDeliveryId = whatsappMessageId
        ? `whatsapp:${whatsappMessageId}`
        : `whatsapp:request:${requestId ?? receivedAtMs}`;
      await recordChannelDlqFailure({
        channel: "whatsapp",
        deliveryId: waDeliveryId,
        phase: "workflow-start-failed",
        terminal: false,
        retryable: true,
        requestId: requestId ?? null,
        receivedAtMs,
        error,
        diag: {
          whatsappMessageId,
          bootMessageId,
          dedupLockReleased: dedupRelease.released,
        },
      });
      return workflowStartFailedResponse();
    }

    return Response.json({ ok: true });
  } catch (error) {
    const dedupRelease = await releaseWhatsAppWebhookDedupLockForRetry(dedupLock);
    logError("channels.whatsapp_webhook_unexpected_failure", {
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
