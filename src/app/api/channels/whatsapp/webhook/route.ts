import * as workflowApi from "workflow/api";

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

type WhatsAppWebhookDedupLock = {
  key: string;
  token: string;
};

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
      const dedupToken = await getStore().acquireLock(dedupKey, 24 * 60 * 60);
      if (!dedupToken) {
        return Response.json({ ok: true });
      }
      dedupLock = { key: dedupKey, token: dedupToken };
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
      const forwardHeaders: Record<string, string> = {};
      for (const headerName of WHATSAPP_FORWARD_HEADERS) {
        const headerValue = request.headers.get(headerName);
        if (headerValue) {
          forwardHeaders[headerName] = headerValue;
        }
      }

      try {
        const sandboxUrl = await getSandboxDomain();
        const forwardResponse = await fetch(`${sandboxUrl}/whatsapp-webhook`, {
          method: "POST",
          headers: forwardHeaders,
          body: rawBody,
        });
        if (forwardResponse.ok) {
          logInfo("channels.whatsapp_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
          }));
        } else {
          logWarn("channels.whatsapp_fast_path_non_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            status: forwardResponse.status,
          }));
        }
        // Any HTTP response means the native handler received the payload.
        // Return 200 to avoid duplicate delivery via the workflow path.
        return Response.json({ ok: true });
      } catch (error) {
        // Network-level failure — native handler never received the payload.
        // Reconcile stale status and fall through to workflow wake path.
        logWarn("channels.whatsapp_fast_path_failed", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          error: error instanceof Error ? error.message : String(error),
          action: "reconcile_and_wake",
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
        "whatsapp",
        payload,
        origin,
        requestId ?? null,
        bootMessageId,
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
