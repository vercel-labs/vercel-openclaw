import type { ChannelName } from "@/shared/channels";
import { logError } from "@/server/log";
import { getStore } from "@/server/store/store";

/**
 * TTL for the primary per-delivery dedup lock used by every channel
 * webhook route. Must comfortably cover each platform's retry window:
 * Slack retries up to ~10 minutes, Telegram gives up after ~30 minutes,
 * WhatsApp similar. 1 hour is a generous ceiling with no practical
 * downside. The old 24-hour TTL held stale locks for an entire day
 * past usefulness and added unnecessary Redis pressure.
 */
export const CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS = 60 * 60;

/**
 * TTL for Slack's secondary user-message dedup lock, keyed on
 * channel+ts instead of event_id. This one guards against Slack's
 * dual-event delivery (app_mention + message.channels emitted for the
 * same user post with distinct event_ids). Kept at 24 hours because
 * the collapse window for that dual delivery is practically the full
 * conversation day, not the platform retry SLA.
 */
export const SLACK_USER_MESSAGE_DEDUP_LOCK_TTL_SECONDS = 24 * 60 * 60;

export type ChannelDedupLock = {
  key: string;
  token: string;
};

export type ChannelDedupAcquireResult =
  | { kind: "acquired"; lock: ChannelDedupLock }
  | { kind: "duplicate" }
  | { kind: "degraded"; error: string };

/**
 * Acquire a per-delivery Redis lock for a channel webhook with
 * graceful degradation. A store-level exception (Redis outage,
 * connection refused) is caught and the caller is told to continue
 * WITHOUT a dedup lock — duplicate processing is strictly better
 * than silently dropping a webhook during an infra outage. The
 * platforms' own dedup (Slack event_id uniqueness, Telegram
 * update_id uniqueness) and the delivery-id header on the native
 * handler side provide defense-in-depth.
 */
export async function tryAcquireChannelDedupLock(input: {
  channel: ChannelName;
  key: string;
  ttlSeconds: number;
  requestId: string | null;
  dedupId: string | null;
  lockKind?: string;
}): Promise<ChannelDedupAcquireResult> {
  try {
    const token = await getStore().acquireLock(input.key, input.ttlSeconds);
    if (!token) return { kind: "duplicate" };
    return { kind: "acquired", lock: { key: input.key, token } };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logError("channels.dedup_lock_acquire_failed_degraded", {
      channel: input.channel,
      lockKind: input.lockKind ?? "delivery",
      requestId: input.requestId,
      dedupId: input.dedupId,
      key: input.key,
      ttlSeconds: input.ttlSeconds,
      error: errorMessage,
      errorName: error instanceof Error ? error.name : null,
      action: "continue_without_dedup",
    });
    return { kind: "degraded", error: errorMessage };
  }
}
