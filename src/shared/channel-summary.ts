import {
  normalizeChannelLastForward,
  type ChannelLastForward,
  type ChannelName,
  type ChannelUserVisibleReply,
  type WhatsAppLinkState,
} from "@/shared/channels";
import {
  channelDeliveryFromLastForward,
  normalizeChannelDeliverySnapshot,
  type ChannelDeliverySnapshot,
} from "@/shared/channel-delivery";

export const WHATSAPP_SUMMARY_DETAIL_ROUTE = "/api/channels/whatsapp" as const;
export const WHATSAPP_CONNECTION_SEMANTICS = "delivery-enabled" as const;

/**
 * Compact projection of {@link ChannelLastForward} suitable for the summary
 * API. Includes the fields an operator needs to triage delivery health
 * without paging through full attempt timelines.
 */
export type ChannelLastForwardSummary = {
  ok: boolean;
  classification: string;
  status: number | null;
  attempts: number;
  totalMs: number;
  sandboxUrl: string | null;
  sandboxId: string | null;
  finalReasonHead: string | null;
  completedAt: number;
  ageMs: number;
  userVisibleReply: ChannelUserVisibleReplySummary;
};

export type ChannelDeliveryStateSummary = ChannelDeliverySnapshot & {
  ageMs: number;
};

export type ChannelUserVisibleReplySummary = ChannelUserVisibleReply & {
  ageMs: number;
};

export type ChannelSummaryEntry = {
  /**
   * Legacy field kept for backward compatibility.
   * For all current channels this is equivalent to `configured`.
   */
  connected: boolean;
  configured: boolean;
  lastError: string | null;
  /** Most-recent forward attempt result (null if no forward has been recorded). */
  lastForward?: ChannelLastForwardSummary | null;
  /** Canonical per-delivery state projection for the latest known channel event. */
  lastDeliveryState?: ChannelDeliveryStateSummary | null;
  /** Independent platform-visible reply observation for the latest delivery. */
  userVisibleReply?: ChannelUserVisibleReplySummary | null;
};

export type SlackSummaryEntry = ChannelSummaryEntry & {
  /**
   * True only when credentials are saved and the running sandbox has accepted
   * the latest Slack config sync, including route registration for /slack/events.
   */
  deliveryReady: boolean;
  routeReady: boolean;
  liveConfigFresh: boolean;
  readiness: {
    configSyncOutcome: "skipped" | "applied" | "degraded" | "failed" | null;
    reason: string | null;
    checkedAt: number | null;
    operatorMessage: string | null;
    sandboxPath: "/slack/events";
    /**
     * Most-recent forward outcome (live delivery health). Distinct from
     * configSyncOutcome (one-shot, set during OAuth callback). When this
     * disagrees with configSyncOutcome — e.g. configSync = "applied" but
     * lastForward.classification = "sandbox-not-listening" — something has
     * gone stale since the config was applied.
     */
    lastForward: ChannelLastForwardSummary | null;
    lastDeliveryState: ChannelDeliveryStateSummary | null;
    userVisibleReply: ChannelUserVisibleReplySummary | null;
    userVisibleReplyVerified: boolean;
  };
};

export function projectChannelLastForward(
  raw: ChannelLastForward | null | undefined,
  now: number = Date.now(),
): ChannelLastForwardSummary | null {
  const normalized = normalizeChannelLastForward(raw, now);
  if (!normalized) return null;
  const userVisibleReply = normalized.userVisibleReply;
  return {
    ok: normalized.ok,
    classification: normalized.classification,
    status: normalized.status,
    attempts: normalized.attempts,
    totalMs: normalized.totalMs,
    sandboxUrl: normalized.sandboxUrl,
    sandboxId: normalized.sandboxId,
    finalReasonHead: normalized.finalReasonHead,
    completedAt: normalized.completedAt,
    ageMs: Math.max(0, now - normalized.completedAt),
    userVisibleReply: {
      ...userVisibleReply,
      ageMs: Math.max(0, now - userVisibleReply.checkedAt),
    },
  };
}

export function projectChannelDeliveryState(
  raw: ChannelDeliverySnapshot | null | undefined,
  fallbackLastForward: ChannelLastForward | null | undefined,
  channel: ChannelName,
  now: number = Date.now(),
): ChannelDeliveryStateSummary | null {
  const normalized = normalizeChannelDeliverySnapshot(raw);
  if (normalized) {
    return {
      ...normalized,
      ageMs: Math.max(0, now - normalized.updatedAt),
    };
  }

  const fallback = normalizeChannelLastForward(fallbackLastForward, now);
  if (!fallback) return null;
  const projected = channelDeliveryFromLastForward({
    channel,
    lastForward: fallback,
    now,
    source: "legacy-projection",
  });
  return {
    ...projected,
    ageMs: Math.max(0, now - (projected.completedAt ?? projected.receivedAt ?? projected.updatedAt)),
  };
}

export type WhatsAppSummaryEntry = ChannelSummaryEntry & {
  /**
   * Raw gateway-side link/session state. Distinct from the coarse
   * `connected/configured` flag so clients can reason without reading
   * source comments.
   */
  linkState: WhatsAppLinkState;
  connectionSemantics: typeof WHATSAPP_CONNECTION_SEMANTICS;
  detailRoute: typeof WHATSAPP_SUMMARY_DETAIL_ROUTE;
  deliveryMode: "webhook-proxied";
  requiresRunningSandbox: false;
};

export type ChannelSummaryResponse = {
  slack: SlackSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
  whatsapp: WhatsAppSummaryEntry;
};
