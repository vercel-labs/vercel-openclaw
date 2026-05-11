import type { ChannelDeliverySnapshot } from "@/shared/channel-delivery";

export const CHANNEL_NAMES = ["slack", "telegram", "discord", "whatsapp"] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export function isChannelName(value: string): value is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value);
}

export type ChannelMode = "webhook-proxied" | "gateway-native";

export type SlackLiveConfigSyncState = {
  outcome: "skipped" | "applied" | "degraded" | "failed";
  reason: string;
  liveConfigFresh: boolean;
  checkedAt: number;
  operatorMessage?: string | null;
};

export type SlackChannelConfig = {
  signingSecret: string;
  botToken: string;
  configuredAt: number;
  team?: string;
  user?: string;
  botId?: string;
  lastError?: string;
  liveConfigSync?: SlackLiveConfigSyncState;
};

export type TelegramChannelConfig = {
  botToken: string;
  webhookSecret: string;
  previousWebhookSecret?: string;
  previousSecretExpiresAt?: number;
  webhookUrl: string;
  botUsername: string;
  configuredAt: number;
  commandSyncStatus?: "synced" | "unsynced" | "error";
  commandsRegisteredAt?: number;
  commandSyncError?: string;
  lastError?: string;
};

export type DiscordChannelConfig = {
  publicKey: string;
  applicationId: string;
  botToken: string;
  configuredAt: number;
  appName?: string;
  botUsername?: string;
  endpointConfigured?: boolean;
  endpointUrl?: string;
  endpointError?: string;
  commandRegistered?: boolean;
  commandId?: string;
  commandRegisteredAt?: number;
};

export type WhatsAppLinkState =
  | "unconfigured"
  | "needs-plugin"
  | "needs-login"
  | "linked"
  | "disconnected"
  | "error";

export type WhatsAppChannelConfig = {
  enabled: boolean;
  configuredAt: number;
  phoneNumberId?: string;
  accessToken?: string;
  verifyToken?: string;
  appSecret?: string;
  businessAccountId?: string;
  pluginSpec?: string;
  accountId?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  groups?: string[];
  lastKnownLinkState?: WhatsAppLinkState;
  linkedPhone?: string;
  displayName?: string;
  lastError?: string;
};

export type ChannelConfigs = {
  slack: SlackChannelConfig | null;
  telegram: TelegramChannelConfig | null;
  discord: DiscordChannelConfig | null;
  whatsapp: WhatsAppChannelConfig | null;
};

export type ChannelUserVisibleReplyStatus = "unknown" | "observed" | "timed-out";

export type ChannelUserVisibleReplySource =
  | "not-attempted"
  | "synthetic-canary"
  | "platform-api"
  | "manual";

export type ChannelUserVisibleReply = {
  status: ChannelUserVisibleReplyStatus;
  checkedAt: number;
  observedAt: number | null;
  timeoutMs: number | null;
  source: ChannelUserVisibleReplySource;
  reason: string | null;
  evidence?: Record<string, unknown> | null;
};

export function createUnknownUserVisibleReply(
  checkedAt: number,
  reason = "native-forward-only",
): ChannelUserVisibleReply {
  return {
    status: "unknown",
    checkedAt,
    observedAt: null,
    timeoutMs: null,
    source: "not-attempted",
    reason,
    evidence: null,
  };
}

const SAFE_USER_VISIBLE_REPLY_EVIDENCE_KEYS = new Set([
  "messageIdHash",
  "threadIdHash",
  "channelIdHash",
  "userIdHash",
  "replyIdHash",
  "deliveryIdHash",
  "platformMessageIdHash",
  "platformThreadIdHash",
  "observer",
  "classification",
  "matched",
  "attempts",
  "durationMs",
  "totalMs",
  "elapsedMs",
  "statusCode",
]);

function normalizeSafeUserVisibleReplyEvidence(
  value: unknown,
): Record<string, string | number | boolean | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_USER_VISIBLE_REPLY_EVIDENCE_KEYS.has(key)) continue;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      safe[key] = entry;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

export function normalizeChannelUserVisibleReply(
  value: unknown,
): ChannelUserVisibleReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<ChannelUserVisibleReply>;
  const status = raw.status;
  const source = raw.source;
  const validStatus =
    status === "unknown" || status === "observed" || status === "timed-out";
  const validSource =
    source === "not-attempted" ||
    source === "synthetic-canary" ||
    source === "platform-api" ||
    source === "manual";
  if (!validStatus || !validSource) return null;
  if (typeof raw.checkedAt !== "number") return null;
  if (!(raw.observedAt === null || typeof raw.observedAt === "number")) return null;
  if (!(raw.timeoutMs === null || typeof raw.timeoutMs === "number")) return null;
  if (!(raw.reason === null || typeof raw.reason === "string")) return null;
  if (status === "observed" && typeof raw.observedAt !== "number") return null;
  if (status === "timed-out" && typeof raw.timeoutMs !== "number") return null;

  return {
    status,
    checkedAt: raw.checkedAt,
    observedAt: raw.observedAt,
    timeoutMs: raw.timeoutMs,
    source,
    reason: raw.reason,
    evidence: normalizeSafeUserVisibleReplyEvidence(raw.evidence),
  };
}

export function isChannelUserVisibleReply(
  value: unknown,
): value is ChannelUserVisibleReply {
  return normalizeChannelUserVisibleReply(value) !== null;
}

/**
 * Most-recent forward attempt result, recorded per inbound webhook.
 *
 * Operator surfaces (e.g. /api/channels/summary readiness) read this to
 * report ongoing delivery health, distinct from the one-shot config-sync
 * outcome captured in {@link SlackLiveConfigSyncState}. A failed forward
 * after a successful config-sync is the signal that something has gone
 * stale (sandbox suspended, public URL dead, plugin not registered).
 */
export type ChannelLastForward = {
  ok: boolean;
  status: number | null;
  /**
   * One of the forward classifier values:
   *   "accepted" | "handler-not-ready" | "sandbox-not-listening" |
   *   "proxy-error" | "fetch-exception" | "handler-error" |
   *   "swallowed-by-base-server" | "exhausted"
   */
  classification: string;
  attempts: number;
  totalMs: number;
  transport: "public" | "local" | null;
  /** Cached sandbox public URL used for the last attempt, or null when unknown. */
  sandboxUrl: string | null;
  /** Sandbox ID at forward time, or null. */
  sandboxId: string | null;
  /** First ~200 chars of the final attempt's response body (debugging aid). */
  finalReasonHead: string | null;
  startedAt: number;
  completedAt: number;
  deliveryId: string | null;
  /** Independent platform-visible reply observation for this delivery. */
  userVisibleReply: ChannelUserVisibleReply;
};

export type ChannelLastForwardInput = Omit<ChannelLastForward, "userVisibleReply"> & {
  userVisibleReply?: ChannelUserVisibleReply;
};

export type ChannelDiagnostics = Partial<
  Record<
    ChannelName,
    {
      lastForward?: ChannelLastForward;
      lastDeliveryState?: ChannelDeliverySnapshot;
    }
  >
>;

export function isChannelLastForward(value: unknown): value is ChannelLastForwardInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Partial<ChannelLastForward>;
  return (
    typeof raw.ok === "boolean" &&
    typeof raw.classification === "string" &&
    typeof raw.attempts === "number" &&
    typeof raw.totalMs === "number" &&
    typeof raw.startedAt === "number" &&
    typeof raw.completedAt === "number" &&
    (raw.userVisibleReply === undefined || isChannelUserVisibleReply(raw.userVisibleReply))
  );
}

export function normalizeChannelLastForward(
  value: unknown,
  now = Date.now(),
): ChannelLastForward | null {
  if (!isChannelLastForward(value)) return null;
  const raw = value as ChannelLastForwardInput;
  const status = raw.status;
  const completedAt = typeof raw.completedAt === "number" ? raw.completedAt : now;
  return {
    ok: raw.ok,
    status: typeof status === "number" || status === null ? status : null,
    classification: raw.classification,
    attempts: raw.attempts,
    totalMs: raw.totalMs,
    transport: raw.transport === "public" || raw.transport === "local" ? raw.transport : null,
    sandboxUrl: typeof raw.sandboxUrl === "string" || raw.sandboxUrl === null ? raw.sandboxUrl : null,
    sandboxId: typeof raw.sandboxId === "string" || raw.sandboxId === null ? raw.sandboxId : null,
    finalReasonHead:
      typeof raw.finalReasonHead === "string" || raw.finalReasonHead === null
        ? raw.finalReasonHead
        : null,
    startedAt: raw.startedAt,
    completedAt,
    deliveryId: typeof raw.deliveryId === "string" || raw.deliveryId === null ? raw.deliveryId : null,
    userVisibleReply:
      normalizeChannelUserVisibleReply(raw.userVisibleReply) ??
      createUnknownUserVisibleReply(completedAt),
  };
}

export function createDefaultChannelConfigs(): ChannelConfigs {
  return {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  };
}

export function ensureChannelConfigs(input: unknown): ChannelConfigs {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createDefaultChannelConfigs();
  }

  const raw = input as Partial<ChannelConfigs>;
  return {
    slack: isSlackChannelConfig(raw.slack) ? raw.slack : null,
    telegram: isTelegramChannelConfig(raw.telegram) ? raw.telegram : null,
    discord: isDiscordChannelConfig(raw.discord) ? raw.discord : null,
    whatsapp: isWhatsAppChannelConfig(raw.whatsapp) ? raw.whatsapp : null,
  };
}

function isSlackChannelConfig(value: unknown): value is SlackChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<SlackChannelConfig>;
  return (
    typeof raw.signingSecret === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isTelegramChannelConfig(value: unknown): value is TelegramChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<TelegramChannelConfig>;
  return (
    typeof raw.botToken === "string" &&
    typeof raw.webhookSecret === "string" &&
    typeof raw.webhookUrl === "string" &&
    typeof raw.botUsername === "string" &&
    typeof raw.configuredAt === "number" &&
    (raw.previousWebhookSecret === undefined || typeof raw.previousWebhookSecret === "string") &&
    (raw.previousSecretExpiresAt === undefined || typeof raw.previousSecretExpiresAt === "number") &&
    (raw.commandSyncStatus === undefined ||
      raw.commandSyncStatus === "synced" ||
      raw.commandSyncStatus === "unsynced" ||
      raw.commandSyncStatus === "error") &&
    (raw.commandsRegisteredAt === undefined || typeof raw.commandsRegisteredAt === "number") &&
    (raw.commandSyncError === undefined || typeof raw.commandSyncError === "string") &&
    (raw.lastError === undefined || typeof raw.lastError === "string")
  );
}

function isDiscordChannelConfig(value: unknown): value is DiscordChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<DiscordChannelConfig>;
  return (
    typeof raw.publicKey === "string" &&
    typeof raw.applicationId === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isWhatsAppChannelConfig(value: unknown): value is WhatsAppChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<WhatsAppChannelConfig>;
  return (
    typeof raw.enabled === "boolean" &&
    typeof raw.configuredAt === "number" &&
    (raw.phoneNumberId === undefined || typeof raw.phoneNumberId === "string") &&
    (raw.accessToken === undefined || typeof raw.accessToken === "string") &&
    (raw.verifyToken === undefined || typeof raw.verifyToken === "string") &&
    (raw.appSecret === undefined || typeof raw.appSecret === "string") &&
    (raw.businessAccountId === undefined || typeof raw.businessAccountId === "string") &&
    (raw.pluginSpec === undefined || typeof raw.pluginSpec === "string") &&
    (raw.accountId === undefined || typeof raw.accountId === "string") &&
    (raw.dmPolicy === undefined ||
      raw.dmPolicy === "pairing" ||
      raw.dmPolicy === "allowlist" ||
      raw.dmPolicy === "open" ||
      raw.dmPolicy === "disabled") &&
    (raw.allowFrom === undefined ||
      (Array.isArray(raw.allowFrom) && raw.allowFrom.every((entry) => typeof entry === "string"))) &&
    (raw.groupPolicy === undefined ||
      raw.groupPolicy === "open" ||
      raw.groupPolicy === "allowlist" ||
      raw.groupPolicy === "disabled") &&
    (raw.groupAllowFrom === undefined ||
      (Array.isArray(raw.groupAllowFrom) &&
        raw.groupAllowFrom.every((entry) => typeof entry === "string"))) &&
    (raw.groups === undefined ||
      (Array.isArray(raw.groups) && raw.groups.every((entry) => typeof entry === "string"))) &&
    (raw.lastKnownLinkState === undefined ||
      raw.lastKnownLinkState === "unconfigured" ||
      raw.lastKnownLinkState === "needs-plugin" ||
      raw.lastKnownLinkState === "needs-login" ||
      raw.lastKnownLinkState === "linked" ||
      raw.lastKnownLinkState === "disconnected" ||
      raw.lastKnownLinkState === "error") &&
    (raw.linkedPhone === undefined || typeof raw.linkedPhone === "string") &&
    (raw.displayName === undefined || typeof raw.displayName === "string") &&
    (raw.lastError === undefined || typeof raw.lastError === "string")
  );
}

export function hasWhatsAppBusinessCredentials(
  config: WhatsAppChannelConfig | null | undefined,
): config is WhatsAppChannelConfig & {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
} {
  return Boolean(
    config?.phoneNumberId &&
      config.accessToken &&
      config.verifyToken &&
      config.appSecret,
  );
}
