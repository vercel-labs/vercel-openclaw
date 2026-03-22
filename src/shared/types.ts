import { createHash } from "node:crypto";

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

export type DomainCategory = "npm" | "curl" | "git" | "dns" | "fetch" | "unknown";

export type LearnedDomain = {
  domain: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
  categories?: DomainCategory[];
};

// ---------------------------------------------------------------------------
// Operation context types for correlated observability
// ---------------------------------------------------------------------------

export type OperationTrigger =
  | "admin.ensure"
  | "admin.stop"
  | "gateway.request"
  | "status.heartbeat"
  | "watchdog"
  | "channel.slack.webhook"
  | "channel.telegram.webhook"
  | "channel.discord.webhook"
  | "channel.queue.consumer";

export type OperationContext = {
  opId: string;
  parentOpId: string | null;
  trigger: OperationTrigger;
  reason: string;
  requestId: string | null;
  channel: "slack" | "telegram" | "discord" | null;
  messageId: string | null;
  dedupId: string | null;
  deliveryCount: number | null;
  retryCount: number | null;
  sandboxId: string | null;
  snapshotId: string | null;
  status: SingleStatus | null;
};

export type LifecycleStateSnapshot = {
  status: SingleStatus;
  sandboxId: string | null;
  snapshotId: string | null;
  lastError: string | null;
};

// ---------------------------------------------------------------------------
// Log types
// ---------------------------------------------------------------------------

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
  sourceCommand?: string;
  category?: DomainCategory;
};

export type FirewallIngestOutcome = {
  timestamp: number;
  durationMs: number;
  domainsSeenCount: number;
  newCount: number;
  updatedCount: number;
  skipReason: string | null;
};

export type FirewallSyncOutcome = {
  timestamp: number;
  durationMs: number;
  allowlistCount: number;
  policyHash: string;
  applied: boolean;
  reason: string;
};

export type FirewallState = {
  mode: FirewallMode;
  allowlist: string[];
  learned: LearnedDomain[];
  events: FirewallEvent[];
  updatedAt: number;
  lastIngestedAt: number | null;
  /** Timestamp when learning mode was last activated, or null if never. */
  learningStartedAt: number | null;
  /** Total number of shell log lines processed since learning started. */
  commandsObserved: number;
  /** Learned domains that are NOT in the allowlist — only populated in learning mode. */
  wouldBlock: string[];
  /** Timestamp of last successful firewall policy sync to sandbox, or null. */
  lastSyncAppliedAt: number | null;
  /** Timestamp of last failed firewall policy sync to sandbox, or null. */
  lastSyncFailedAt: number | null;
  /** Reason string from the last sync attempt (e.g. "policy-applied", "sandbox-not-running"). */
  lastSyncReason: string | null;
  /** Reason the last ingestion was skipped (e.g. "throttled", "locked", "mode-not-learning"). */
  lastIngestionSkipReason: string | null;
  /** Number of consecutive ingestion skips since the last successful ingest. */
  ingestionSkipCount: number;
  /** Structured outcome of the last ingest operation, or null if none yet. */
  lastIngestOutcome: FirewallIngestOutcome | null;
  /** Structured outcome of the last sync operation, or null if none yet. */
  lastSyncOutcome: FirewallSyncOutcome | null;
};

export type FirewallReport = {
  schemaVersion: 1;
  generatedAt: number;
  state: FirewallState;
  diagnostics: {
    mode: FirewallMode;
    learningHealth: {
      durationMs: number | null;
      commandsObserved: number;
      uniqueDomains: number;
      lastIngestedAt: number | null;
      stalenessMs: number | null;
    };
    syncStatus: {
      lastAppliedAt: number | null;
      lastFailedAt: number | null;
      lastReason: string | null;
    };
    ingestionStatus: {
      lastSkipReason: string | null;
      consecutiveSkips: number;
    };
    wouldBlockCount: number;
  };
  groupedLearned: Array<{
    registrableDomain: string;
    domains: LearnedDomain[];
  }>;
  wouldBlock: string[];
  lastIngest: FirewallIngestOutcome | null;
  lastSync: FirewallSyncOutcome | null;
  limitations: string[];
  policyHash: string;
};

export type RestorePhaseMetrics = {
  sandboxCreateMs: number;
  tokenWriteMs: number;
  assetSyncMs: number;
  startupScriptMs: number;
  forcePairMs: number;
  firewallSyncMs: number;
  localReadyMs: number;
  publicReadyMs: number;
  totalMs: number;
  skippedStaticAssetSync: boolean;
  skippedDynamicConfigSync?: boolean;
  dynamicConfigHash?: string | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  assetSha256: string | null;
  vcpus: number;
  recordedAt: number;
  /** Wall-clock ms for the overlapped firewall-sync + local-ready phase. */
  bootOverlapMs?: number;
  /** Whether the public readiness probe was skipped (non-waiting callers). */
  skippedPublicReady?: boolean;
};

/**
 * Maximum number of restore history entries retained in metadata.
 * Older entries are dropped on every persist to keep state bounded.
 */
export const MAX_RESTORE_HISTORY = 50;

export type SingleMeta = {
  _schemaVersion: number;
  version: number;
  id: "openclaw-single";
  sandboxId: string | null;
  snapshotId: string | null;
  /** SHA-256 of the gateway config baked into the current snapshot.
   *  When this matches the config computed at restore time, the dynamic
   *  config writeFiles call (~6s) can be skipped entirely. */
  snapshotConfigHash: string | null;
  openclawVersion: string | null;
  status: SingleStatus;
  gatewayToken: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  portUrls: Record<string, string> | null;
  startupScript: string | null;
  lastError: string | null;
  firewall: FirewallState;
  lastTokenRefreshAt: number | null;
  channels: ChannelConfigs;
  snapshotHistory: SnapshotRecord[];
  lastRestoreMetrics: RestorePhaseMetrics | null;
  /** Capped ring of per-restore timing records (most recent first). */
  restoreHistory: RestorePhaseMetrics[];
  /** Unix-epoch seconds when the current AI Gateway token expires, or null for static keys. */
  lastTokenExpiresAt?: number | null;
  /** Credential source used for the most recent AI Gateway token. */
  lastTokenSource?: "oidc" | "api-key" | null;
  /** Error message from the most recent token refresh failure, or null. */
  lastTokenRefreshError?: string | null;
  /** Number of consecutive token refresh failures (resets on success). */
  consecutiveTokenRefreshFailures?: number;
  /** Unix-epoch ms until which the token-refresh circuit breaker is open, or null. */
  breakerOpenUntil?: number | null;
  /** Unique ID for the current lifecycle attempt (create/restore). Used for
   *  orphan detection if the Vercel Sandbox API later supports tags/list. */
  lifecycleAttemptId?: string | null;
};

export const CURRENT_SCHEMA_VERSION = 3;

export function createDefaultMeta(now: number, gatewayToken: string): SingleMeta {
  return {
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    snapshotConfigHash: null,
    openclawVersion: null,
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
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
      lastSyncAppliedAt: null,
      lastSyncFailedAt: null,
      lastSyncReason: null,
      lastIngestionSkipReason: null,
      ingestionSkipCount: 0,
      lastIngestOutcome: null,
      lastSyncOutcome: null,
    },
    lastTokenRefreshAt: null,
    channels: createDefaultChannelConfigs(),
    snapshotHistory: [],
    lastRestoreMetrics: null,
    restoreHistory: [],
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
    version:
      typeof raw.version === "number" &&
      Number.isSafeInteger(raw.version) &&
      raw.version >= 1
        ? raw.version
        : 1,
    id: "openclaw-single",
    sandboxId: typeof raw.sandboxId === "string" ? raw.sandboxId : null,
    snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : null,
    snapshotConfigHash:
      typeof (raw as Record<string, unknown>).snapshotConfigHash === "string"
        ? (raw as Record<string, unknown>).snapshotConfigHash as string
        : null,
    openclawVersion:
      typeof raw.openclawVersion === "string" ? raw.openclawVersion : null,
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
      learningStartedAt:
        typeof (raw.firewall as Record<string, unknown>)?.learningStartedAt === "number"
          ? (raw.firewall as Record<string, unknown>).learningStartedAt as number
          : null,
      commandsObserved:
        typeof (raw.firewall as Record<string, unknown>)?.commandsObserved === "number"
          ? (raw.firewall as Record<string, unknown>).commandsObserved as number
          : 0,
      wouldBlock: [],
      lastSyncAppliedAt:
        typeof (raw.firewall as Record<string, unknown>)?.lastSyncAppliedAt === "number"
          ? (raw.firewall as Record<string, unknown>).lastSyncAppliedAt as number
          : null,
      lastSyncFailedAt:
        typeof (raw.firewall as Record<string, unknown>)?.lastSyncFailedAt === "number"
          ? (raw.firewall as Record<string, unknown>).lastSyncFailedAt as number
          : null,
      lastSyncReason:
        typeof (raw.firewall as Record<string, unknown>)?.lastSyncReason === "string"
          ? (raw.firewall as Record<string, unknown>).lastSyncReason as string
          : null,
      lastIngestionSkipReason:
        typeof (raw.firewall as Record<string, unknown>)?.lastIngestionSkipReason === "string"
          ? (raw.firewall as Record<string, unknown>).lastIngestionSkipReason as string
          : null,
      ingestionSkipCount:
        typeof (raw.firewall as Record<string, unknown>)?.ingestionSkipCount === "number"
          ? (raw.firewall as Record<string, unknown>).ingestionSkipCount as number
          : 0,
      lastIngestOutcome: isFirewallIngestOutcome(
        (raw.firewall as Record<string, unknown>)?.lastIngestOutcome,
      )
        ? ((raw.firewall as Record<string, unknown>).lastIngestOutcome as FirewallIngestOutcome)
        : null,
      lastSyncOutcome: isFirewallSyncOutcome(
        (raw.firewall as Record<string, unknown>)?.lastSyncOutcome,
      )
        ? ((raw.firewall as Record<string, unknown>).lastSyncOutcome as FirewallSyncOutcome)
        : null,
    },
    lastTokenRefreshAt:
      typeof raw.lastTokenRefreshAt === "number" ? raw.lastTokenRefreshAt : null,
    channels: ensureChannelConfigs(raw.channels),
    snapshotHistory: Array.isArray((raw as Record<string, unknown>).snapshotHistory)
      ? ((raw as Record<string, unknown>).snapshotHistory as unknown[]).filter(isSnapshotRecord)
      : [],
    lastRestoreMetrics: isRestorePhaseMetrics(
      (raw as Record<string, unknown>).lastRestoreMetrics,
    )
      ? ((raw as Record<string, unknown>).lastRestoreMetrics as RestorePhaseMetrics)
      : null,
    restoreHistory: Array.isArray((raw as Record<string, unknown>).restoreHistory)
      ? ((raw as Record<string, unknown>).restoreHistory as unknown[])
          .filter(isRestorePhaseMetrics)
          .slice(0, MAX_RESTORE_HISTORY) as RestorePhaseMetrics[]
      : [],
    lastTokenExpiresAt:
      typeof (raw as Record<string, unknown>).lastTokenExpiresAt === "number"
        ? (raw as Record<string, unknown>).lastTokenExpiresAt as number
        : null,
    lastTokenSource:
      ((raw as Record<string, unknown>).lastTokenSource === "oidc" ||
        (raw as Record<string, unknown>).lastTokenSource === "api-key")
        ? (raw as Record<string, unknown>).lastTokenSource as "oidc" | "api-key"
        : null,
    lastTokenRefreshError:
      typeof (raw as Record<string, unknown>).lastTokenRefreshError === "string"
        ? (raw as Record<string, unknown>).lastTokenRefreshError as string
        : null,
    consecutiveTokenRefreshFailures:
      typeof (raw as Record<string, unknown>).consecutiveTokenRefreshFailures === "number"
        ? (raw as Record<string, unknown>).consecutiveTokenRefreshFailures as number
        : 0,
    breakerOpenUntil:
      typeof (raw as Record<string, unknown>).breakerOpenUntil === "number"
        ? (raw as Record<string, unknown>).breakerOpenUntil as number
        : null,
  };
}

export const DOMAIN_PRESETS: Record<string, { label: string; domains: string[] }> = {
  npm: {
    label: "npm",
    domains: [
      "registry.npmjs.org",
      "npmjs.org",
      "registry.yarnpkg.com",
      "npm.pkg.github.com",
    ],
  },
  openai: {
    label: "OpenAI",
    domains: [
      "api.openai.com",
      "cdn.openai.com",
      "files.oaiusercontent.com",
    ],
  },
  github: {
    label: "GitHub",
    domains: [
      "github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "objects.githubusercontent.com",
    ],
  },
  vercel: {
    label: "Vercel",
    domains: [
      "vercel.com",
      "api.vercel.com",
      "vercel.live",
      "v0.dev",
    ],
  },
};

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

function isFirewallIngestOutcome(value: unknown): value is FirewallIngestOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "number" &&
    typeof v.durationMs === "number" &&
    typeof v.domainsSeenCount === "number" &&
    typeof v.newCount === "number" &&
    typeof v.updatedCount === "number" &&
    (v.skipReason === null || typeof v.skipReason === "string")
  );
}

function isFirewallSyncOutcome(value: unknown): value is FirewallSyncOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "number" &&
    typeof v.durationMs === "number" &&
    typeof v.allowlistCount === "number" &&
    typeof v.policyHash === "string" &&
    typeof v.applied === "boolean" &&
    typeof v.reason === "string"
  );
}

function isRestorePhaseMetrics(value: unknown): value is RestorePhaseMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sandboxCreateMs === "number" &&
    typeof v.tokenWriteMs === "number" &&
    typeof v.assetSyncMs === "number" &&
    typeof v.startupScriptMs === "number" &&
    typeof v.forcePairMs === "number" &&
    typeof v.firewallSyncMs === "number" &&
    typeof v.localReadyMs === "number" &&
    typeof v.publicReadyMs === "number" &&
    typeof v.totalMs === "number" &&
    typeof v.skippedStaticAssetSync === "boolean" &&
    (v.assetSha256 === null || typeof v.assetSha256 === "string") &&
    typeof v.vcpus === "number" &&
    typeof v.recordedAt === "number"
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

/**
 * Compute a deterministic SHA-256 hash of the firewall policy.
 * Same allowlist + mode always produces the same hash.
 */
export function computePolicyHash(mode: FirewallMode, allowlist: string[]): string {
  const sorted = [...allowlist].sort((a, b) => a.localeCompare(b));
  const input = JSON.stringify({ mode, allowlist: sorted });
  return createHash("sha256").update(input).digest("hex");
}
