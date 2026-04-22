import { createHash } from "node:crypto";

import {
  createDefaultChannelConfigs,
  ensureChannelConfigs,
  type ChannelConfigs,
  type ChannelName,
} from "@/shared/channels";

export const DEFAULT_OPENCLAW_INSTANCE_ID = "openclaw-single";
export const INSTANCE_ID_OVERRIDE_GLOBAL_KEY = "__openclawInstanceIdOverrideForTesting";

export function resolveOpenclawInstanceId(raw: string | null | undefined): string {
  if (raw == null) {
    return DEFAULT_OPENCLAW_INSTANCE_ID;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("OPENCLAW_INSTANCE_ID must not be blank.");
  }
  if (trimmed.includes(":")) {
    throw new Error("OPENCLAW_INSTANCE_ID must not contain ':'.");
  }

  return trimmed;
}

export function getDefaultOpenclawInstanceId(): string {
  return resolveOpenclawInstanceId(
    (
      globalThis as typeof globalThis & {
        [INSTANCE_ID_OVERRIDE_GLOBAL_KEY]?: string | null;
      }
    )[INSTANCE_ID_OVERRIDE_GLOBAL_KEY] ??
      process.env.OPENCLAW_INSTANCE_ID ??
      process.env.VERCEL_PROJECT_ID,
  );
}

export type FirewallMode = "disabled" | "learning" | "enforcing";

export type SingleStatus =
  | "uninitialized"
  | "creating"
  | "setup"
  | "running"
  | "snapshotting"
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
  | "channel.whatsapp.webhook"
  | "channel.queue.consumer";

export type OperationContext = {
  opId: string;
  parentOpId: string | null;
  trigger: OperationTrigger;
  reason: string;
  requestId: string | null;
  channel: ChannelName | null;
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

export type LogTimestampKind = "exact" | "untimed";

export type LogEntry = {
  id: string;
  timestamp: number;
  timestampKind?: LogTimestampKind;
  sourceOrder?: number;
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

// ---------------------------------------------------------------------------
// Restore target truth types
// ---------------------------------------------------------------------------

export type RestorePreparedStatus =
  | "unknown"
  | "dirty"
  | "preparing"
  | "ready"
  | "failed";

export type RestorePreparedReason =
  | "snapshot-missing"
  | "dynamic-config-changed"
  | "static-assets-changed"
  | "deployment-changed"
  | "manual-reset"
  | "prepare-failed"
  | "prepared";

// ---------------------------------------------------------------------------
// Restore oracle types
// ---------------------------------------------------------------------------

export type RestoreOracleStatus =
  | "idle"
  | "pending"
  | "running"
  | "blocked"
  | "failed"
  | "ready";

export type RestoreOracleLastResult =
  | "already-ready"
  | "prepared"
  | "blocked"
  | "failed";

export type RestoreOracleState = {
  status: RestoreOracleStatus;
  pendingReason: RestorePreparedReason | null;
  lastEvaluatedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastBlockedReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastResult: RestoreOracleLastResult | null;
};

// ---------------------------------------------------------------------------
// Hot-spare sandbox state (feature-flagged, disabled by default)
// ---------------------------------------------------------------------------

export type HotSpareStatus =
  | "idle"
  | "creating"
  | "ready"
  | "promoting"
  | "failed";

export type HotSpareState = {
  status: HotSpareStatus;
  /** Sandbox ID of the pre-created candidate, or null. */
  candidateSandboxId: string | null;
  /** Port URLs resolved from the candidate sandbox. */
  candidatePortUrls: Record<string, string> | null;
  /** Snapshot ID the candidate was created from. */
  candidateSourceSnapshotId: string | null;
  /** Dynamic config hash at candidate creation time. */
  candidateDynamicConfigHash: string | null;
  /** Asset SHA-256 at candidate creation time. */
  candidateAssetSha256: string | null;
  /** Unix-epoch ms when the candidate was created. */
  createdAt: number | null;
  /** Unix-epoch ms when the candidate was marked ready. */
  preparedAt: number | null;
  /** Error message from the last failed attempt. */
  lastError: string | null;
  /** Unix-epoch ms of the last status change. */
  updatedAt: number | null;
};

export type CronRestoreOutcome =
  | "no-store-jobs"
  | "already-present"
  | "restored-verified"
  | "restore-failed"
  | "restore-unverified"
  | "store-invalid";

/**
 * Credentials for OpenClaw's openai-codex provider.
 *
 * Presence of this field activates the Codex provider inside the sandbox;
 * absence falls back to the AI Gateway broker. Refresh tokens are rotated
 * by the OpenAI auth service on every refresh, so this record is treated
 * as the single source of truth and rewritten atomically.
 */
export type CodexCredentials = {
  /** Short-lived OAuth access token (JWT, typically ~1 hour TTL). */
  access: string;
  /** Long-lived OAuth refresh token (~30 days), rotated on every refresh. */
  refresh: string;
  /** Absolute ms-since-epoch when the access token expires. */
  expires: number;
  /** Optional chatgpt_account_id claim extracted from the access token. */
  accountId?: string | null;
  /** Ms-since-epoch when this record was last written to meta. */
  updatedAt: number;
};

/**
 * Structured record persisted to the store as `CRON_JOBS_KEY`.
 * Wraps the raw jobs.json with metadata for change detection,
 * staleness checks, and partial-loss detection.
 */
export type StoredCronRecord = {
  /** Schema version for forward compatibility. */
  version: 1;
  /** When this record was captured (ms since epoch). */
  capturedAt: number;
  /** Which path wrote this record. */
  source: "stop" | "heartbeat";
  /** SHA-256 of the raw jobsJson for cheap equality checks. */
  sha256: string;
  /** Number of jobs at capture time. */
  jobCount: number;
  /** Sorted job IDs for semantic identity comparison. */
  jobIds: string[];
  /** The raw jobs.json content (the actual payload to restore). */
  jobsJson: string;
};

export type RestorePhaseMetrics = {
  sandboxCreateMs: number;
  tokenWriteMs: number;
  assetSyncMs: number;
  startupScriptMs: number;
  forcePairMs: number;
  firewallSyncMs: number;
  localReadyMs: number;
  /** Wall-clock ms spent after local readiness before restore returned. */
  postLocalReadyBlockingMs?: number;
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
  /** Outcome of the post-restore cron jobs recovery flow. */
  cronRestoreOutcome?: CronRestoreOutcome;
  /** Whether a hot-spare candidate was successfully promoted for this restore. */
  hotSpareHit?: boolean;
  /** Wall-clock ms for the hot-spare promotion (0 when no hit). */
  hotSparePromotionMs?: number;
  /** Reason the hot-spare was rejected, or null on hit. */
  hotSpareRejectReason?: string | null;
  /** Whether Telegram config was expected during restore. */
  telegramExpected?: boolean;
  /** Whether the restored sandbox config contained channels.telegram. */
  telegramConfigPresent?: boolean;
  /** Whether the Telegram listener was confirmed ready during restore. */
  telegramListenerReady?: boolean;
  /** HTTP status observed from the in-sandbox Telegram probe, if any. */
  telegramListenerStatus?: number | null;
  /** Wall-clock ms spent waiting for the Telegram listener probe. */
  telegramListenerWaitMs?: number | null;
  /** Error from the Telegram listener probe, if any. */
  telegramListenerError?: string | null;
  /** Whether synchronous Telegram webhook reconcile ran on the blocking path. */
  telegramReconcileBlocking?: boolean;
  /** Wall-clock ms spent in synchronous Telegram webhook reconcile, if any. */
  telegramReconcileMs?: number | null;
  /** Whether Telegram secret sync ran on the blocking path. */
  telegramSecretSyncBlocking?: boolean;
  /** Wall-clock ms spent in synchronous Telegram secret sync, if any. */
  telegramSecretSyncMs?: number | null;
};

/**
 * Maximum number of restore history entries retained in metadata.
 * Older entries are dropped on every persist to keep state bounded.
 */
export const MAX_RESTORE_HISTORY = 50;

export type SingleMeta = {
  _schemaVersion: number;
  version: number;
  id: string;
  sandboxId: string | null;
  snapshotId: string | null;
  /** @deprecated Legacy hash — kept for backward hydration only. Use
   *  snapshotDynamicConfigHash / runtimeDynamicConfigHash instead. */
  snapshotConfigHash: string | null;

  /** SHA-256 of the gateway config baked into the most recent snapshot image.
   *  Only set by actual snapshot-creation paths. */
  snapshotDynamicConfigHash: string | null;
  /** SHA-256 of the gateway config currently on the running sandbox.
   *  Updated by runtime reconciliation — never used for restore skip gates. */
  runtimeDynamicConfigHash: string | null;
  /** SHA-256 of static restore assets in the most recent snapshot image. */
  snapshotAssetSha256: string | null;
  /** SHA-256 of static restore assets on the running sandbox. */
  runtimeAssetSha256: string | null;

  /** Whether the next restore target is verified-ready. */
  restorePreparedStatus: RestorePreparedStatus;
  /** Reason for the current restorePreparedStatus. */
  restorePreparedReason: RestorePreparedReason | null;
  /** Unix-epoch ms when restorePreparedStatus was last set to "ready". */
  restorePreparedAt: number | null;
  openclawVersion: string | null;
  status: SingleStatus;
  gatewayToken: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  lastGatewayProbeAt?: number | null;
  lastGatewayProbeReady?: boolean | null;
  lastGatewayProbeSandboxId?: string | null;
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
  /** Persistent state for the restore oracle autopilot loop. */
  restoreOracle: RestoreOracleState;
  /** Optional hot-spare sandbox candidate state (feature-flagged, disabled by default). */
  hotSpare?: HotSpareState;
  /** OpenClaw Codex provider credentials. When present, the sandbox uses
   *  the openai-codex provider instead of the AI Gateway broker. */
  codexCredentials?: CodexCredentials | null;
};

export const CURRENT_SCHEMA_VERSION = 3;

export function createDefaultMeta(
  now: number,
  gatewayToken: string,
  instanceId = getDefaultOpenclawInstanceId(),
): SingleMeta {
  return {
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    version: 1,
    id: instanceId,
    sandboxId: null,
    snapshotId: null,
    snapshotConfigHash: null,
    snapshotDynamicConfigHash: null,
    runtimeDynamicConfigHash: null,
    snapshotAssetSha256: null,
    runtimeAssetSha256: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    restorePreparedAt: null,
    openclawVersion: null,
    status: "uninitialized",
    gatewayToken,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    lastGatewayProbeAt: null,
    lastGatewayProbeReady: null,
    lastGatewayProbeSandboxId: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: ["ai-gateway.vercel.sh"],
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
    lifecycleAttemptId: null,
    restoreOracle: {
      status: "idle",
      pendingReason: null,
      lastEvaluatedAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastBlockedReason: null,
      lastError: null,
      consecutiveFailures: 0,
      lastResult: null,
    },
  };
}

export function ensureMetaShape(
  input: unknown,
  expectedInstanceId = getDefaultOpenclawInstanceId(),
): SingleMeta | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const raw = input as Partial<SingleMeta> & {
    firewall?: Partial<FirewallState>;
  };
  if (typeof raw.id === "string" && raw.id !== expectedInstanceId) {
    throw new Error(
      `Refusing to hydrate meta for instance "${raw.id}" while expecting "${expectedInstanceId}".`,
    );
  }
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
    id: typeof raw.id === "string" ? raw.id : expectedInstanceId,
    sandboxId: typeof raw.sandboxId === "string" ? raw.sandboxId : null,
    snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : null,
    snapshotConfigHash:
      typeof (raw as Record<string, unknown>).snapshotConfigHash === "string"
        ? (raw as Record<string, unknown>).snapshotConfigHash as string
        : null,
    snapshotDynamicConfigHash:
      typeof (raw as Record<string, unknown>).snapshotDynamicConfigHash === "string"
        ? (raw as Record<string, unknown>).snapshotDynamicConfigHash as string
        : typeof (raw as Record<string, unknown>).snapshotConfigHash === "string"
          ? (raw as Record<string, unknown>).snapshotConfigHash as string
          : null,
    runtimeDynamicConfigHash:
      typeof (raw as Record<string, unknown>).runtimeDynamicConfigHash === "string"
        ? (raw as Record<string, unknown>).runtimeDynamicConfigHash as string
        : null,
    snapshotAssetSha256:
      typeof (raw as Record<string, unknown>).snapshotAssetSha256 === "string"
        ? (raw as Record<string, unknown>).snapshotAssetSha256 as string
        : null,
    runtimeAssetSha256:
      typeof (raw as Record<string, unknown>).runtimeAssetSha256 === "string"
        ? (raw as Record<string, unknown>).runtimeAssetSha256 as string
        : null,
    restorePreparedStatus:
      isRestorePreparedStatus((raw as Record<string, unknown>).restorePreparedStatus)
        ? (raw as Record<string, unknown>).restorePreparedStatus as RestorePreparedStatus
        : "unknown",
    restorePreparedReason:
      isRestorePreparedReason((raw as Record<string, unknown>).restorePreparedReason)
        ? (raw as Record<string, unknown>).restorePreparedReason as RestorePreparedReason
        : null,
    restorePreparedAt:
      typeof (raw as Record<string, unknown>).restorePreparedAt === "number"
        ? (raw as Record<string, unknown>).restorePreparedAt as number
        : null,
    openclawVersion:
      typeof raw.openclawVersion === "string" ? raw.openclawVersion : null,
    status: isSingleStatus(raw.status) ? raw.status : "uninitialized",
    gatewayToken: typeof raw.gatewayToken === "string" ? raw.gatewayToken : "",
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
    lastAccessedAt:
      typeof raw.lastAccessedAt === "number" ? raw.lastAccessedAt : null,
    lastGatewayProbeAt:
      typeof (raw as Record<string, unknown>).lastGatewayProbeAt === "number"
        ? (raw as Record<string, unknown>).lastGatewayProbeAt as number
        : null,
    lastGatewayProbeReady:
      typeof (raw as Record<string, unknown>).lastGatewayProbeReady === "boolean"
        ? (raw as Record<string, unknown>).lastGatewayProbeReady as boolean
        : null,
    lastGatewayProbeSandboxId:
      typeof (raw as Record<string, unknown>).lastGatewayProbeSandboxId === "string"
        ? (raw as Record<string, unknown>).lastGatewayProbeSandboxId as string
        : null,
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
    lifecycleAttemptId:
      typeof (raw as Record<string, unknown>).lifecycleAttemptId === "string"
        ? (raw as Record<string, unknown>).lifecycleAttemptId as string
        : null,
    restoreOracle: ensureRestoreOracleState(
      (raw as Record<string, unknown>).restoreOracle,
    ),
    ...((raw as Record<string, unknown>).hotSpare
      ? { hotSpare: ensureHotSpareState((raw as Record<string, unknown>).hotSpare) }
      : {}),
    ...(isCodexCredentials((raw as Record<string, unknown>).codexCredentials)
      ? {
          codexCredentials: (raw as Record<string, unknown>)
            .codexCredentials as CodexCredentials,
        }
      : {}),
  };
}

function isCodexCredentials(value: unknown): value is CodexCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access === "string" &&
    typeof v.refresh === "string" &&
    typeof v.expires === "number" &&
    typeof v.updatedAt === "number" &&
    (v.accountId === undefined ||
      v.accountId === null ||
      typeof v.accountId === "string")
  );
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
    value === "snapshotting" ||
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
    (v.postLocalReadyBlockingMs === undefined || typeof v.postLocalReadyBlockingMs === "number") &&
    typeof v.publicReadyMs === "number" &&
    typeof v.totalMs === "number" &&
    typeof v.skippedStaticAssetSync === "boolean" &&
    (v.cronRestoreOutcome === undefined || isCronRestoreOutcome(v.cronRestoreOutcome)) &&
    (v.telegramExpected === undefined || typeof v.telegramExpected === "boolean") &&
    (v.telegramConfigPresent === undefined || typeof v.telegramConfigPresent === "boolean") &&
    (v.telegramListenerReady === undefined || typeof v.telegramListenerReady === "boolean") &&
    (v.telegramListenerStatus === undefined || v.telegramListenerStatus === null || typeof v.telegramListenerStatus === "number") &&
    (v.telegramListenerWaitMs === undefined || v.telegramListenerWaitMs === null || typeof v.telegramListenerWaitMs === "number") &&
    (v.telegramListenerError === undefined || v.telegramListenerError === null || typeof v.telegramListenerError === "string") &&
    (v.telegramReconcileBlocking === undefined || typeof v.telegramReconcileBlocking === "boolean") &&
    (v.telegramReconcileMs === undefined || v.telegramReconcileMs === null || typeof v.telegramReconcileMs === "number") &&
    (v.telegramSecretSyncBlocking === undefined || typeof v.telegramSecretSyncBlocking === "boolean") &&
    (v.telegramSecretSyncMs === undefined || v.telegramSecretSyncMs === null || typeof v.telegramSecretSyncMs === "number") &&
    (v.assetSha256 === null || typeof v.assetSha256 === "string") &&
    typeof v.vcpus === "number" &&
    typeof v.recordedAt === "number"
  );
}

const CRON_RESTORE_OUTCOMES: readonly CronRestoreOutcome[] = [
  "no-store-jobs",
  "already-present",
  "restored-verified",
  "restore-failed",
  "restore-unverified",
  "store-invalid",
];

const RESTORE_PREPARED_STATUSES: readonly RestorePreparedStatus[] = [
  "unknown",
  "dirty",
  "preparing",
  "ready",
  "failed",
];

function isRestorePreparedStatus(value: unknown): value is RestorePreparedStatus {
  return (
    typeof value === "string" &&
    RESTORE_PREPARED_STATUSES.includes(value as RestorePreparedStatus)
  );
}

const RESTORE_PREPARED_REASONS: readonly RestorePreparedReason[] = [
  "snapshot-missing",
  "dynamic-config-changed",
  "static-assets-changed",
  "deployment-changed",
  "manual-reset",
  "prepare-failed",
  "prepared",
];

function isRestorePreparedReason(value: unknown): value is RestorePreparedReason {
  return (
    typeof value === "string" &&
    RESTORE_PREPARED_REASONS.includes(value as RestorePreparedReason)
  );
}

const RESTORE_ORACLE_STATUSES: readonly RestoreOracleStatus[] = [
  "idle",
  "pending",
  "running",
  "blocked",
  "failed",
  "ready",
];

function isRestoreOracleStatus(value: unknown): value is RestoreOracleStatus {
  return (
    typeof value === "string" &&
    RESTORE_ORACLE_STATUSES.includes(value as RestoreOracleStatus)
  );
}

const RESTORE_ORACLE_LAST_RESULTS: readonly RestoreOracleLastResult[] = [
  "already-ready",
  "prepared",
  "blocked",
  "failed",
];

function isRestoreOracleLastResult(value: unknown): value is RestoreOracleLastResult {
  return (
    typeof value === "string" &&
    RESTORE_ORACLE_LAST_RESULTS.includes(value as RestoreOracleLastResult)
  );
}

export function ensureRestoreOracleState(value: unknown): RestoreOracleState {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    status: isRestoreOracleStatus(raw.status) ? raw.status : "idle",
    pendingReason: isRestorePreparedReason(raw.pendingReason)
      ? raw.pendingReason
      : null,
    lastEvaluatedAt:
      typeof raw.lastEvaluatedAt === "number" ? raw.lastEvaluatedAt : null,
    lastStartedAt:
      typeof raw.lastStartedAt === "number" ? raw.lastStartedAt : null,
    lastCompletedAt:
      typeof raw.lastCompletedAt === "number" ? raw.lastCompletedAt : null,
    lastBlockedReason:
      typeof raw.lastBlockedReason === "string" ? raw.lastBlockedReason : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    consecutiveFailures:
      typeof raw.consecutiveFailures === "number"
        ? raw.consecutiveFailures
        : 0,
    lastResult: isRestoreOracleLastResult(raw.lastResult)
      ? raw.lastResult
      : null,
  };
}

// ---------------------------------------------------------------------------
// Hot-spare state hydration
// ---------------------------------------------------------------------------

const VALID_HOT_SPARE_STATUSES = new Set<string>([
  "idle", "creating", "ready", "promoting", "failed",
]);

function isHotSpareStatus(value: unknown): value is HotSpareStatus {
  return typeof value === "string" && VALID_HOT_SPARE_STATUSES.has(value);
}

export function createDefaultHotSpareState(): HotSpareState {
  return {
    status: "idle",
    candidateSandboxId: null,
    candidatePortUrls: null,
    candidateSourceSnapshotId: null,
    candidateDynamicConfigHash: null,
    candidateAssetSha256: null,
    createdAt: null,
    preparedAt: null,
    lastError: null,
    updatedAt: null,
  };
}

export function ensureHotSpareState(raw: unknown): HotSpareState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultHotSpareState();
  }
  const obj = raw as Record<string, unknown>;
  return {
    status: isHotSpareStatus(obj.status) ? obj.status : "idle",
    candidateSandboxId:
      typeof obj.candidateSandboxId === "string"
        ? obj.candidateSandboxId
        : null,
    candidatePortUrls:
      obj.candidatePortUrls &&
      typeof obj.candidatePortUrls === "object" &&
      !Array.isArray(obj.candidatePortUrls)
        ? (obj.candidatePortUrls as Record<string, string>)
        : null,
    candidateSourceSnapshotId:
      typeof obj.candidateSourceSnapshotId === "string"
        ? obj.candidateSourceSnapshotId
        : null,
    candidateDynamicConfigHash:
      typeof obj.candidateDynamicConfigHash === "string"
        ? obj.candidateDynamicConfigHash
        : null,
    candidateAssetSha256:
      typeof obj.candidateAssetSha256 === "string"
        ? obj.candidateAssetSha256
        : null,
    createdAt:
      typeof obj.createdAt === "number" ? obj.createdAt : null,
    preparedAt:
      typeof obj.preparedAt === "number" ? obj.preparedAt : null,
    lastError:
      typeof obj.lastError === "string" ? obj.lastError : null,
    updatedAt:
      typeof obj.updatedAt === "number" ? obj.updatedAt : null,
  };
}

function isCronRestoreOutcome(value: unknown): value is CronRestoreOutcome {
  return (
    typeof value === "string"
    && CRON_RESTORE_OUTCOMES.includes(value as CronRestoreOutcome)
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
