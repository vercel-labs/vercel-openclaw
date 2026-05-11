import {
  normalizeChannelLastForward,
  normalizeChannelUserVisibleReply,
  type ChannelLastForward,
  type ChannelLastForwardInput,
  type ChannelName,
  type ChannelUserVisibleReply,
} from "@/shared/channels";
import {
  applyUserVisibleReplyToChannelDelivery,
  channelDeliveryFromLastForward,
} from "@/shared/channel-delivery";
import { logInfo, logWarn } from "@/server/log";
import { mutateMeta } from "@/server/store/store";

/**
 * Persist most-recent forward outcome to `meta.channelDiagnostics.<ch>.
 * lastForward` so /api/channels/summary, /api/admin/why-not-ready, and
 * channel UI panels can surface ongoing delivery health (distinct from
 * the one-shot config-sync state).
 *
 * Both the Slack fast path (POST /api/channels/slack/webhook → direct
 * fetch) and the workflow path (drainChannelWorkflow → forwardToNative
 * HandlerWithRetry) call this. Writes are best-effort: failure does not
 * abort delivery.
 */
export async function recordChannelLastForward(
  channel: ChannelName,
  forward: ChannelLastForwardInput,
): Promise<void> {
  const normalizedForward = normalizeChannelLastForward(forward);
  if (!normalizedForward) {
    logWarn("channels.last_forward_invalid", {
      channel,
      deliveryId: forward.deliveryId,
    });
    return;
  }

  const lastDeliveryState = channelDeliveryFromLastForward({
    channel,
    lastForward: normalizedForward,
  });

  try {
    await mutateMeta((next) => {
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      next.channelDiagnostics[channel] = {
        ...next.channelDiagnostics[channel],
        lastForward: normalizedForward,
        lastDeliveryState,
      };
    });
    logInfo("channels.forward_outcome", {
      channel,
      ok: normalizedForward.ok,
      classification: normalizedForward.classification,
      attempts: normalizedForward.attempts,
      totalMs: normalizedForward.totalMs,
      sandboxUrl: normalizedForward.sandboxUrl,
      sandboxId: normalizedForward.sandboxId,
      transport: normalizedForward.transport,
      deliveryId: normalizedForward.deliveryId,
      userVisibleReplyStatus: normalizedForward.userVisibleReply.status,
      userVisibleReplySource: normalizedForward.userVisibleReply.source,
    });
  } catch (err) {
    logWarn("channels.last_forward_persist_failed", {
      channel,
      error: err instanceof Error ? err.message : String(err),
      deliveryId: normalizedForward.deliveryId,
    });
  }
}

export async function recordChannelUserVisibleReply(
  channel: ChannelName,
  deliveryId: string | null,
  userVisibleReply: ChannelUserVisibleReply,
): Promise<boolean> {
  let updated = false;
  try {
    await mutateMeta((next) => {
      const currentEntry = next.channelDiagnostics?.[channel];
      const current = currentEntry?.lastForward;
      if (!current || current.deliveryId !== deliveryId) return;
      const normalizedReply = normalizeChannelUserVisibleReply(userVisibleReply);
      if (!normalizedReply) return;
      const updatedForward: ChannelLastForward = {
        ...current,
        userVisibleReply: normalizedReply,
      };
      const updatedDeliveryState = applyUserVisibleReplyToChannelDelivery({
        current: currentEntry?.lastDeliveryState ?? null,
        channel,
        deliveryId,
        userVisibleReply: normalizedReply,
        fallbackLastForward: updatedForward,
      });
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      next.channelDiagnostics[channel] = {
        ...currentEntry,
        lastForward: updatedForward,
        ...(updatedDeliveryState ? { lastDeliveryState: updatedDeliveryState } : {}),
      };
      updated = true;
    });
  } catch (err) {
    logWarn("channels.user_visible_reply_persist_failed", {
      channel,
      deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return updated;
}
