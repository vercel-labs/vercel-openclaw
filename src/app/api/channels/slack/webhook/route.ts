import * as workflowApi from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import {
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getSandboxDomain, reconcileStaleRunningStatus } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_BOOT_MESSAGE_TIMEOUT_MS = 5_000;

const SLACK_FORWARD_HEADERS = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

type SlackWebhookDedupLock = {
  key: string;
  token: string;
};

type SlackWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const slackWebhookWorkflowRuntime = {
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

async function releaseSlackWebhookDedupLockForRetry(
  lock: SlackWebhookDedupLock | null,
): Promise<SlackWebhookDedupReleaseResult> {
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

function extractSlackEventInfo(payload: unknown): {
  eventType: string | null;
  eventSubtype: string | null;
  channel: string | null;
  user: string | null;
  text: string | null;
  threadTs: string | null;
  botId: string | null;
  payloadType: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { eventType: null, eventSubtype: null, channel: null, user: null, text: null, threadTs: null, botId: null, payloadType: null };
  }

  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  return {
    payloadType: typeof p.type === "string" ? p.type : null,
    eventType: typeof event?.type === "string" ? event.type : null,
    eventSubtype: typeof event?.subtype === "string" ? event.subtype : null,
    channel: typeof event?.channel === "string" ? event.channel : null,
    user: typeof event?.user === "string" ? event.user : null,
    text: typeof event?.text === "string" ? event.text.slice(0, 100) : null,
    threadTs: typeof event?.thread_ts === "string" ? event.thread_ts : null,
    botId: typeof event?.bot_id === "string" ? event.bot_id : null,
  };
}

function extractSlackDedupId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as {
    event_id?: unknown;
    event?: { channel?: unknown; ts?: unknown };
  };
  if (typeof raw.event_id === "string" && raw.event_id.length > 0) {
    return raw.event_id;
  }

  if (
    typeof raw.event?.channel === "string" &&
    typeof raw.event?.ts === "string"
  ) {
    return `${raw.event.channel}:${raw.event.ts}`;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const receivedAtMs = Date.now();
  const requestId = extractRequestId(request);
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-slack-signature");
  const timestampHeader = request.headers.get("x-slack-request-timestamp");
  const retryNum = request.headers.get("x-slack-retry-num");
  const retryReason = request.headers.get("x-slack-retry-reason");

  if (!signatureHeader || !timestampHeader) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "missing_signature_headers",
      hasSignature: Boolean(signatureHeader),
      hasTimestamp: Boolean(timestampHeader),
      requestId,
    });
    return unauthorizedResponse();
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.slack;
  if (!config) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "slack_not_configured",
      requestId,
    });
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const signatureValid = isValidSlackSignature({
    signingSecret: config.signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
  });
  if (!signatureValid) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      timestampHeader,
      bodyLength: rawBody.length,
    });
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_json",
      requestId,
      bodyLength: rawBody.length,
      bodyHead: rawBody.slice(0, 100),
    });
    return Response.json({ ok: true });
  }

  const challenge = getSlackUrlVerificationChallenge(payload);
  if (challenge !== null) {
    logInfo("channels.slack_url_verification", {
      requestId,
      challengeLength: challenge.length,
    });
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const eventInfo = extractSlackEventInfo(payload);
  const dedupId = extractSlackDedupId(payload);
  let dedupLock: SlackWebhookDedupLock | null = null;
  if (dedupId) {
    const dedupKey = channelDedupKey("slack", dedupId);
    const dedupToken = await getStore().acquireLock(dedupKey, 24 * 60 * 60);
    if (!dedupToken) {
      logInfo("channels.slack_webhook_dedup_skip", {
        requestId,
        dedupId,
        ...eventInfo,
      });
      return Response.json({ ok: true });
    }
    dedupLock = {
      key: dedupKey,
      token: dedupToken,
    };
  }

  // Skip bot messages to avoid feedback loops
  if (eventInfo.botId) {
    logInfo("channels.slack_webhook_bot_skip", {
      requestId,
      dedupId,
      botId: eventInfo.botId,
      eventType: eventInfo.eventType,
    });
    return Response.json({ ok: true });
  }

  const op = createOperationContext({
    trigger: "channel.slack.webhook",
    reason: "incoming slack webhook",
    requestId: requestId ?? null,
    channel: "slack",
    dedupId: dedupId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  logInfo("channels.slack_webhook_accepted", withOperationContext(op, {
    ...eventInfo,
    retryNum: retryNum ? Number(retryNum) : null,
    retryReason,
    bodyLength: rawBody.length,
  }));

  // --- Fast path: forward to OpenClaw's native Slack handler ---
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
    const forwardHeaders: Record<string, string> = {
      "content-type": request.headers.get("content-type") ?? "application/json",
    };
    for (const h of SLACK_FORWARD_HEADERS) {
      const v = request.headers.get(h);
      if (v) forwardHeaders[h] = v;
    }

    try {
      const sandboxUrl = await getSandboxDomain();
      const forwardUrl = `${sandboxUrl}/slack/events`;

      logInfo("channels.slack_fast_path_forwarding", withOperationContext(op, {
        sandboxId: effectiveMeta.sandboxId,
        forwardUrl,
        forwardHeaderKeys: Object.keys(forwardHeaders),
        hasSlackSignature: Boolean(forwardHeaders["x-slack-signature"]),
        hasSlackTimestamp: Boolean(forwardHeaders["x-slack-request-timestamp"]),
        ...eventInfo,
      }));

      const resp = await fetch(forwardUrl, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody,
      });
      if (resp.ok) {
        logInfo("channels.slack_fast_path_ok", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          responseStatus: resp.status,
          ...eventInfo,
        }));
      } else {
        logWarn("channels.slack_fast_path_non_ok", withOperationContext(op, {
          status: resp.status,
          sandboxId: effectiveMeta.sandboxId,
          ...eventInfo,
        }));
      }
      // Any HTTP response means the native handler received the payload.
      // Return 200 to avoid duplicate delivery via the workflow path.
      return Response.json({ ok: true });
    } catch (error) {
      // Network-level failure — native handler never received the payload.
      // Reconcile stale status and fall through to workflow wake path.
      logWarn("channels.slack_fast_path_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        sandboxId: effectiveMeta.sandboxId,
        action: "reconcile_and_wake",
        ...eventInfo,
      }));
      effectiveMeta = await reconcileStaleRunningStatus();
    }
  } else {
    logInfo("channels.slack_fast_path_skipped", withOperationContext(op, {
      reason: effectiveMeta.status !== "running" ? `sandbox_status_${effectiveMeta.status}` : "no_sandbox_id",
      status: effectiveMeta.status,
      sandboxId: effectiveMeta.sandboxId,
      ...eventInfo,
    }));
  }

  // Send "Waking up" boot message from the webhook route (before workflow)
  // so the user gets immediate feedback. The message ts is passed to the
  // workflow so the step can update/delete it during processing.
  let bootMessageTs: string | null = null;
  if (effectiveMeta.status !== "running" && eventInfo.channel) {
    try {
      const resp = await fetch(SLACK_POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: eventInfo.channel,
          ...(eventInfo.threadTs ? { thread_ts: eventInfo.threadTs } : {}),
          text: "🦞 Waking up\u2026 one moment.",
        }),
        signal: AbortSignal.timeout(SLACK_BOOT_MESSAGE_TIMEOUT_MS),
      });
      if (resp.ok) {
        const body = await resp.json() as { ok?: boolean; ts?: string };
        if (body.ok && body.ts) {
          bootMessageTs = body.ts;
        }
      }
      if (bootMessageTs) {
        logInfo("channels.slack_boot_message_sent", withOperationContext(op, {
          channel: eventInfo.channel,
          bootMessageTs,
        }));
      }
    } catch (err) {
      logWarn("channels.slack_boot_message_failed", withOperationContext(op, {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Capture Slack signature headers so the workflow wake path can replay the
  // forward with signatures intact. OpenClaw's Slack Bolt HTTPReceiver
  // re-verifies signatures and rejects with 401 when they're missing.
  const slackForwardHeaders: Record<string, string> = {};
  for (const h of SLACK_FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v) slackForwardHeaders[h] = v;
  }

  try {
    const origin = getPublicOrigin(request);
    await slackWebhookWorkflowRuntime.start(drainChannelWorkflow, [
      "slack",
      payload,
      origin,
      requestId ?? null,
      bootMessageTs,
      receivedAtMs,
      { slackForwardHeaders, slackRawBody: rawBody },
    ]);
    logInfo("channels.slack_workflow_started", withOperationContext(op, {
      ...eventInfo,
      slackForwardHeaderKeys: Object.keys(slackForwardHeaders),
    }));
  } catch (error) {
    const dedupRelease = await releaseSlackWebhookDedupLockForRetry(dedupLock);
    logWarn("channels.slack_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      attemptedAction: "start_drain_channel_workflow",
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      retryable: true,
      ...eventInfo,
    }));
    return workflowStartFailedResponse();
  }

  return Response.json({ ok: true });
}
