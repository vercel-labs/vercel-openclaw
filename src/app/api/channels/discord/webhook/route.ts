import * as workflowApi from "workflow/api";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
  type ChannelDedupLock,
} from "@/server/channels/dedup";
import { recordChannelDlqFailure } from "@/server/channels/dlq";
import { getPublicOrigin } from "@/server/public-url";
import { verifyDiscordRequestSignature } from "@/server/channels/discord/adapter";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getInitializedMeta, getStore } from "@/server/store/store";

type DiscordWebhookDedupLock = ChannelDedupLock;

type DiscordWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const discordWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function extractInteractionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { id?: unknown };
  if (typeof raw.id === "string" && raw.id.length > 0) {
    return raw.id;
  }

  return null;
}

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseDiscordWebhookDedupLockForRetry(
  lock: DiscordWebhookDedupLock | null,
): Promise<DiscordWebhookDedupReleaseResult> {
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
  const config = meta.channels.discord;
  if (!config) {
    return Response.json(
      { error: "DISCORD_NOT_CONFIGURED", message: "Discord is not configured." },
      { status: 409 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  if (!verifyDiscordRequestSignature(rawBody, signature, timestamp, config.publicKey)) {
    return Response.json(
      { error: "DISCORD_SIGNATURE_INVALID", message: "Invalid Discord request signature." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { error: "INVALID_JSON_BODY", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if ((payload as { type?: unknown }).type === 1) {
    return Response.json({ type: 1 });
  }

  const interactionId = extractInteractionId(payload);
  let dedupLock: DiscordWebhookDedupLock | null = null;
  if (interactionId) {
    const dedupKey = channelDedupKey("discord", interactionId);
    const dedupResult = await tryAcquireChannelDedupLock({
      channel: "discord",
      key: dedupKey,
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: requestId ?? null,
      dedupId: interactionId,
    });
    if (dedupResult.kind === "duplicate") {
      return Response.json({ type: 5 });
    }
    if (dedupResult.kind === "acquired") {
      dedupLock = dedupResult.lock;
    }
    // degraded: continue without dedup. The degraded log comes from the
    // helper; we still return type:5 (deferred) and let the workflow run.
  }

  const op = createOperationContext({
    trigger: "channel.discord.webhook",
    reason: "incoming discord webhook",
    requestId: requestId ?? null,
    channel: "discord",
    dedupId: interactionId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  logInfo("channels.discord_webhook_accepted", withOperationContext(op));

  try {
    const origin = getPublicOrigin(request);
    await discordWebhookWorkflowRuntime.start(drainChannelWorkflow, [
      {
        version: 1,
        channel: "discord",
        payload,
        origin,
        requestId: requestId ?? null,
        receivedAtMs,
      },
    ]);
    logInfo("channels.discord_workflow_started", withOperationContext(op));
  } catch (error) {
    const dedupRelease = await releaseDiscordWebhookDedupLockForRetry(dedupLock);
    logWarn("channels.discord_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      attemptedAction: "start_drain_channel_workflow",
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      retryable: true,
    }));
    const discordDeliveryId = interactionId
      ? `discord:${interactionId}`
      : `discord:request:${requestId ?? receivedAtMs}`;
    await recordChannelDlqFailure({
      channel: "discord",
      deliveryId: discordDeliveryId,
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      requestId: requestId ?? null,
      receivedAtMs,
      error,
      diag: {
        interactionId,
        dedupLockReleased: dedupRelease.released,
      },
    });
    return workflowStartFailedResponse();
  }

  return Response.json({ type: 5 });
}
