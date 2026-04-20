import * as workflowApi from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import {
  channelDedupKey,
  channelPendingBootMessageKey,
  channelUserMessageDedupKey,
} from "@/server/channels/keys";
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

async function releaseSlackWebhookDedupLocksForRetry(
  locks: ReadonlyArray<SlackWebhookDedupLock | null>,
): Promise<SlackWebhookDedupReleaseResult[]> {
  return Promise.all(
    locks.map(async (lock) => {
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
    }),
  );
}

function extractSlackEventInfo(payload: unknown): {
  eventType: string | null;
  eventSubtype: string | null;
  channel: string | null;
  user: string | null;
  text: string | null;
  threadTs: string | null;
  ts: string | null;
  botId: string | null;
  payloadType: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { eventType: null, eventSubtype: null, channel: null, user: null, text: null, threadTs: null, ts: null, botId: null, payloadType: null };
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
    ts: typeof event?.ts === "string" ? event.ts : null,
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
    // Lenient parse on failure so we can tell a stale-secret rotation from a
    // second Slack app install. If two apps subscribe to the same webhook URL,
    // api_app_id / team_id will differ between accepted and rejected requests.
    const failDiag: {
      apiAppId: string | null;
      teamId: string | null;
      eventType: string | null;
      configuredSecretPreview: string | null;
    } = {
      apiAppId: null,
      teamId: null,
      eventType: null,
      configuredSecretPreview: null,
    };
    try {
      const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        failDiag.apiAppId = typeof p.api_app_id === "string" ? p.api_app_id : null;
        failDiag.teamId = typeof p.team_id === "string" ? p.team_id : null;
        const ev = p.event as Record<string, unknown> | undefined;
        failDiag.eventType = typeof ev?.type === "string" ? ev.type : null;
      }
    } catch {
      // ignore — payload was not JSON
    }
    failDiag.configuredSecretPreview = config.signingSecret
      ? `${config.signingSecret.slice(0, 4)}…${config.signingSecret.slice(-2)}`
      : null;
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      timestampHeader,
      bodyLength: rawBody.length,
      ...failDiag,
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

  // Skip bot messages to avoid feedback loops. Before returning, sweep any
  // "🦞 Bot waking up…" placeholder we parked in this thread — OpenClaw's
  // reply arriving means the dead-time fill has served its purpose.
  if (eventInfo.botId) {
    if (eventInfo.channel) {
      // Bot replies always include thread_ts equal to the user's thread
      // root. The write side keys pending-boot by the same root so this
      // cleanup only touches the boot for this specific thread.
      const botReplyRoot =
        typeof eventInfo.threadTs === "string" && eventInfo.threadTs.length > 0
          ? eventInfo.threadTs
          : typeof eventInfo.ts === "string" && eventInfo.ts.length > 0
            ? eventInfo.ts
            : null;
      const pendingKey = channelPendingBootMessageKey(
        "slack",
        eventInfo.channel,
        botReplyRoot ?? undefined,
      );
      try {
        const bootTs = await getStore().getValue<string>(pendingKey);
        if (bootTs) {
          await fetch("https://slack.com/api/chat.delete", {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              channel: eventInfo.channel,
              ts: bootTs,
            }),
            signal: AbortSignal.timeout(SLACK_BOOT_MESSAGE_TIMEOUT_MS),
          }).catch(() => {});
          await getStore().deleteValue(pendingKey).catch(() => {});
          logInfo("channels.slack_pending_boot_cleared", {
            requestId,
            channel: eventInfo.channel,
            bootTs,
          });
        }
      } catch (error) {
        logWarn("channels.slack_pending_boot_clear_failed", {
          requestId,
          channel: eventInfo.channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logInfo("channels.slack_webhook_bot_skip", {
      requestId,
      dedupId,
      botId: eventInfo.botId,
      eventType: eventInfo.eventType,
    });
    return Response.json({ ok: true });
  }

  // Skip message edit/deletion subtypes. Slack fires `message_changed`
  // repeatedly as a user types (every few keystrokes) and `message_deleted`
  // when messages are removed. Each event has a unique event_id, so dedup
  // doesn't catch them — and a stopped sandbox would wake, send a "Waking
  // up…" boot message, and try to forward the edit, multiplying work for
  // what is not a user-intended utterance. The native Slack handler already
  // ignores edits, so forwarding them buys nothing even when running.
  const ignorableSubtypes = new Set(["message_changed", "message_deleted"]);
  if (eventInfo.eventSubtype && ignorableSubtypes.has(eventInfo.eventSubtype)) {
    logInfo("channels.slack_webhook_subtype_skip", {
      requestId,
      dedupId,
      eventType: eventInfo.eventType,
      eventSubtype: eventInfo.eventSubtype,
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

  const payloadRoot = payload as Record<string, unknown> | null;
  const apiAppId =
    payloadRoot && typeof payloadRoot.api_app_id === "string"
      ? payloadRoot.api_app_id
      : null;
  const teamId =
    payloadRoot && typeof payloadRoot.team_id === "string"
      ? payloadRoot.team_id
      : null;
  logInfo("channels.slack_webhook_accepted", withOperationContext(op, {
    ...eventInfo,
    retryNum: retryNum ? Number(retryNum) : null,
    retryReason,
    bodyLength: rawBody.length,
    apiAppId,
    teamId,
  }));

  // --- Fast path: forward to OpenClaw's native Slack handler ---
  // When the sandbox is running, delegate entirely to the native handler.
  // Await the response so the native handler can complete its full
  // processing cycle (including long AI tasks like image generation).
  // Fluid Compute bills only for CPU cycles, not idle wait time.
  //
  // Return 200 only when the native handler returned 2xx. A non-2xx response
  // indicates the payload was NOT successfully handed off (edge error,
  // handler unavailable, or explicit reject). Since Slack does not retry on
  // a 200 from us, we must fall through to the durable workflow wake path
  // rather than silently dropping the event.
  //
  // Network-level failure (fetch throws) is also safe to fall through on:
  // the native handler never received the payload.
  let effectiveMeta = meta;
  if (effectiveMeta.status === "running" && effectiveMeta.sandboxId) {
    const forwardHeaders: Record<string, string> = {
      "content-type": request.headers.get("content-type") ?? "application/json",
    };
    for (const h of SLACK_FORWARD_HEADERS) {
      const v = request.headers.get(h);
      if (v) forwardHeaders[h] = v;
    }
    const fastPathDedupId = extractSlackDedupId(payload);
    if (fastPathDedupId) {
      forwardHeaders["x-openclaw-delivery-id"] = `slack:${fastPathDedupId}`;
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
        return Response.json({ ok: true });
      }

      // Native handler returned non-2xx — fall through to workflow wake path
      // so the event is not silently dropped. Slack does not retry on our 200.
      logWarn("channels.slack_fast_path_fallback_to_workflow", withOperationContext(op, {
        status: resp.status,
        sandboxId: effectiveMeta.sandboxId,
        action: "start_drain_channel_workflow",
        ...eventInfo,
      }));
      effectiveMeta = await reconcileStaleRunningStatus();
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

  // Wake-path only: collapse Slack's dual-event delivery (app_mention +
  // message.channels for the same user post). Both have distinct event_ids
  // so the event-id dedup above lets both through; this second lock keyed on
  // the user message's channel+ts ensures only ONE wake/workflow per user
  // post. The fast path above intentionally forwards BOTH events to the
  // native Bolt handler, which has its own dedup.
  let userMessageDedupLock: SlackWebhookDedupLock | null = null;
  const userMessageTs =
    typeof (payload as { event?: { ts?: unknown } } | null)?.event?.ts === "string"
      ? (payload as { event: { ts: string } }).event.ts
      : null;
  if (eventInfo.channel && userMessageTs) {
    const userMessageKey = channelUserMessageDedupKey(
      "slack",
      eventInfo.channel,
      userMessageTs,
    );
    const userMessageToken = await getStore().acquireLock(
      userMessageKey,
      24 * 60 * 60,
    );
    if (!userMessageToken) {
      logInfo(
        "channels.slack_webhook_user_message_dedup_skip",
        withOperationContext(op, {
          channel: eventInfo.channel,
          ts: userMessageTs,
          eventType: eventInfo.eventType,
          eventSubtype: eventInfo.eventSubtype,
          dedupId,
        }),
      );
      return Response.json({ ok: true });
    }
    userMessageDedupLock = {
      key: userMessageKey,
      token: userMessageToken,
    };
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
          text: "🦞 Waking up\u2026 the first reply after idle is slow. Future replies in this channel will be instant.",
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
      {
        version: 1,
        channel: "slack",
        payload,
        origin,
        requestId: requestId ?? null,
        bootMessageId: bootMessageTs,
        receivedAtMs,
        workflowHandoff: { slackForwardHeaders, slackRawBody: rawBody },
      },
    ]);
    logInfo("channels.slack_workflow_started", withOperationContext(op, {
      ...eventInfo,
      slackForwardHeaderKeys: Object.keys(slackForwardHeaders),
    }));
  } catch (error) {
    // Best-effort delete the boot message we posted just before this failed
    // workflow start. Slack will not auto-retry the webhook (we return 5xx),
    // and the user will eventually retry manually — leaving a dangling
    // "Waking up…" placeholder looks broken. Symmetric to the Telegram path.
    if (bootMessageTs && eventInfo.channel) {
      try {
        await fetch("https://slack.com/api/chat.delete", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: eventInfo.channel,
            ts: bootMessageTs,
          }),
          signal: AbortSignal.timeout(SLACK_BOOT_MESSAGE_TIMEOUT_MS),
        }).catch(() => {});
      } catch {
        // Don't let cleanup failure mask the real error response.
      }
    }
    const [dedupRelease, userMessageRelease] =
      await releaseSlackWebhookDedupLocksForRetry([
        dedupLock,
        userMessageDedupLock,
      ]);
    logWarn("channels.slack_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      attemptedAction: "start_drain_channel_workflow",
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      userMessageDedupLockKey: userMessageDedupLock?.key ?? null,
      userMessageDedupLockReleaseAttempted: userMessageRelease.attempted,
      userMessageDedupLockReleased: userMessageRelease.released,
      userMessageDedupLockReleaseError: userMessageRelease.releaseError,
      bootMessageCleanupAttempted: Boolean(bootMessageTs && eventInfo.channel),
      retryable: true,
      ...eventInfo,
    }));
    return workflowStartFailedResponse();
  }

  return Response.json({ ok: true });
}
