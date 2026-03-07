import {
  createDefaultChannelConfigs,
  ensureChannelConfigs,
  type ChannelConfigs,
} from "@/shared/channels";

export type FirewallMode = "disabled" | "learning" | "enforcing";

export type SingleStatus =
  | "uninitialized"
  | "creating"
  | "setup"
  | "running"
  | "stopped"
  | "restoring"
  | "error"
  | "booting";

export type LearnedDomain = {
  domain: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
};

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogSource =
  | "lifecycle"
  | "proxy"
  | "firewall"
  | "channels"
  | "auth"
  | "system";

export type LogEntry = {
  id: string;
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  message: string;
  data?: Record<string, unknown>;
};

export type SnapshotRecord = {
  id: string;
  snapshotId: string;
  timestamp: number;
  reason: string;
};

export type FirewallEvent = {
  id: string;
  timestamp: number;
  action: string;
  decision: string;
  domain?: string;
  reason?: string;
  source?: string;
};

export type FirewallState = {
  mode: FirewallMode;
  allowlist: string[];
  learned: LearnedDomain[];
  events: FirewallEvent[];
  updatedAt: number;
  lastIngestedAt: number | null;
};

export type SingleMeta = {
  _schemaVersion: number;
  id: "openclaw-single";
  sandboxId: string | null;
  snapshotId: string | null;
  status: SingleStatus;
  gatewayToken: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  portUrls: Record<string, string> | null;
  startupScript: string | null;
  lastError: string | null;
  firewall: FirewallState;
  channels: ChannelConfigs;
  snapshotHistory: SnapshotRecord[];
};

export const CURRENT_SCHEMA_VERSION = 1;

export function createDefaultMeta(now: number, gatewayToken: string): SingleMeta {
  return {
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "uninitialized",
    gatewayToken,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: now,
      lastIngestedAt: null,
    },
    channels: createDefaultChannelConfigs(),
    snapshotHistory: [],
  };
}

export function ensureMetaShape(input: unknown): SingleMeta | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const raw = input as Partial<SingleMeta> & {
    firewall?: Partial<FirewallState>;
  };
  const now = Date.now();
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : now;

  return {
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    id: "openclaw-single",
    sandboxId: typeof raw.sandboxId === "string" ? raw.sandboxId : null,
    snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : null,
    status: isSingleStatus(raw.status) ? raw.status : "uninitialized",
    gatewayToken: typeof raw.gatewayToken === "string" ? raw.gatewayToken : "",
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
    lastAccessedAt:
      typeof raw.lastAccessedAt === "number" ? raw.lastAccessedAt : null,
    portUrls:
      raw.portUrls && typeof raw.portUrls === "object" && !Array.isArray(raw.portUrls)
        ? (raw.portUrls as Record<string, string>)
        : null,
    startupScript:
      typeof raw.startupScript === "string" ? raw.startupScript : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    firewall: {
      mode: isFirewallMode(raw.firewall?.mode) ? raw.firewall.mode : "disabled",
      allowlist: Array.isArray(raw.firewall?.allowlist)
        ? raw.firewall.allowlist.filter((value): value is string => typeof value === "string")
        : [],
      learned: Array.isArray(raw.firewall?.learned)
        ? raw.firewall.learned.filter(isLearnedDomain)
        : [],
      events: Array.isArray(raw.firewall?.events)
        ? raw.firewall.events.filter(isFirewallEvent)
        : [],
      updatedAt:
        typeof raw.firewall?.updatedAt === "number"
          ? raw.firewall.updatedAt
          : createdAt,
      lastIngestedAt:
        typeof raw.firewall?.lastIngestedAt === "number"
          ? raw.firewall.lastIngestedAt
          : null,
    },
    channels: ensureChannelConfigs(raw.channels),
    snapshotHistory: Array.isArray((raw as Record<string, unknown>).snapshotHistory)
      ? ((raw as Record<string, unknown>).snapshotHistory as unknown[]).filter(isSnapshotRecord)
      : [],
  };
}

export function isFirewallMode(value: unknown): value is FirewallMode {
  return value === "disabled" || value === "learning" || value === "enforcing";
}

export function isSingleStatus(value: unknown): value is SingleStatus {
  return (
    value === "uninitialized" ||
    value === "creating" ||
    value === "setup" ||
    value === "running" ||
    value === "stopped" ||
    value === "restoring" ||
    value === "error" ||
    value === "booting"
  );
}

function isLearnedDomain(value: unknown): value is LearnedDomain {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<LearnedDomain>;
  return (
    typeof raw.domain === "string" &&
    typeof raw.firstSeenAt === "number" &&
    typeof raw.lastSeenAt === "number" &&
    typeof raw.hitCount === "number"
  );
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<SnapshotRecord>;
  return (
    typeof raw.id === "string" &&
    typeof raw.snapshotId === "string" &&
    typeof raw.timestamp === "number" &&
    typeof raw.reason === "string"
  );
}

function isFirewallEvent(value: unknown): value is FirewallEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<FirewallEvent>;
  return (
    typeof raw.id === "string" &&
    typeof raw.timestamp === "number" &&
    typeof raw.action === "string" &&
    typeof raw.decision === "string"
  );
}
