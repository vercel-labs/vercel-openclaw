import { createHash, randomUUID } from "node:crypto";

import { pollUntil } from "@/server/async/poll";
import { ApiError } from "@/shared/http";
import type {
  CronRestoreOutcome,
  OperationContext,
  RestorePhaseMetrics,
  RestorePreparedReason,
  SingleMeta,
  StoredCronRecord,
} from "@/shared/types";
import { MAX_RESTORE_HISTORY } from "@/shared/types";
import {
  withOperationContext,
} from "@/server/observability/operation-context";
import { logStateSnapshot } from "@/server/observability/state-snapshot";
import {
  getAiGatewayBearerTokenOptional,
  resolveAiGatewayCredentialOptional,
  isVercelDeployment,
} from "@/server/env";
import { applyFirewallPolicyToSandbox, toNetworkPolicy } from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { setupOpenClaw, CommandFailedError } from "@/server/openclaw/bootstrap";
import {
  computeGatewayConfigHash,
  GATEWAY_CONFIG_HASH_VERSION,
  OPENCLAW_BIN,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_LOG_FILE,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
  toWhatsAppGatewayConfig,
  type GatewayConfigHashInput,
} from "@/server/openclaw/config";
import {
  OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  buildDynamicRestoreFiles,
  buildRestoreAssetManifest,
  buildRestoreRuntimeEnv,
  buildStaticRestoreFiles,
  buildWorkerSandboxRestoreFiles,
  type RestoreAssetManifest,
} from "@/server/openclaw/restore-assets";
import { buildRestoreDecision } from "@/server/sandbox/restore-attestation";
import type { RestoreDecision } from "@/shared/restore-decision";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import { getSandboxController } from "@/server/sandbox/controller";
import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  SetupProgressWriter,
  beginSetupProgress,
  clearSetupProgress,
} from "@/server/sandbox/setup-progress";
import { getSandboxVcpus } from "@/server/sandbox/resources";
import {
  deleteVercelSnapshot,
  isSnapshotNotFoundError,
} from "@/server/sandbox/snapshot-delete";
import {
  getSandboxSleepAfterMs,
  getSandboxTouchThrottleMs,
} from "@/server/sandbox/timeout";
import {
  getStore,
  getInitializedMeta,
  mutateMeta,
  wait,
} from "@/server/store/store";
import {
  cronJobsKey,
  cronNextWakeKey,
  lifecycleLockKey,
  startLockKey,
  tokenRefreshLockKey,
} from "@/server/store/keyspace";
import {
  isHotSpareEnabled,
  preCreateHotSpare,
  preCreateHotSpareFromSnapshot,
  evaluateHotSparePromotion,
  promoteHotSpare,
  applyPreCreateToMeta,
  applyPromoteToMeta,
  clearHotSpareState,
} from "@/server/sandbox/hot-spare";

const OPENCLAW_PORT = 3000;
const SANDBOX_PORTS = [OPENCLAW_PORT, OPENCLAW_TELEGRAM_WEBHOOK_PORT];
export function CRON_NEXT_WAKE_KEY(): string {
  return cronNextWakeKey();
}

export function CRON_JOBS_KEY(): string {
  return cronJobsKey();
}
const CRON_JOBS_PATH = `${OPENCLAW_STATE_DIR}/cron/jobs.json`;
const CRON_JOBS_MAX_BYTES = 256 * 1024; // 256 KB size cap for store value

/** Build a structured cron record from raw jobs JSON. Returns null if invalid. */
function buildCronRecord(
  rawJobsJson: string,
  source: "stop" | "heartbeat",
): StoredCronRecord | null {
  try {
    const parsed = JSON.parse(rawJobsJson) as {
      jobs?: Array<{ id?: string; enabled?: boolean }>;
    };
    if (!Array.isArray(parsed.jobs) || parsed.jobs.length === 0) return null;
    if (rawJobsJson.length > CRON_JOBS_MAX_BYTES) return null;
    return {
      version: 1,
      capturedAt: Date.now(),
      source,
      sha256: createHash("sha256").update(rawJobsJson).digest("hex"),
      jobCount: parsed.jobs.length,
      jobIds: parsed.jobs.map((j) => j.id ?? "").filter(Boolean).sort(),
      jobsJson: rawJobsJson,
    };
  } catch {
    return null;
  }
}

/** Parse a stored cron record, handling both structured and legacy raw string formats. */
function parseStoredCronRecord(
  raw: unknown,
): StoredCronRecord | null {
  if (!raw) return null;
  // Structured record (has version field)
  if (typeof raw === "object" && raw !== null && "version" in raw && "jobsJson" in raw) {
    return raw as StoredCronRecord;
  }
  // Legacy: raw string or Upstash-deserialized object without version field
  let jobsJson: string;
  if (typeof raw === "string") {
    jobsJson = raw;
  } else if (typeof raw === "object" && raw !== null && "jobs" in raw) {
    // Upstash double-deserialized the old raw string into an object
    jobsJson = JSON.stringify(raw);
  } else {
    return null;
  }
  // Wrap legacy format into a structured record for uniform handling
  return buildCronRecord(jobsJson, "stop") ?? null;
}

const LIFECYCLE_LOCK_TTL_SECONDS = 20 * 60;
const START_LOCK_TTL_SECONDS = 15 * 60;
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 60;
const LOCK_RENEW_INTERVAL_MS = 30_000;
const STALE_OPERATION_MS = 5 * 60 * 1000;
const READY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const READY_WAIT_POLL_MS = 1_000;

/** Default TTL safety window — refresh when remaining TTL <= 10 minutes. */
const DEFAULT_MIN_REMAINING_MS = 10 * 60 * 1000;
/** Circuit breaker: open after this many consecutive failures. */
const BREAKER_FAILURE_THRESHOLD = 3;
/** Circuit breaker: keep open for 30 seconds. */
const BREAKER_OPEN_DURATION_MS = 30_000;
/** Maximum time to wait for a contended token refresh lock (ms). */
const TOKEN_REFRESH_LOCK_WAIT_MS = 5_000;
/** Poll interval while waiting for contended token refresh lock. */
const TOKEN_REFRESH_LOCK_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Gateway restart helper
// ---------------------------------------------------------------------------

/**
 * Kill the running gateway and launch a new one via the on-disk restart script.
 * The script reads tokens from disk and uses setsid to background the gateway.
 */
async function restartGateway(
  sandbox: SandboxHandle,
): Promise<void> {
  const result = await sandbox.runCommand("bash", [OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH]);
  if (result.exitCode !== 0) {
    throw new CommandFailedError({
      command: "bash restart-gateway",
      exitCode: result.exitCode,
      output: await result.output("both"),
    });
  }
}

export type BackgroundScheduler = (callback: () => Promise<void> | void) => void;

export type CronWakeReadResult =
  | { status: "ok"; nextWakeMs: number; rawJobsJson: string }
  | { status: "no-jobs"; rawJobsJson?: string }
  | { status: "error"; error: string };

type AutoRenewedLockOptions = {
  key: string;
  token: string;
  ttlSeconds: number;
  label: string;
};

class LifecycleLockUnavailableError extends Error {
  constructor() {
    super("Sandbox lifecycle lock unavailable.");
    this.name = "LifecycleLockUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Structured result types for token refresh
// ---------------------------------------------------------------------------

export type TokenRefreshResult = {
  refreshed: boolean;
  reason: string;
  credential?: { token: string; source: string; expiresAt: number | null } | null;
  retryAfterMs?: number;
};

export type EnsureUsableCredentialOptions = {
  /** Minimum remaining TTL in ms before a refresh is triggered (default: 600000 = 10 min). */
  minRemainingMs?: number;
  /** Force refresh regardless of TTL or throttle. */
  force?: boolean;
  /** When true, treat missing credential as an error (used during boot on Vercel). */
  required?: boolean;
  /** Human-readable reason for logging. */
  reason?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureSandboxRunning(options: {
  origin: string;
  reason: string;
  schedule?: BackgroundScheduler;
  op?: OperationContext;
}): Promise<{ state: "running" | "waiting"; meta: SingleMeta }> {
  const meta = await getInitializedMeta();
  const opCtx = options.op ? withOperationContext(options.op, {
    sandboxId: meta.sandboxId,
    snapshotId: meta.snapshotId,
    status: meta.status,
  }) : { reason: options.reason, status: meta.status };
  logInfo("sandbox.ensure_running", opCtx);

  if (meta.status === "running" && meta.sandboxId) {
    return { state: "running", meta };
  }

  if (isBusyStatus(meta.status)) {
    if (isOperationStale(meta)) {
      logWarn("sandbox.stale_operation", options.op
        ? withOperationContext(options.op, { status: meta.status, updatedAt: meta.updatedAt })
        : { status: meta.status, updatedAt: meta.updatedAt });
      await scheduleLifecycleWork({ ...options, meta });
    } else if (options.op) {
      logInfo("sandbox.ensure_running.busy_waiting", withOperationContext(options.op, {
        status: meta.status,
        action: "waiting",
      }));
    }
    return { state: "waiting", meta };
  }

  const action = meta.snapshotId && meta.status !== "uninitialized" ? "restore" : "create";
  if (options.op) {
    logInfo("sandbox.ensure_running.scheduling", withOperationContext(options.op, {
      action,
      statusBefore: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
    }));
  }

  await scheduleLifecycleWork({ ...options, meta });
  return { state: "waiting", meta: await getInitializedMeta() };
}

export type SandboxReadyAction =
  | "already-running"
  | "created-or-restored"
  | "recovered-stale-running";

export type WaitForSandboxReadyOptions = {
  origin: string;
  reason: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  reconcile?: boolean;
  op?: OperationContext;
};

export type WaitForSandboxReadyResult = {
  meta: SingleMeta;
  readyAction: SandboxReadyAction;
};

export type ResetSandboxOptions = {
  origin: string;
  reason: string;
  op?: OperationContext;
};

export type ResetSandboxDeps = {
  deleteSnapshot?: (snapshotId: string) => Promise<void>;
};

export async function waitForSandboxReady(
  options: WaitForSandboxReadyOptions,
): Promise<WaitForSandboxReadyResult> {
  const timeoutMs = options.timeoutMs ?? READY_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? READY_WAIT_POLL_MS;

  const initialMeta = await getInitializedMeta();
  const wasRunningInitially =
    initialMeta.status === "running" && Boolean(initialMeta.sandboxId);

  let recoveredStaleRunning = false;

  function resolveAction(): SandboxReadyAction {
    if (recoveredStaleRunning) return "recovered-stale-running";
    if (wasRunningInitially) return "already-running";
    return "created-or-restored";
  }

  // Optional reconciliation pre-step
  if (options.reconcile) {
    const health = await reconcileSandboxHealth({
      origin: options.origin,
      reason: options.reason,
      op: options.op,
    });

    recoveredStaleRunning = health.repaired;

    if (health.meta.status === "error") {
      throw new ApiError(
        502,
        "SANDBOX_READY_FAILED",
        `Sandbox entered error state while reconciling: ${health.meta.lastError ?? "unknown"}.`,
      );
    }

    if (health.status === "ready") {
      return {
        meta: await getInitializedMeta(),
        readyAction: resolveAction(),
      };
    }
  }

  return pollUntil<WaitForSandboxReadyResult, SingleMeta>({
    label: "sandbox.ready",
    timeoutMs,
    initialDelayMs: pollIntervalMs,
    state: initialMeta,
    step: async () => {
      const result = await ensureSandboxRunning({
        origin: options.origin,
        reason: options.reason,
        op: options.op,
      });

      if (result.meta.status === "error") {
        throw new ApiError(
          502,
          "SANDBOX_READY_FAILED",
          `Sandbox entered error state while waiting for readiness: ${result.meta.lastError ?? "unknown"}.`,
        );
      }

      if ((await probeGatewayReady()).ready) {
        return {
          done: true,
          result: {
            meta: await getInitializedMeta(),
            readyAction: resolveAction(),
          },
        };
      }

      return {
        done: false,
        state: await getInitializedMeta(),
        delayMs: pollIntervalMs,
      };
    },
    timeoutError: ({ state }) =>
      new ApiError(
        504,
        "SANDBOX_READY_TIMEOUT",
        `Sandbox did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds (last status: ${state?.status ?? "unknown"}).`,
      ),
  });
}

export async function ensureSandboxReady(options: {
  origin: string;
  reason: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  op?: OperationContext;
}): Promise<SingleMeta> {
  const result = await waitForSandboxReady({ ...options, reconcile: true });
  return result.meta;
}

export async function resetSandbox(
  options: ResetSandboxOptions,
  deps: ResetSandboxDeps = {},
): Promise<SingleMeta> {
  const deleteSnapshot = deps.deleteSnapshot ?? deleteVercelSnapshot;
  const ctx = (extra: Record<string, unknown> = {}) =>
    options.op
      ? withOperationContext(options.op, extra)
      : { reason: options.reason, ...extra };

  logInfo("sandbox.reset_requested", ctx());

  try {
    return await withLifecycleLock(async () => {
      const current = await getInitializedMeta();
      const snapshotIds = collectTrackedSnapshotIds(current);

      logInfo("sandbox.reset.start", ctx({
        status: current.status,
        sandboxId: current.sandboxId,
        snapshotCount: snapshotIds.length,
      }));

      await destroyCurrentSandboxWithoutSnapshot(current, ctx);
      const failedSnapshotIds = await deleteTrackedSnapshotsForReset(
        snapshotIds,
        deleteSnapshot,
        ctx,
      );
      await clearResetCronState(ctx);

      if (failedSnapshotIds.length > 0) {
        const errorMessage =
          `Sandbox reset failed while deleting snapshots: ${failedSnapshotIds.join(", ")}`;

        const failedIdSet = new Set(failedSnapshotIds);
        const failedSnapshotHistory = current.snapshotHistory.filter((record) =>
          failedIdSet.has(record.snapshotId),
        );
        await mutateMeta((meta) => {
          clearSandboxRuntimeStateForReset(meta);
          meta.status = "error";
          meta.lastError = errorMessage;
          meta.snapshotId =
            current.snapshotId && failedIdSet.has(current.snapshotId)
              ? current.snapshotId
              : null;
          meta.snapshotHistory = failedSnapshotHistory;
        });

        logError("sandbox.reset.snapshot_delete_failed", ctx({
          failedSnapshotIds,
          attemptedSnapshotIds: snapshotIds,
        }));
        return getInitializedMeta();
      }

      const resetMeta = await mutateMeta((meta) => {
        clearSandboxRuntimeStateForReset(meta);
        meta.status = "uninitialized";
        meta.lastError = null;
      });

      logInfo("sandbox.reset.completed", ctx({
        status: resetMeta.status,
        snapshotCount: snapshotIds.length,
      }));

      return resetMeta;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LifecycleLockUnavailableError) {
      logInfo("sandbox.reset.lifecycle_lock_contended", ctx({ error: message }));
      throw error;
    }

    logError("sandbox.reset_failed", ctx({ error: message }));
    try {
      await mutateMeta((meta) => {
        clearSandboxRuntimeStateForReset(meta);
        meta.status = "error";
        meta.lastError = `Sandbox reset failed: ${message}`;
      });
    } catch (metaError) {
      logWarn("sandbox.reset.meta_update_failed", ctx({
        error: message,
        metaError: metaError instanceof Error ? metaError.message : String(metaError),
      }));
    }
    throw error;
  }
}

async function cleanupBeforeSnapshot(
  sandbox: SandboxHandle,
  firewallMode: SingleMeta["firewall"]["mode"],
): Promise<void> {
  logInfo("openclaw.pre_snapshot_cleanup", { sandboxId: sandbox.sandboxId });

  const cleanupCommands = [
    `rm -f ${OPENCLAW_LOG_FILE} || true`,
    "rm -rf /tmp/openclaw || true",
    "rm -rf /home/vercel-sandbox/.npm || true",
    "rm -rf /root/.npm || true",
    "rm -rf /tmp/openclaw-npm-cache || true",
  ];

  if (firewallMode !== "learning") {
    cleanupCommands.push("rm -f /tmp/shell-commands-for-learning.log || true");
  }

  try {
    const result = await sandbox.runCommand("bash", [
      "-lc",
      cleanupCommands.join("\n"),
    ]);

    if (result.exitCode !== 0) {
      const output = await result.output("both");
      throw new CommandFailedError({
        command: "cleanup-before-snapshot",
        exitCode: result.exitCode,
        output,
      });
    }
  } catch (error) {
    logWarn("openclaw.pre_snapshot_cleanup_failed", {
      sandboxId: sandbox.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Read OpenClaw's cron jobs from the sandbox and return the earliest
 * `nextRunAtMs` across all enabled jobs.  Used to persist a wake-up
 * time in the host store before the sandbox is snapshotted.
 */
async function readCronNextWakeFromSandbox(
  sandbox: SandboxHandle,
): Promise<CronWakeReadResult> {
  try {
    const buf = await sandbox.readFileToBuffer({ path: CRON_JOBS_PATH });
    if (!buf) {
      return { status: "no-jobs" };
    }
    const raw = buf.toString("utf8");
    const data = JSON.parse(raw) as {
      jobs?: Array<{
        enabled?: boolean;
        state?: { nextRunAtMs?: number };
      }>;
    };
    if (!Array.isArray(data.jobs)) {
      const errorMessage = `Invalid cron jobs payload at ${CRON_JOBS_PATH}: missing jobs array.`;
      logWarn("sandbox.cron_next_wake_read_failed", {
        error: errorMessage,
      });
      return { status: "error", error: errorMessage };
    }
    let earliest: number | null = null;
    for (const job of data.jobs) {
      if (job.enabled === false) continue;
      const ms = job.state?.nextRunAtMs;
      if (typeof ms === "number" && ms > 0) {
        if (earliest === null || ms < earliest) earliest = ms;
      }
    }
    if (earliest) {
      logInfo("sandbox.cron_next_wake_read", { earliest, jobCount: data.jobs.length });
      return { status: "ok", nextWakeMs: earliest, rawJobsJson: raw };
    }
    // Return raw even when no wake time — jobs may exist but have no
    // nextRunAtMs yet (e.g. freshly created, not yet scheduled).
    if (data.jobs.length > 0) {
      return { status: "no-jobs", rawJobsJson: raw };
    }
    return { status: "no-jobs" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn("sandbox.cron_next_wake_read_failed", {
      error: errorMessage,
    });
    return { status: "error", error: errorMessage };
  }
}

export async function stopSandbox(): Promise<SingleMeta> {
  logInfo("sandbox.stop_requested");
  return withLifecycleLock(async () => {
    const meta = await getInitializedMeta();
    if (meta.status === "stopped") {
      logInfo("sandbox.already_stopped", { sandboxId: meta.sandboxId });
      return meta;
    }
    if (!meta.sandboxId) {
      throw new ApiError(
        409,
        "SANDBOX_NOT_RUNNING",
        "Sandbox is not running and cannot be stopped.",
      );
    }

    logInfo("sandbox.stopping", { sandboxId: meta.sandboxId });
    try {
      const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
      await cleanupBeforeSnapshot(sandbox, meta.firewall.mode);
      const cronWakeRead = await readCronNextWakeFromSandbox(sandbox);

      logInfo("sandbox.status_transition", {
        from: meta.status,
        to: "stopped",
        sandboxId: meta.sandboxId,
        cronWakeRead,
      });

      if (cronWakeRead.status === "ok") {
        await getStore().setValue(cronNextWakeKey(), cronWakeRead.nextWakeMs);
        logInfo("sandbox.cron_wake_saved", { cronNextWakeMs: cronWakeRead.nextWakeMs });
      } else if (cronWakeRead.status === "no-jobs") {
        await getStore().deleteValue(cronNextWakeKey());
      }

      // Persist structured cron record as a safety net for resumes.
      // The stop path is authoritative — if there are 0 jobs, the user
      // intentionally deleted them.  Clear the store so a future resume
      // does not resurrect old jobs.
      const rawJobs = cronWakeRead.status !== "error" ? cronWakeRead.rawJobsJson : undefined;
      if (rawJobs) {
        const record = buildCronRecord(rawJobs, "stop");
        if (record) {
          await getStore().setValue(cronJobsKey(), record);
          logInfo("sandbox.cron_jobs_persisted", {
            source: "stop", jobCount: record.jobCount, sha256: record.sha256,
          });
        }
      } else if (cronWakeRead.status === "no-jobs") {
        await getStore().deleteValue(cronJobsKey());
        logInfo("sandbox.cron_jobs_cleared", { reason: "no-jobs-on-stop" });
      }

      // v2 persistent sandboxes auto-snapshot on stop — no manual snapshot() needed
      await sandbox.stop({ blocking: true });

      const stoppedMeta = await mutateMeta((next) => {
        // Keep sandboxId — persistent sandbox persists across stop/resume
        next.portUrls = null;
        next.status = "stopped";
        next.lastAccessedAt = Date.now();
        next.lastError = null;
      });

      // Hot-spare: best-effort pre-create a candidate sandbox after stop.
      // Gated — no-op when OPENCLAW_HOT_SPARE_ENABLED is not "true".
      if (isHotSpareEnabled()) {
        try {
          const result = await preCreateHotSpare(stoppedMeta, {
            create: (opts) => getSandboxController().create(opts),
            getSandboxVcpus,
            getSandboxSleepAfterMs,
            sandboxPorts: SANDBOX_PORTS,
          });
          if (result.status !== "skipped") {
            await mutateMeta((m) => applyPreCreateToMeta(m, result));
          }
        } catch (err) {
          logWarn("hot_spare.post_stop_pre_create_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return stoppedMeta;
    } catch (err) {
      // The sandbox may have already been stopped by the platform (timeout
      // expiry, etc.).  The Vercel API returns 404 or 410 in this case.
      // With v2 persistent sandboxes, a gone sandbox means it was deleted.
      // Mark as uninitialized so the next ensure creates a fresh one.
      const message = err instanceof Error ? err.message : String(err);
      const isGone = message.includes("404") || message.includes("410");
      if (isGone) {
        logWarn("sandbox.stop.sandbox_already_gone", {
          sandboxId: meta.sandboxId,
          error: message,
        });
        return mutateMeta((next) => {
          next.sandboxId = null;
          next.portUrls = null;
          next.status = "uninitialized";
          next.lastAccessedAt = Date.now();
          next.lastError = null;
        });
      }
      throw err;
    }
  });
}

export async function snapshotSandbox(): Promise<SingleMeta> {
  logInfo("sandbox.snapshot_requested");
  return stopSandbox();
}

export async function markSandboxUnavailable(
  reason: string,
  expectedSandboxId?: string,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    if (expectedSandboxId !== undefined && meta.sandboxId !== expectedSandboxId) {
      logWarn("sandbox.mark_unavailable_skipped_stale", {
        reason,
        expectedSandboxId,
        actualSandboxId: meta.sandboxId,
      });
      return;
    }

    meta.sandboxId = null;
    meta.portUrls = null;
    meta.status = meta.snapshotId ? "stopped" : "error";
    meta.lastError = reason;
  });
}

export async function getSandboxDomain(port = OPENCLAW_PORT): Promise<string> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || (meta.status !== "running" && meta.status !== "booting")) {
    throw new ApiError(409, "SANDBOX_NOT_RUNNING", "Sandbox is not running.");
  }

  const cached = meta.portUrls?.[String(port)];
  if (cached) {
    return cached;
  }

  const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
  const domain = sandbox.domain(port);
  await mutateMeta((next) => {
    next.portUrls = {
      ...(next.portUrls ?? {}),
      [String(port)]: domain,
    };
  });
  return domain;
}

/**
 * Write an updated openclaw.json into the running sandbox and restart the
 * gateway so new HTTP routes (e.g. `/slack/events`) are registered.
 *
 * OpenClaw's chokidar file watcher hot-reloads channel providers on config
 * change, but does NOT register new HTTP route handlers — that requires a
 * full gateway restart.  Without this restart, first-time Slack setup on a
 * running sandbox leaves `/slack/events` returning 404 until the next
 * stop+ensure cycle.
 *
 * Called after channel credentials are saved or removed in the admin UI.
 * No-op when the sandbox is not running.
 */
export async function syncGatewayConfigToSandbox(): Promise<LiveConfigSyncResult> {
  const meta = await getInitializedMeta();
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("sandbox.config_sync_skipped", {
      reason: "sandbox_not_running",
      status: meta.status,
      sandboxId: meta.sandboxId,
    });
    return { outcome: "skipped", reason: "sandbox_not_running", liveConfigFresh: false, operatorMessage: null };
  }

  const { getPublicOrigin } = await import("@/server/public-url");
  const proxyOrigin = getPublicOrigin();

  const slackConfig = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slackConfig
      ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
      : undefined,
    whatsappConfig: toWhatsAppGatewayConfig(meta.channels.whatsapp),
  });

  const sandboxId = meta.sandboxId;
  try {
    const sandbox = await getSandboxController().get({ sandboxId });
    await sandbox.writeFiles(files);
    logInfo("sandbox.config_sync_written", {
      sandboxId,
      fileCount: files.length,
      filePaths: files.map((f) => f.path),
    });

    // Restart the gateway so new HTTP route handlers are registered.
    // Without this, hot-reload restarts the channel provider but does not
    // wire up new routes like /slack/events.
    try {
      await restartGateway(sandbox);
    } catch (restartErr) {
      logWarn("sandbox.config_sync_restart_failed", {
        sandboxId,
        error: restartErr instanceof Error ? restartErr.message : String(restartErr),
      });
      return {
        outcome: "degraded",
        reason: "config_written_restart_failed",
        liveConfigFresh: false,
        operatorMessage: "Credentials were saved, but the running sandbox did not restart cleanly. Live routes may still be stale until the next successful restart.",
      };
    }

    // Poll for gateway readiness after restart.
    await pollUntil({
      label: "config-sync-gateway-ready",
      timeoutMs: 15_000,
      initialDelayMs: 200,
      maxDelayMs: 500,
      step: async () => {
        const result = await sandbox.runCommand("bash", [
          "-c",
          `curl -s -f --max-time 1 http://localhost:${OPENCLAW_PORT}/ 2>/dev/null | grep -q 'openclaw-app' && echo ok || echo not-ready`,
        ]);
        const out = await result.output("stdout");
        if (out.trim() === "ok") return { done: true, result: true };
        return { done: false };
      },
      timeoutError: () => new Error("Gateway did not become ready after config sync restart"),
    });

    logInfo("sandbox.config_sync_restarted", { sandboxId });
    return { outcome: "applied", reason: "config_written_and_restarted", liveConfigFresh: true, operatorMessage: null };
  } catch (error) {
    logWarn("sandbox.config_sync_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
      liveConfigFresh: false,
      operatorMessage: "Config sync failed. The sandbox may be serving stale configuration.",
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic config reconciliation
// ---------------------------------------------------------------------------

export type DynamicConfigReconcileResult = {
  verified: boolean;
  changed: boolean;
  reason:
    | "already-fresh"
    | "rewritten-and-restarted"
    | "rewrite-failed"
    | "restart-failed"
    | "sandbox-unavailable";
};

/**
 * Verify that the running sandbox's gateway config matches the expected hash
 * computed from current channel state.  When stale, rewrite dynamic config
 * files and restart the gateway, then re-verify.
 *
 * Idempotent — safe to call on every launch-verify or watchdog cycle.
 */
export async function ensureRunningSandboxDynamicConfigFresh(input: {
  origin: string;
  op?: OperationContext;
}): Promise<DynamicConfigReconcileResult> {
  const meta = await getInitializedMeta();
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("sandbox.config_reconcile.skipped", {
      reason: "sandbox_unavailable",
      status: meta.status,
      sandboxId: meta.sandboxId,
    });
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }

  const sandboxId = meta.sandboxId;

  // Compute expected hash from current channel state.
  const configHashInput: GatewayConfigHashInput = {
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: meta.channels.slack
      ? {
          botToken: meta.channels.slack.botToken,
          signingSecret: meta.channels.slack.signingSecret,
        }
      : undefined,
    whatsappConfig: toWhatsAppGatewayConfig(meta.channels.whatsapp),
  };
  const expectedHash = computeGatewayConfigHash(configHashInput);

  // Runtime reconcile compares against runtimeDynamicConfigHash (what is
  // actually on the running sandbox) — NOT snapshotDynamicConfigHash (what
  // was baked into the snapshot image).
  const runtimeHash = meta.runtimeDynamicConfigHash ?? meta.snapshotConfigHash;

  logInfo("sandbox.config_reconcile.checkpoint_before", {
    sandboxId,
    runtimeDynamicConfigHash: runtimeHash,
    snapshotConfigHash: meta.snapshotConfigHash,
    expectedHash,
    hashVersion: GATEWAY_CONFIG_HASH_VERSION,
  });

  // Already fresh — no work needed.
  if (runtimeHash === expectedHash) {
    logInfo("sandbox.config_reconcile.already_fresh", {
      sandboxId,
      configHash: expectedHash,
    });
    return { verified: true, changed: false, reason: "already-fresh" };
  }

  // Stale — rewrite dynamic config files.
  const slackConfig = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin: input.origin,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slackConfig
      ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
      : undefined,
    whatsappConfig: toWhatsAppGatewayConfig(meta.channels.whatsapp),
  });

  let sandbox: SandboxHandle;
  try {
    sandbox = await getSandboxController().get({ sandboxId });
  } catch (error) {
    logWarn("sandbox.config_reconcile.sandbox_lookup_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }

  try {
    await sandbox.writeFiles(files);
    logInfo("sandbox.config_reconcile.checkpoint_after_rewrite", {
      sandboxId,
      fileCount: files.length,
    });
  } catch (error) {
    logWarn("sandbox.config_reconcile.rewrite_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: false, reason: "rewrite-failed" };
  }

  // Restart the gateway so it picks up the new config.
  try {
    await restartGateway(sandbox);
    logInfo("sandbox.config_reconcile.checkpoint_after_restart", { sandboxId });
  } catch (error) {
    logWarn("sandbox.config_reconcile.restart_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: true, reason: "restart-failed" };
  }

  // Update runtime-truth only — snapshot-truth is stamped only by snapshot
  // creation paths.  Mark restore target dirty since the running sandbox now
  // differs from the snapshot image.
  await mutateMeta((next) => {
    next.runtimeDynamicConfigHash = expectedHash;
    if (
      next.restorePreparedStatus === "ready" ||
      next.restorePreparedStatus === "unknown"
    ) {
      next.restorePreparedStatus = "dirty";
      next.restorePreparedReason = "dynamic-config-changed";
    }

    // Move oracle to pending unless it is mid-cycle.
    if (next.restoreOracle.status !== "running") {
      next.restoreOracle.status = "pending";
    }
    next.restoreOracle.pendingReason = "dynamic-config-changed";
    next.restoreOracle.lastBlockedReason = null;
  });

  logInfo("sandbox.config_reconcile.checkpoint_verified", {
    sandboxId,
    configHash: expectedHash,
  });

  return { verified: true, changed: true, reason: "rewritten-and-restarted" };
}

// ---------------------------------------------------------------------------
// Restore target truth
// ---------------------------------------------------------------------------

/**
 * Mark the next restore target as dirty.  Call this whenever the running
 * sandbox diverges from its snapshot image (channel config change, deploy
 * drift, manual reset).
 */
export async function markRestoreTargetDirty(input: {
  reason: RestorePreparedReason;
}): Promise<SingleMeta> {
  logInfo("sandbox.restore_target.mark_dirty", { reason: input.reason });
  return mutateMeta((next) => {
    next.restorePreparedStatus = "dirty";
    next.restorePreparedReason = input.reason;

    // Move oracle to pending unless it is mid-cycle.
    if (next.restoreOracle.status !== "running") {
      next.restoreOracle.status = "pending";
    }
    next.restoreOracle.pendingReason = input.reason;
    next.restoreOracle.lastBlockedReason = null;
  });
}

/**
 * Check whether a prepared restore image is still reusable given the
 * desired config and asset hashes.
 */
export function isPreparedRestoreReusable(input: {
  meta: Pick<
    SingleMeta,
    | "snapshotDynamicConfigHash"
    | "snapshotAssetSha256"
    | "restorePreparedStatus"
  >;
  desiredDynamicConfigHash: string;
  desiredAssetSha256: string;
}): boolean {
  return (
    input.meta.restorePreparedStatus === "ready" &&
    input.meta.snapshotDynamicConfigHash === input.desiredDynamicConfigHash &&
    input.meta.snapshotAssetSha256 === input.desiredAssetSha256
  );
}

export type PrepareRestoreAction = {
  id:
    | "ensure-running"
    | "reconcile-dynamic-config"
    | "sync-static-assets"
    | "verify-ready"
    | "snapshot"
    | "stamp-meta";
  status: "completed" | "skipped" | "failed";
  message: string;
};

export type PrepareRestoreResult = {
  ok: boolean;
  destructive: boolean;
  state: SingleMeta["restorePreparedStatus"];
  reason: SingleMeta["restorePreparedReason"];
  snapshotId: string | null;
  snapshotDynamicConfigHash: string | null;
  runtimeDynamicConfigHash: string | null;
  snapshotAssetSha256: string | null;
  runtimeAssetSha256: string | null;
  preparedAt: number | null;
  actions: PrepareRestoreAction[];
  decision: RestoreDecision;
};

/**
 * Prepare the next restore target.  When `destructive` is true, the sandbox
 * is snapshot-and-stopped so the snapshot image matches current config and
 * assets.  When `destructive` is false, the function reports whether the
 * current snapshot is reusable without modifying state.
 */
export async function prepareRestoreTarget(input: {
  origin: string;
  reason: string;
  destructive?: boolean;
  op?: OperationContext;
}): Promise<PrepareRestoreResult> {
  const actions: PrepareRestoreAction[] = [];
  const meta = await getInitializedMeta();
  const isDestructive = input.destructive ?? false;

  logInfo("sandbox.restore_target.prepare_start", {
    destructive: isDestructive,
    reason: input.reason,
    status: meta.status,
    sandboxId: meta.sandboxId,
  });

  // Single source of truth: compute the canonical decision once.
  const decision = buildRestoreDecision({
    meta,
    source: isDestructive ? "prepare" : "inspect",
    destructive: isDestructive,
  });

  logInfo("sandbox.restore.decision", {
    source: decision.source,
    destructive: decision.destructive,
    reusable: decision.reusable,
    needsPrepare: decision.needsPrepare,
    blocking: decision.blocking,
    reasons: decision.reasons,
    requiredActions: decision.requiredActions,
    nextAction: decision.nextAction,
    status: decision.status,
    sandboxId: decision.sandboxId,
    snapshotId: decision.snapshotId,
    idleMs: decision.idleMs,
    minIdleMs: decision.minIdleMs,
    probeReady: decision.probeReady,
  });

  // Check if the existing snapshot is already prepared and fresh.
  if (decision.reusable) {
    logInfo("sandbox.restore_target.already_prepared", {
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.snapshotDynamicConfigHash,
      snapshotAssetSha256: meta.snapshotAssetSha256,
    });
    return {
      ok: true,
      destructive: false,
      state: meta.restorePreparedStatus,
      reason: meta.restorePreparedReason,
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
      snapshotAssetSha256: meta.snapshotAssetSha256,
      runtimeAssetSha256: meta.runtimeAssetSha256,
      preparedAt: meta.restorePreparedAt,
      actions: [{ id: "stamp-meta", status: "skipped", message: "already prepared" }],
      decision,
    };
  }

  // Non-destructive: report status without mutating.
  if (!input.destructive) {
    logInfo("sandbox.restore_target.non_destructive_check", {
      currentState: meta.restorePreparedStatus,
      reasons: decision.reasons,
      requiredActions: decision.requiredActions,
    });
    return {
      ok: false,
      destructive: false,
      state: meta.restorePreparedStatus === "ready" ? "dirty" : meta.restorePreparedStatus,
      reason: meta.restorePreparedReason,
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
      snapshotAssetSha256: meta.snapshotAssetSha256,
      runtimeAssetSha256: meta.runtimeAssetSha256,
      preparedAt: meta.restorePreparedAt,
      actions: [{ id: "snapshot", status: "failed", message: "destructive snapshot required but not allowed" }],
      decision,
    };
  }

  // Destructive: ensure running, reconcile, snapshot, stamp.
  await mutateMeta((next) => {
    next.restorePreparedStatus = "preparing";
    next.restorePreparedReason = null;
  });

  // Step 1: Ensure the sandbox is running.
  if (meta.status !== "running" || !meta.sandboxId) {
    actions.push({ id: "ensure-running", status: "failed", message: `sandbox status: ${meta.status}` });
    await mutateMeta((next) => {
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }
  actions.push({ id: "ensure-running", status: "completed", message: "sandbox running" });

  // Step 2: Reconcile dynamic config on the live sandbox.
  const reconcileResult = await ensureRunningSandboxDynamicConfigFresh({
    origin: input.origin,
    op: input.op,
  });
  actions.push({
    id: "reconcile-dynamic-config",
    status: reconcileResult.verified ? "completed" : "failed",
    message: reconcileResult.reason,
  });
  if (!reconcileResult.verified) {
    await mutateMeta((next) => {
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // Step 3: Sync static assets.
  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const slackConfig = meta.channels.slack;
    await syncRestoreAssetsIfNeeded(sandbox, {
      origin: input.origin,
      telegramBotToken: meta.channels.telegram?.botToken,
      telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
      slackCredentials: slackConfig
        ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
        : undefined,
      whatsappConfig: toWhatsAppGatewayConfig(meta.channels.whatsapp),
    });
    actions.push({ id: "sync-static-assets", status: "completed", message: "runtime assets fresh" });
  } catch (err) {
    actions.push({
      id: "sync-static-assets",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
    await mutateMeta((next) => {
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // Step 4: Verify gateway readiness before snapshotting.
  const readiness = await probeGatewayReady();
  actions.push({
    id: "verify-ready",
    status: readiness.ready ? "completed" : "failed",
    message:
      readiness.ready
        ? "gateway ready"
        : readiness.error ??
          `gateway not ready${readiness.statusCode ? ` (status ${readiness.statusCode})` : ""}`,
  });
  if (!readiness.ready) {
    await mutateMeta((next) => {
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // Step 5: Snapshot and stop.
  try {
    await stopSandbox();
    actions.push({ id: "snapshot", status: "completed", message: "snapshot created" });
  } catch (err) {
    actions.push({
      id: "snapshot",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
    await mutateMeta((next) => {
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // stopSandbox already calls recordSnapshotMetadata which stamps
  // snapshotDynamicConfigHash, snapshotAssetSha256, and restorePreparedStatus.
  actions.push({ id: "stamp-meta", status: "completed", message: "snapshot truth recorded" });

  const finalMeta = await getInitializedMeta();
  const finalDecision = buildRestoreDecision({ meta: finalMeta, source: "prepare", destructive: true });

  logInfo("sandbox.restore_target.prepare_complete", {
    snapshotId: finalMeta.snapshotId,
    snapshotDynamicConfigHash: finalMeta.snapshotDynamicConfigHash,
    snapshotAssetSha256: finalMeta.snapshotAssetSha256,
    restorePreparedStatus: finalMeta.restorePreparedStatus,
  });

  logInfo("sandbox.restore.decision", {
    source: finalDecision.source,
    destructive: finalDecision.destructive,
    reusable: finalDecision.reusable,
    needsPrepare: finalDecision.needsPrepare,
    blocking: finalDecision.blocking,
    reasons: finalDecision.reasons,
    requiredActions: finalDecision.requiredActions,
    nextAction: finalDecision.nextAction,
    status: finalDecision.status,
    sandboxId: finalDecision.sandboxId,
    snapshotId: finalDecision.snapshotId,
    idleMs: finalDecision.idleMs,
    minIdleMs: finalDecision.minIdleMs,
    probeReady: finalDecision.probeReady,
  });

  return {
    ok: true,
    destructive: true,
    state: finalMeta.restorePreparedStatus,
    reason: finalMeta.restorePreparedReason,
    snapshotId: finalMeta.snapshotId,
    snapshotDynamicConfigHash: finalMeta.snapshotDynamicConfigHash,
    runtimeDynamicConfigHash: finalMeta.runtimeDynamicConfigHash,
    snapshotAssetSha256: finalMeta.snapshotAssetSha256,
    runtimeAssetSha256: finalMeta.runtimeAssetSha256,
    preparedAt: finalMeta.restorePreparedAt,
    actions,
    decision: finalDecision,
  };
}

// ---------------------------------------------------------------------------
// Hot-spare lifecycle helper
// ---------------------------------------------------------------------------

export type PrepareHotSpareResult = {
  ok: boolean;
  reason: "created" | "skipped" | "failed" | "snapshot-missing";
  candidateSandboxId: string | null;
};

/**
 * Prepare a snapshot-backed hot-spare sandbox from the latest prepared restore
 * target.  Intended to be called by the watchdog after a successful oracle
 * prepare so the spare is ready before the next Telegram wake arrives.
 */
export async function prepareHotSpareFromPreparedRestore(options?: {
  op?: OperationContext;
}): Promise<PrepareHotSpareResult> {
  void options; // reserved for future observability threading

  const meta = await getInitializedMeta();

  if (!meta.snapshotId) {
    logInfo("sandbox.hot_spare.prepare.skipped", {
      reason: "snapshot-missing",
    });
    return { ok: false, reason: "snapshot-missing", candidateSandboxId: null };
  }

  const hotSpareApiKey = await getAiGatewayBearerTokenOptional();
  const restoreEnv = buildRestoreRuntimeEnv({
    gatewayToken: meta.gatewayToken,
    apiKey: hotSpareApiKey,
  });

  const result = await preCreateHotSpareFromSnapshot(meta, {
    create: (createOptions) => getSandboxController().create(createOptions),
    getSandboxVcpus,
    getSandboxSleepAfterMs,
    sandboxPorts: SANDBOX_PORTS,
    restoreEnv,
  });

  await mutateMeta((next) => {
    applyPreCreateToMeta(next, result);
  });

  logInfo("sandbox.hot_spare.prepare.result", {
    status: result.status,
    candidateSandboxId: result.candidateSandboxId,
    snapshotId: meta.snapshotId,
  });

  return {
    ok: result.status !== "failed",
    reason: result.status === "created"
      ? "created"
      : result.status === "skipped"
        ? "skipped"
        : "failed",
    candidateSandboxId: result.candidateSandboxId,
  };
}

export async function touchRunningSandbox(): Promise<SingleMeta> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return meta;
  }
  const sandboxId = meta.sandboxId;

  const now = Date.now();
  const throttleMs = getSandboxTouchThrottleMs();
  if (meta.lastAccessedAt && now - meta.lastAccessedAt < throttleMs) {
    return meta;
  }

  let sandbox: SandboxHandle;
  try {
    sandbox = await getSandboxController().get({ sandboxId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markSandboxUnavailable(`sandbox lookup failed: ${message}`, sandboxId);
  }

  const targetSleepAfterMs = getSandboxSleepAfterMs();

  try {
    const remainingMs = Math.max(0, sandbox.timeout);
    const extendByMs = Math.max(0, targetSleepAfterMs - remainingMs);

    if (extendByMs > 0) {
      await sandbox.extendTimeout(extendByMs);
      logInfo("sandbox.timeout_topped_up", {
        sandboxId: meta.sandboxId,
        remainingMs,
        extendByMs,
        targetSleepAfterMs,
      });
    } else {
      logInfo("sandbox.timeout_top_up_skipped", {
        sandboxId: meta.sandboxId,
        remainingMs,
        targetSleepAfterMs,
        reason: "already-at-or-above-target",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("sandbox_timeout_invalid")) {
      // Timeout already at max — sandbox is fine, ignore.
    } else {
      logWarn("sandbox.extend_timeout_failed", {
        sandboxId,
        error: message,
      });
      return markSandboxUnavailable(
        `extend timeout failed: ${message}`,
        sandboxId,
      );
    }
  }

  // Piggyback on the heartbeat to keep the cron wake time fresh in the
  // store.  When the sandbox naturally sleeps (platform timeout),
  // stopSandbox() never runs, so this is the only path that persists the
  // next wake time before the sandbox disappears.
  try {
    const cronWakeRead = await readCronNextWakeFromSandbox(sandbox);
    if (cronWakeRead.status === "ok") {
      await getStore().setValue(cronNextWakeKey(), cronWakeRead.nextWakeMs);
    } else if (cronWakeRead.status === "no-jobs") {
      await getStore().deleteValue(cronNextWakeKey());
    }
    // Persist structured cron record as a safety net.  IMPORTANT: only
    // overwrite the store when we read valid, non-empty, changed jobs.
    // A heartbeat can catch jobs.json during a transient empty/partial-
    // write window — blindly writing that would clobber a good backup.
    const rawJobs = cronWakeRead.status !== "error" ? cronWakeRead.rawJobsJson : undefined;
    if (rawJobs) {
      const record = buildCronRecord(rawJobs, "heartbeat");
      if (record) {
        // Only write if the hash changed — avoids redundant Upstash writes.
        const existing = parseStoredCronRecord(
          await getStore().getValue<unknown>(cronJobsKey()),
        );
        if (!existing || existing.sha256 !== record.sha256) {
          await getStore().setValue(cronJobsKey(), record);
        }
      }
      // If record is null (empty/invalid), do NOT clear — may be transient.
    }
  } catch {
    // Non-critical — don't let cron-wake bookkeeping break the heartbeat.
  }

  return mutateMeta((next) => {
    next.lastAccessedAt = now;
  });
}

export async function getRunningSandboxTimeoutRemainingMs(): Promise<number | null> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return null;
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    return Math.max(0, sandbox.timeout);
  } catch {
    return null;
  }
}

/**
 * Check if a sandbox that metadata says is "running" has actually stopped
 * (e.g. platform timeout). If the SDK confirms it's stopped/failed, update
 * metadata to "stopped" so the UI shows the truth instead of a stale status.
 *
 * Returns the reconciled metadata.
 */
export async function reconcileStaleRunningStatus(): Promise<SingleMeta> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return meta;
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const sdkStatus = sandbox.status;
    if (sdkStatus === "running") {
      return meta;
    }
    logInfo("sandbox.stale_running_reconciled", {
      sandboxId: meta.sandboxId,
      sdkStatus,
      metaStatus: meta.status,
    });
    return mutateMeta((next) => {
      next.status = "stopped";
      next.lastError = null;
    });
  } catch {
    // get() throws when sandbox no longer exists — it's definitely stopped
    logInfo("sandbox.stale_running_reconciled", {
      sandboxId: meta.sandboxId,
      sdkStatus: "not-found",
      metaStatus: meta.status,
    });
    return mutateMeta((next) => {
      next.status = "stopped";
      next.lastError = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Token refresh — structured result, distributed lock, circuit breaker, TTL
// ---------------------------------------------------------------------------

/**
 * Compute remaining TTL from persisted sandbox credential metadata.
 * Returns `Infinity` for api-key sources, `null` when no expiry is recorded.
 */
function getSandboxCredentialRemainingMs(
  meta: Pick<SingleMeta, "lastTokenExpiresAt" | "lastTokenSource">,
  now = Date.now(),
): number | null {
  if (meta.lastTokenSource === "api-key") {
    return Number.POSITIVE_INFINITY;
  }
  if (meta.lastTokenExpiresAt == null) {
    return null;
  }
  return meta.lastTokenExpiresAt * 1000 - now;
}

/**
 * Check whether the persisted sandbox credential has at least `minRemainingMs`
 * of TTL left. This is the only TTL authority — function-local OIDC tokens
 * are never used for freshness decisions.
 */
function hasSufficientSandboxCredentialTtl(
  meta: Pick<SingleMeta, "lastTokenExpiresAt" | "lastTokenSource">,
  minRemainingMs: number,
  now = Date.now(),
): boolean {
  const remainingMs = getSandboxCredentialRemainingMs(meta, now);
  return remainingMs != null && remainingMs > minRemainingMs;
}

/**
 * Produce a version string from the credential-relevant metadata fields.
 * Used to detect whether another request refreshed the token while this
 * request was waiting on the distributed lock.
 */
function getSandboxCredentialVersion(
  meta: Pick<
    SingleMeta,
    "lastTokenRefreshAt" | "lastTokenExpiresAt" | "lastTokenSource"
  >,
): string {
  return [
    meta.lastTokenRefreshAt ?? "none",
    meta.lastTokenExpiresAt ?? "none",
    meta.lastTokenSource ?? "none",
  ].join(":");
}

/**
 * High-level entry point for AI Gateway credential management.
 *
 * Wraps TTL-based freshness check, circuit breaker, distributed lock, and
 * the actual refresh into a single call that returns a structured result.
 */
export async function ensureUsableAiGatewayCredential(
  opts?: EnsureUsableCredentialOptions,
): Promise<TokenRefreshResult> {
  const minRemainingMs = opts?.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const force = opts?.force ?? false;
  const required = opts?.required ?? false;
  const reason = opts?.reason ?? "ensure-usable";

  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return { refreshed: false, reason: "sandbox-not-running" };
  }

  // Resolve current credential to check TTL / source.
  const credential = await resolveAiGatewayCredentialOptional();

  // If source is api-key, no refresh is ever needed — static keys don't expire.
  if (credential?.source === "api-key") {
    return {
      refreshed: false,
      reason: "api-key-no-refresh-needed",
      credential: credential
        ? { token: credential.token, source: credential.source, expiresAt: credential.expiresAt }
        : null,
    };
  }

  // If no credential at all and required, fail immediately.
  if (!credential && required) {
    return { refreshed: false, reason: "no-credential-available" };
  }

  // Capture credential version before the lock to detect concurrent refreshes.
  const initialCredentialVersion = getSandboxCredentialVersion(meta);

  // Check TTL of the token last written to the sandbox — skip if it still has
  // sufficient remaining life. We use the persisted sandbox metadata as the
  // only TTL authority. Function-local OIDC tokens are never trusted for
  // freshness decisions because Vercel Functions always get a fresh 1-hour
  // token that would falsely pass even when the sandbox's on-disk token has
  // long expired.
  if (!force && hasSufficientSandboxCredentialTtl(meta, minRemainingMs)) {
    logInfo("sandbox.credential.ttl_sufficient", {
      sandboxId: meta.sandboxId,
      reason: "meta-ttl-sufficient",
      remainingMs: getSandboxCredentialRemainingMs(meta),
    });
    return {
      refreshed: false,
      reason: "meta-ttl-sufficient",
      credential: credential
        ? { token: credential.token, source: credential.source, expiresAt: credential.expiresAt }
        : null,
    };
  }

  // Circuit breaker check.
  const breakerResult = checkCircuitBreaker(meta);
  if (breakerResult) {
    return breakerResult;
  }

  // Acquire distributed lock before refreshing.
  return withTokenRefreshLock(meta.sandboxId, reason, async (currentMeta) => {
    // Re-check after lock acquisition — another request may have refreshed
    // while we waited. Use persisted metadata as the only TTL authority.
    const currentCredentialVersion = getSandboxCredentialVersion(currentMeta);

    if (!force && hasSufficientSandboxCredentialTtl(currentMeta, minRemainingMs)) {
      const versionChanged = currentCredentialVersion !== initialCredentialVersion;
      const afterLockReason = versionChanged
        ? "refreshed-by-another-request"
        : "meta-ttl-sufficient-after-lock";
      logInfo("sandbox.credential.ttl_sufficient_after_lock", {
        sandboxId: currentMeta.sandboxId,
        reason: afterLockReason,
        versionChanged,
        remainingMs: getSandboxCredentialRemainingMs(currentMeta),
      });
      const liveCred = await resolveAiGatewayCredentialOptional();
      return {
        refreshed: false,
        reason: afterLockReason,
        credential: liveCred
          ? { token: liveCred.token, source: liveCred.source, expiresAt: liveCred.expiresAt }
          : null,
      };
    }

    // api-key check after lock (another request may have switched to api-key).
    if (!force && currentMeta.lastTokenSource === "api-key") {
      return {
        refreshed: false,
        reason: "api-key-no-refresh-needed",
        credential: null,
      };
    }

    // Verify sandboxId has not changed while we waited for the lock.
    if (currentMeta.sandboxId !== meta.sandboxId) {
      return { refreshed: false, reason: "sandbox-changed" };
    }

    const sandbox = await getSandboxController().get({ sandboxId: currentMeta.sandboxId! });
    try {
      await refreshAiGatewayToken(sandbox, currentMeta.sandboxId!);

      // Success — reset breaker state.
      await mutateMeta((m) => {
        m.consecutiveTokenRefreshFailures = 0;
        m.lastTokenRefreshError = null;
        m.breakerOpenUntil = null;
      });

      const postRefreshCred = await resolveAiGatewayCredentialOptional();
      return {
        refreshed: true,
        reason: "refreshed",
        credential: postRefreshCred
          ? { token: postRefreshCred.token, source: postRefreshCred.source, expiresAt: postRefreshCred.expiresAt }
          : null,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logWarn("sandbox.token_refresh_failed", {
        sandboxId: currentMeta.sandboxId,
        error: errorMsg,
        reason,
      });

      // Record failure for circuit breaker.
      const updated = await mutateMeta((m) => {
        m.consecutiveTokenRefreshFailures = (m.consecutiveTokenRefreshFailures ?? 0) + 1;
        m.lastTokenRefreshError = errorMsg;

        // Open breaker after threshold consecutive failures.
        if ((m.consecutiveTokenRefreshFailures ?? 0) >= BREAKER_FAILURE_THRESHOLD) {
          m.breakerOpenUntil = Date.now() + BREAKER_OPEN_DURATION_MS;
          logWarn("sandbox.token_refresh.breaker_opened", {
            failures: m.consecutiveTokenRefreshFailures,
            breakerOpenUntil: m.breakerOpenUntil,
          });
        }
      });

      return {
        refreshed: false,
        reason: `refresh-failed: ${errorMsg}`,
        retryAfterMs: updated.breakerOpenUntil
          ? Math.max(0, updated.breakerOpenUntil - Date.now())
          : undefined,
      };
    }
  });
}

/**
 * Legacy entry point — now delegates to ensureUsableAiGatewayCredential.
 *
 * Returns a structured TokenRefreshResult instead of void. Callers that
 * previously ignored the return value continue to work since the signature
 * is a superset of the old void return.
 */
export async function ensureFreshGatewayToken(options?: {
  force?: boolean;
}): Promise<TokenRefreshResult> {
  return ensureUsableAiGatewayCredential({
    force: options?.force,
    reason: "ensureFreshGatewayToken",
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

function checkCircuitBreaker(meta: SingleMeta): TokenRefreshResult | null {
  const breakerOpenUntil = meta.breakerOpenUntil ?? 0;
  if (breakerOpenUntil > 0 && Date.now() < breakerOpenUntil) {
    const retryAfterMs = breakerOpenUntil - Date.now();
    logInfo("sandbox.token_refresh.circuit_breaker_open", {
      breakerOpenUntil,
      retryAfterMs,
      consecutiveFailures: meta.consecutiveTokenRefreshFailures ?? 0,
    });
    return {
      refreshed: false,
      reason: "circuit-breaker-open",
      retryAfterMs,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Distributed token refresh lock
// ---------------------------------------------------------------------------

async function withTokenRefreshLock(
  sandboxId: string,
  reason: string,
  fn: (meta: SingleMeta) => Promise<TokenRefreshResult>,
): Promise<TokenRefreshResult> {
  const store = getStore();
  let lockToken = await store.acquireLock(
    tokenRefreshLockKey(),
    TOKEN_REFRESH_LOCK_TTL_SECONDS,
  );

  if (!lockToken) {
    // Lock is contended — wait a bounded time, then re-read state.
    const waitStart = Date.now();
    while (Date.now() - waitStart < TOKEN_REFRESH_LOCK_WAIT_MS) {
      await wait(TOKEN_REFRESH_LOCK_POLL_MS);
      lockToken = await store.acquireLock(
        tokenRefreshLockKey(),
        TOKEN_REFRESH_LOCK_TTL_SECONDS,
      );
      if (lockToken) break;
    }

    if (!lockToken) {
      // Still contended — check if another request completed the refresh.
      const freshMeta = await getInitializedMeta();
      if (freshMeta.sandboxId !== sandboxId) {
        return { refreshed: false, reason: "sandbox-changed-during-lock-wait" };
      }

      // Return without refreshing — the lock holder is doing it.
      logInfo("sandbox.token_refresh.lock_contended", { sandboxId, reason });
      return {
        refreshed: false,
        reason: "lock-contended",
      };
    }
  }

  try {
    const currentMeta = await getInitializedMeta();
    return await fn(currentMeta);
  } finally {
    await store.releaseLock(tokenRefreshLockKey(), lockToken).catch((error) => {
      logWarn("sandbox.token_refresh.lock_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Core credential write (gateway token only — AI key is injected via network
// policy transform and never enters the sandbox).
// ---------------------------------------------------------------------------

const WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT = [
  `install -d -m 700 ${OPENCLAW_STATE_DIR}`,
  `printf '%s' "$1" > ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
  `chmod 600 ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
].join("\n");

export async function writeRestoreCredentialFiles(
  sandbox: SandboxHandle,
  options: { gatewayToken: string },
): Promise<void> {
  logInfo("sandbox.restore.write_credentials", {
    sandboxId: sandbox.sandboxId,
  });

  const result = await sandbox.runCommand("sh", [
    "-c",
    WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT,
    "--",
    options.gatewayToken,
  ]);

  if (result.exitCode !== 0) {
    const output = await result.output("both");
    throw new CommandFailedError({
      command: "write-restore-credential-files",
      exitCode: result.exitCode,
      output,
    });
  }
}

// Token refresh via network policy update — the AI Gateway credential is
// injected as an Authorization header transform at the firewall layer, so
// refreshing it is a single SDK call with no gateway restart required.

async function refreshAiGatewayToken(sandbox: SandboxHandle, sandboxId: string): Promise<void> {
  const credential = await resolveAiGatewayCredentialOptional();

  // If source is api-key, skip refresh entirely — static keys don't expire.
  if (credential?.source === "api-key") {
    logInfo("sandbox.token_refresh.skipped_api_key", { sandboxId });
    await mutateMeta((next) => {
      next.lastTokenRefreshAt = Date.now();
      next.lastTokenSource = "api-key";
      next.lastTokenExpiresAt = null;
    });
    return;
  }

  const freshToken = credential?.token;
  if (!freshToken) {
    logWarn("sandbox.token_refresh.no_oidc_token", { sandboxId });
    throw new Error("No OIDC token available for refresh");
  }

  logInfo("sandbox.token_refresh.start", { sandboxId });

  // Update the network policy with the fresh token — the firewall layer
  // injects the Authorization header on outbound requests to ai-gateway.
  // No file writes or gateway restarts needed.
  const meta = await getInitializedMeta();
  await applyFirewallPolicyToSandbox(sandbox, meta, freshToken);

  logInfo("sandbox.token_refresh.policy_updated", { sandboxId });

  await mutateMeta((next) => {
    next.lastTokenRefreshAt = Date.now();
    next.lastTokenSource = credential.source;
    next.lastTokenExpiresAt = credential.expiresAt ?? null;
  });

  logInfo("sandbox.token_refresh.complete", { sandboxId });
}

// ---------------------------------------------------------------------------
// Gateway readiness probes
// ---------------------------------------------------------------------------

export type ProbeResult = {
  ready: boolean;
  statusCode?: number;
  markerFound?: boolean;
  error?: string;
};

export async function probeGatewayReady(
  options?: { timeoutMs?: number },
): Promise<ProbeResult> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || !["running", "setup", "booting"].includes(meta.status)) {
    return { ready: false };
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const routeUrl = meta.portUrls?.[String(OPENCLAW_PORT)] ?? sandbox.domain(OPENCLAW_PORT);
    const response = await fetch(routeUrl, {
      method: "GET",
      headers: {
        Accept: "text/html",
        Authorization: `Bearer ${meta.gatewayToken}`,
      },
      signal: AbortSignal.timeout(options?.timeoutMs ?? 5_000),
    });
    const body = await response.text();
    const markerFound = body.includes("openclaw-app");
    const ready = response.ok && markerFound;

    if (ready && meta.status !== "running") {
      await mutateMeta((next) => {
        next.status = "running";
        next.lastError = null;
      });
    }

    return { ready, statusCode: response.status, markerFound };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn("sandbox.probe_failed", { error: message });
    return { ready: false, error: message };
  }
}

export async function waitForPublicGatewayReady(options?: {
  maxAttempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  probe?: (timeoutMs: number) => Promise<ProbeResult>;
}): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 20;
  const delayMs = options?.delayMs ?? 250;
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const probe =
    options?.probe ??
    ((budgetMs: number) => probeGatewayReady({ timeoutMs: budgetMs }));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await probe(timeoutMs);
    if (result.ready) {
      logInfo("sandbox.public_gateway_ready", { attempt, timeoutMs });
      return;
    }
    if (attempt < maxAttempts - 1) {
      await wait(delayMs);
    }
  }

  throw new Error(
    `Gateway became locally ready but never became publicly reachable within ${maxAttempts} attempts.`,
  );
}

// ---------------------------------------------------------------------------
// Health reconciliation
// ---------------------------------------------------------------------------

export type SandboxHealthStatus = "ready" | "recovering" | "unreachable";

export type SandboxHealthResult = {
  status: SandboxHealthStatus;
  meta: SingleMeta;
  repaired: boolean;
  error?: string;
};

/**
 * Single authority for sandbox health reconciliation.
 *
 * When metadata says "running", probes the actual gateway.  If the probe
 * fails the sandbox is marked unavailable and recovery is scheduled — the
 * same repair path used everywhere else.  Non-running states delegate to
 * `ensureSandboxRunning` so callers never have to choose between "check"
 * and "ensure".
 */
export async function reconcileSandboxHealth(options: {
  origin: string;
  reason: string;
  schedule?: BackgroundScheduler;
  op?: OperationContext;
}): Promise<SandboxHealthResult> {
  const meta = await getInitializedMeta();

  // Not supposed to be running — just ensure.
  if (meta.status !== "running" || !meta.sandboxId) {
    if (options.op) {
      logInfo("sandbox.reconcile.not_running", withOperationContext(options.op, {
        status: meta.status,
        action: "ensure",
      }));
    }
    const result = await ensureSandboxRunning(options);
    return {
      status: result.state === "running" ? "ready" : "recovering",
      meta: result.meta,
      repaired: false,
    };
  }

  // Metadata says running — verify with a real probe.
  const sandboxId = meta.sandboxId;
  const probe = await probeGatewayReady();
  if (probe.ready) {
    return { status: "ready", meta, repaired: false };
  }

  // Stale running state detected — repair.
  const reconcileCtx = options.op
    ? withOperationContext(options.op, {
        probeError: probe.error,
        statusCode: probe.statusCode,
        sandboxId,
      })
    : {
        reason: options.reason,
        probeError: probe.error,
        statusCode: probe.statusCode,
        sandboxId,
      };
  logWarn("sandbox.health_reconcile", reconcileCtx);
  await markSandboxUnavailable(
    `Health reconciliation: gateway unreachable (${options.reason})`,
    sandboxId,
  );
  const ensureResult = await ensureSandboxRunning(options);
  const recoveryCtx = options.op
    ? withOperationContext(options.op, {
        newStatus: ensureResult.meta.status,
        repaired: true,
      })
    : {
        reason: options.reason,
        newStatus: ensureResult.meta.status,
        repaired: true,
      };
  logInfo("sandbox.health_reconcile_recovery_scheduled", recoveryCtx);

  return {
    status: "recovering",
    meta: ensureResult.meta,
    repaired: true,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle work scheduling
// ---------------------------------------------------------------------------

async function scheduleLifecycleWork(options: {
  origin: string;
  reason: string;
  meta: SingleMeta;
  schedule?: BackgroundScheduler;
  op?: OperationContext;
}): Promise<void> {
  const store = getStore();
  const startToken = await store.acquireLock(startLockKey(), START_LOCK_TTL_SECONDS);
  if (!startToken) {
    const lockCtx = options.op
      ? withOperationContext(options.op, { lock: "start", contention: true })
      : { reason: options.reason };
    logInfo("sandbox.start_lock_contended", lockCtx);
    return;
  }

  const latest = await getInitializedMeta();
  if (latest.status === "running" && latest.sandboxId) {
    await store.releaseLock(startLockKey(), startToken);
    return;
  }

  if (isBusyStatus(latest.status) && !isOperationStale(latest)) {
    await store.releaseLock(startLockKey(), startToken);
    return;
  }

  const nextStatus = "creating";

  if (options.op) {
    logInfo("sandbox.lifecycle.action_chosen", withOperationContext(options.op, {
      action: nextStatus,
      statusBefore: latest.status,
      sandboxId: latest.sandboxId,
      snapshotId: latest.snapshotId,
    }));
  }

  await mutateMeta((meta) => {
    if (meta.status === "running" && meta.sandboxId) {
      return;
    }
    meta.status = nextStatus;
    meta.lastError = null;
  });

  const run = async (): Promise<void> => {
    await withAutoRenewedLock(
      {
        key: startLockKey(),
        token: startToken,
        ttlSeconds: START_LOCK_TTL_SECONDS,
        label: "sandbox.start",
      },
      async () => {
        try {
          await createAndBootstrapSandbox(options.origin, { op: options.op });
        } catch (error) {
          if (error instanceof LifecycleLockUnavailableError) {
            const lockCtx = options.op
              ? withOperationContext(options.op, { lock: "lifecycle", contention: true })
              : { reason: options.reason };
            logInfo("sandbox.lifecycle_lock_contended", lockCtx);
            return;
          }

          const errMsg = error instanceof Error ? error.message : String(error);
          // Capture full API error details when available (e.g. @vercel/sandbox APIError)
          const apiErrorJson = (error as { json?: unknown }).json;
          const apiErrorText = (error as { text?: unknown }).text;
          const errCtx = options.op
            ? withOperationContext(options.op, { error: errMsg, ...(apiErrorJson ? { apiErrorJson } : {}), ...(apiErrorText ? { apiErrorText } : {}) })
            : { reason: options.reason, error: errMsg, ...(apiErrorJson ? { apiErrorJson } : {}), ...(apiErrorText ? { apiErrorText } : {}) };
          logError("sandbox.lifecycle_failed", errCtx);
          await mutateMeta((meta) => {
            meta.status = "error";
            meta.lastError = errMsg;
          });
        }
      },
    );
  };

  if (options.schedule) {
    options.schedule(run);
  } else {
    void run();
  }
}

// ---------------------------------------------------------------------------
// Sandbox create and restore
// ---------------------------------------------------------------------------

async function createAndBootstrapSandbox(
  origin: string,
  options?: { op?: OperationContext },
): Promise<SingleMeta> {
  return withLifecycleLock(() => createAndBootstrapSandboxWithinLifecycleLock(origin, options));
}

async function createAndBootstrapSandboxWithinLifecycleLock(
  origin: string,
  options?: { op?: OperationContext },
): Promise<SingleMeta> {
  const current = await getInitializedMeta();
  if (current.status === "running" && current.sandboxId) {
    return current;
  }

  /** Merge operation context (when available) with extra fields for structured logs. */
  const ctx = (extra?: Record<string, unknown>) =>
    options?.op ? withOperationContext(options.op, extra) : (extra ?? {});
  const attemptId = randomUUID();
  const instanceId = current.id;

  // Auth-required boot: on Vercel, require a usable AI Gateway credential.
  const credential = await resolveAiGatewayCredentialOptional();
  if (isVercelDeployment() && !credential) {
    logError("sandbox.create.no_ai_gateway_credential", ctx({
      message: "Cannot create sandbox on Vercel without AI Gateway credential. OIDC may be temporarily unavailable.",
    }));
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError =
        "AI Gateway credential unavailable during sandbox create. " +
        "OIDC may be temporarily unavailable — retry will be attempted automatically.";
    });
    return getInitializedMeta();
  }

  await clearSetupProgress(instanceId);
  const initialProgress = await beginSetupProgress({
    attemptId,
    instanceId,
    phase: "creating-sandbox",
  });
  const progress = new SetupProgressWriter(initialProgress, instanceId);
  progress.setPreview("Allocating sandbox");

  try {
    logInfo("sandbox.status_transition", ctx({ from: current.status, to: "creating" }));
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.lastError = null;
      meta.lifecycleAttemptId = attemptId;

      // Creating a brand-new sandbox invalidates any previously prepared restore target.
      meta.snapshotId = null;
      meta.snapshotConfigHash = null;
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotAssetSha256 = null;
      meta.restorePreparedStatus = "dirty";
      meta.restorePreparedReason = "snapshot-missing";
      meta.restorePreparedAt = null;
    });

    const vcpus = getSandboxVcpus();
    const sleepAfterMs = getSandboxSleepAfterMs();
    // Sandbox names must be lowercase alphanumeric + hyphens.
    const sandboxName = `oc-${current.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
    logInfo("sandbox.create.params", ctx({
      sandboxName,
      instanceId: current.id,
      persistent: true,
      vcpus,
      sleepAfterMs,
    }));

    // Hot-spare fast path: try to promote a pre-created candidate sandbox.
    // If promotion succeeds, skip the normal get/create flow entirely.
    // Gated — no-op when OPENCLAW_HOT_SPARE_ENABLED is not "true".
    let sandbox: SandboxHandle | undefined;
    if (isHotSpareEnabled()) {
      try {
        const promoteResult = await promoteHotSpare(current, {
          get: (opts) => getSandboxController().get(opts),
        });
        if (promoteResult.status === "promoted" && promoteResult.promotedSandboxId) {
          sandbox = await getSandboxController().get({ sandboxId: promoteResult.promotedSandboxId });
          await mutateMeta((m) => applyPromoteToMeta(m, promoteResult));
          progress.appendLine("system", `Hot-spare promoted: ${sandbox.sandboxId}`);
          logInfo("sandbox.create.hot_spare_promoted", ctx({
            promotedSandboxId: sandbox.sandboxId,
          }));
        } else if (promoteResult.status === "failed") {
          // Promotion failed — clear stale hot-spare state and fall through.
          await mutateMeta((m) => clearHotSpareState(m));
          logInfo("sandbox.create.hot_spare_fallback", ctx({
            error: promoteResult.error,
          }));
        }
      } catch (err) {
        logWarn("sandbox.create.hot_spare_promote_error", ctx({
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    // Normal path: get() first (auto-resumes stopped persistent sandbox in
    // one call).  Fall back to create() only if the sandbox doesn't exist yet.
    if (!sandbox) {
    try {
      progress.appendLine("system", `Resuming persistent sandbox: ${sandboxName}`);
      sandbox = await getSandboxController().get({ sandboxId: sandboxName });
      progress.appendLine("system", `Resumed: ${sandbox.sandboxId} status=${sandbox.status}`);
    } catch {
      progress.appendLine("system", `No existing sandbox — creating: ${sandboxName}`);
      try {
        sandbox = await getSandboxController().create({
          name: sandboxName,
          persistent: true,
          ports: SANDBOX_PORTS,
          timeout: sleepAfterMs,
          resources: { vcpus },
          ...(await buildRuntimeEnv()),
        });
        progress.appendLine("system", `Created: ${sandbox.sandboxId}`);
      } catch (createErr) {
        const apiJson = (createErr as { json?: unknown }).json;
        logError("sandbox.create.failed", ctx({
          sandboxName,
          error: createErr instanceof Error ? createErr.message : String(createErr),
          ...(apiJson ? { apiJson } : {}),
        }));
        progress.appendLine("system", `Create failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        throw createErr;
      }
    }
    } // end if (!sandbox)

    logInfo("sandbox.status_transition", ctx({ from: "creating", to: "setup", sandboxId: sandbox.sandboxId, sandboxStatus: sandbox.status, vcpus, sleepAfterMs }));
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
    });

    // Detect resumed persistent sandbox by checking if the openclaw binary
    // exists on disk (sub-ms stat) instead of running it (loads 577MB package).
    const whichCheck = await sandbox.runCommand("bash", [
      "-c", `test -x "$(command -v ${OPENCLAW_BIN} 2>/dev/null)" && echo yes || echo no`,
    ]);
    const isResumed = (await whichCheck.output("stdout")).trim() === "yes";
    progress.appendLine("system", isResumed ? "Persistent sandbox resumed" : "Fresh sandbox");

    if (isResumed) {
      // Resumed persistent sandbox — run fast restore (update config/tokens, restart gateway)
      const resumeStart = Date.now();
      logInfo("sandbox.create.persistent_resume", ctx({ sandboxId: sandbox.sandboxId }));
      progress.setPhase("resuming-sandbox", "Resuming persistent sandbox");
      progress.appendLine("system", "Resumed persistent sandbox — running fast restore");

      const latest = await getInitializedMeta();
      const freshApiKey = credential?.token;

      const restoreEnv = buildRestoreRuntimeEnv({
        gatewayToken: latest.gatewayToken,
        apiKey: freshApiKey,
      });

      const assetSyncStart = Date.now();
      const slackConfig = latest.channels.slack;
      await syncRestoreAssetsIfNeeded(sandbox, {
        origin,
        telegramBotToken: latest.channels.telegram?.botToken,
        telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
        slackCredentials: slackConfig ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret } : undefined,
        whatsappConfig: toWhatsAppGatewayConfig(latest.channels.whatsapp),
      });
      const assetSyncMs = Date.now() - assetSyncStart;

      progress.setPhase("starting-gateway", "Running fast restore script");
      const READINESS_TIMEOUT_SECONDS = 30;
      const fastRestoreStart = Date.now();
      const restoreResult = await sandbox.runCommand({
        cmd: "bash",
        args: [
          OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
          String(READINESS_TIMEOUT_SECONDS),
        ],
        env: restoreEnv,
      });
      const startupScriptMs = Date.now() - fastRestoreStart;

      if (restoreResult.exitCode !== 0) {
        const output = await restoreResult.output("both");
        throw new CommandFailedError({
          command: "fast-restore-script",
          exitCode: restoreResult.exitCode,
          output,
        });
      }

      // Parse readiness timing from fast-restore script stdout.
      let localReadyMs = startupScriptMs;
      try {
        const stdout = await restoreResult.output("stdout");
        const parsed = JSON.parse(stdout.trim());
        if (typeof parsed.readyMs === "number") localReadyMs = parsed.readyMs;
      } catch { /* best effort */ }

      // Apply firewall policy
      const firewallStart = Date.now();
      try {
        progress.setPhase("applying-firewall", `Applying ${latest.firewall.mode} firewall policy`);
        await applyFirewallPolicyToSandbox(sandbox, latest, freshApiKey);
      } catch (err) {
        const firewallError = err instanceof Error ? err.message : String(err);
        logWarn("sandbox.create.persistent_resume.firewall_sync_failed", ctx({
          sandboxId: sandbox.sandboxId,
          mode: latest.firewall.mode,
          error: firewallError,
        }));
        if (latest.firewall.mode === "enforcing") {
          throw new Error(`Firewall sync failed during persistent resume: ${firewallError}`);
        }
      }
      const firewallSyncMs = Date.now() - firewallStart;

      const sandboxResumeMs = Date.now() - resumeStart - assetSyncMs - startupScriptMs - firewallSyncMs;
      const totalMs = Date.now() - resumeStart;

      const metrics: RestorePhaseMetrics = {
        sandboxCreateMs: sandboxResumeMs,
        tokenWriteMs: 0,
        assetSyncMs,
        startupScriptMs,
        forcePairMs: 0,
        firewallSyncMs,
        localReadyMs,
        publicReadyMs: 0,
        totalMs,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus,
        recordedAt: Date.now(),
        skippedPublicReady: true,
      };

      // Record token metadata and restore metrics.
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = sandbox.sandboxId;
        meta.portUrls = resolvePortUrls(sandbox);
        meta.lastAccessedAt = Date.now();
        meta.lastError = null;
        meta.lastRestoreMetrics = metrics;
        if (!meta.restoreHistory) meta.restoreHistory = [];
        meta.restoreHistory = [
          metrics,
          ...meta.restoreHistory.slice(0, 19),
        ];
        if (credential) {
          meta.lastTokenRefreshAt = Date.now();
          meta.lastTokenSource = credential.source;
          meta.lastTokenExpiresAt = credential.expiresAt ?? null;
        }
      });
      await progress.completeSetupProgress("Sandbox resumed");

      logInfo("sandbox.create.persistent_resume.complete", ctx({
        sandboxId: sandbox.sandboxId,
        totalMs,
        assetSyncMs,
        startupScriptMs,
        firewallSyncMs,
        localReadyMs,
      }));
      return getInitializedMeta();
    }

    // Fresh sandbox — run full bootstrap
    const latest = await getInitializedMeta();
    // Reuse the already-resolved credential for firewall policy transforms.
    const apiKey = credential?.token;
    const slackCfg = latest.channels.slack;
    const setupResult = await setupOpenClaw(sandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey,
      proxyOrigin: origin,
      telegramBotToken: latest.channels.telegram?.botToken,
      telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
      slackCredentials: slackCfg ? { botToken: slackCfg.botToken, signingSecret: slackCfg.signingSecret } : undefined,
      whatsappConfig: toWhatsAppGatewayConfig(latest.channels.whatsapp),
      progress,
    });

    const pending = await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.startupScript = setupResult.startupScript;
      meta.openclawVersion = setupResult.openclawVersion;
      meta.lastError = null;
      // Record token metadata from the credential used during boot.
      if (credential) {
        meta.lastTokenRefreshAt = Date.now();
        meta.lastTokenSource = credential.source;
        meta.lastTokenExpiresAt = credential.expiresAt ?? null;
      }
    });

    // Apply firewall policy and record structured outcome before marking running.
    const firewallPolicy = toNetworkPolicy(
      pending.firewall.mode,
      pending.firewall.allowlist,
      apiKey,
    );
    const firewallPolicyHash = createHash("sha256")
      .update(JSON.stringify(firewallPolicy))
      .digest("hex");

    let firewallApplied = false;
    let firewallError: string | null = null;
    const firewallStartedAt = Date.now();
    try {
      progress.setPhase("applying-firewall", `Applying ${pending.firewall.mode} firewall policy`);
      await applyFirewallPolicyToSandbox(sandbox, pending, apiKey);
      firewallApplied = true;
    } catch (err) {
      firewallError = err instanceof Error ? err.message : String(err);
      logWarn("sandbox.create.firewall_sync_failed", ctx({
        sandboxId: sandbox.sandboxId,
        mode: pending.firewall.mode,
        error: firewallError,
      }));
    }
    const firewallCompletedAt = Date.now();
    const firewallDurationMs = firewallCompletedAt - firewallStartedAt;

    // Record firewall sync outcome in metadata.
    await mutateMeta((meta) => {
      const outcome: import("@/shared/types").FirewallSyncOutcome = {
        timestamp: firewallCompletedAt,
        durationMs: firewallDurationMs,
        allowlistCount: pending.firewall.allowlist.length,
        policyHash: firewallPolicyHash,
        applied: firewallApplied,
        reason: firewallApplied ? "create-policy-applied" : "create-policy-failed",
      };
      meta.firewall.lastSyncReason = outcome.reason;
      meta.firewall.lastSyncOutcome = outcome;
      if (firewallApplied) {
        meta.firewall.lastSyncAppliedAt = firewallCompletedAt;
      } else {
        meta.firewall.lastSyncFailedAt = firewallCompletedAt;
      }
    });

    // In enforcing mode, firewall sync failure is a hard blocker — the
    // sandbox must not become available without its network policy applied.
    if (!firewallApplied && pending.firewall.mode === "enforcing") {
      logError("sandbox.create.firewall_sync_blocked_create", ctx({
        sandboxId: sandbox.sandboxId,
        error: firewallError,
      }));

      try {
        await sandbox.stop({ blocking: true });
      } catch (stopError) {
        logWarn("sandbox.create.firewall_sync_cleanup_failed", ctx({
          sandboxId: sandbox.sandboxId,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        }));
      }

      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError = `Firewall sync failed during create: ${firewallError}`;
        meta.sandboxId = null;
        meta.portUrls = null;
      });
      await progress.failSetupProgress(`Firewall sync failed during create: ${firewallError}`);

      return getInitializedMeta();
    }

    logInfo("sandbox.status_transition", ctx({
      from: "setup",
      to: "running",
      sandboxId: sandbox.sandboxId,
    }));

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.lastError = null;
    });
    await progress.completeSetupProgress("Sandbox ready");

    logInfo("sandbox.create.complete", ctx({
      sandboxId: sandbox.sandboxId,
      openclawVersion: setupResult.openclawVersion,
      firewallApplied,
    }));
    return getInitializedMeta();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await progress.failSetupProgress(errMsg);
    throw error;
  }
}

async function _restoreSandboxFromSnapshot(
  origin: string,
  options?: { skipPublicReady?: boolean; op?: OperationContext },
): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const op = options?.op;
    const phaseTimings: Record<string, number> = {};
    const markPhase = (label: string) => { phaseTimings[label] = Date.now(); };
    const elapsedSince = (label: string) => {
      const start = phaseTimings[label];
      if (start === undefined) {
        logWarn("sandbox.restore.timing.missing_mark", { label });
        return 0;
      }
      return Date.now() - start;
    };

    /** Emit a restore-phase log with operation context when available. */
    const logPhase = (phase: string, extra?: Record<string, unknown>) => {
      const baseExtra = { phase, ...extra };
      if (op) {
        logInfo("sandbox.restore.phase_complete", withOperationContext(op, baseExtra));
      } else {
        logInfo("sandbox.restore.timing", baseExtra);
      }
    };

    markPhase("getMeta1");
    const current = await getInitializedMeta();
    logPhase("getMeta1", { ms: elapsedSince("getMeta1") });
    if (current.status === "running" && current.sandboxId) {
      return current;
    }
    if (!current.snapshotId) {
      return createAndBootstrapSandboxWithinLifecycleLock(origin, { op });
    }

    // Auth-required boot: on Vercel, require a usable AI Gateway credential.
    markPhase("oidc");
    const credential = await resolveAiGatewayCredentialOptional();
    logPhase("oidc", { ms: elapsedSince("oidc") });
    if (isVercelDeployment() && !credential) {
      logError("sandbox.restore.no_ai_gateway_credential", {
        message: "Cannot restore sandbox on Vercel without AI Gateway credential. OIDC may be temporarily unavailable.",
      });
      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError =
          "AI Gateway credential unavailable during sandbox restore. " +
          "OIDC may be temporarily unavailable — retry will be attempted automatically.";
      });
      return getInitializedMeta();
    }

    const skipPublicReady = options?.skipPublicReady ?? false;
    const restoreStartedAt = Date.now();
    const vcpus = getSandboxVcpus();
    const sleepAfterMs = getSandboxSleepAfterMs();

    if (op) {
      logInfo("sandbox.status_transition", withOperationContext(op, {
        from: current.status, to: "restoring", snapshotId: current.snapshotId, sleepAfterMs,
      }));
    } else {
      logInfo("sandbox.status_transition", { from: current.status, to: "restoring", snapshotId: current.snapshotId, sleepAfterMs });
    }
    markPhase("mutateMeta1");
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.lastError = null;
    });
    logPhase("mutateMeta_restoring", { ms: elapsedSince("mutateMeta1") });

    // Build all payloads before Sandbox.create.  Config, credentials, and
    // firewall policy are resolved here so zero writeFiles() calls are
    // needed on the hot path.
    const freshApiKey = credential?.token;
    markPhase("getMeta2");
    const latest = await getInitializedMeta();
    logInfo("sandbox.restore.timing", { phase: "getMeta2", ms: elapsedSince("getMeta2") });
    const slackConfig = latest.channels.slack;

    // Config JSON for the gateway — passed via env, written locally by script.
    // The config contains the same data that would be in openclaw.json on disk
    // (model list, proxy origins, channel config).  Base64 is for transport
    // only — these values end up on the sandbox filesystem regardless.
    // Secrets (API key, bot tokens) are also passed as separate env vars for
    // the startup script; they appear in the config for OpenClaw's own use.
    // External manifest hash comparison — avoids in-sandbox readFileToBuffer
    // (~2-3s) for the static asset skip check.  Use snapshot-truth only.
    // A legacy snapshot may have lastRestoreMetrics.assetSha256 from a prior
    // background sync even though the snapshot image itself never contained
    // those files (e.g. worker-sandbox assets added after the snapshot).
    const currentManifest = buildRestoreAssetManifest();
    const snapshotAssetHash = latest.snapshotAssetSha256;
    const skippedStaticAssetSync =
      snapshotAssetHash === currentManifest.sha256;

    const restoreEnv = buildRestoreRuntimeEnv({
      gatewayToken: latest.gatewayToken,
      apiKey: freshApiKey,
    });

    // Hot-spare promotion attempt — skip the normal Sandbox.create() if a
    // freshness-gated candidate already exists.
    let sandbox: SandboxHandle | null = null;
    let sandboxCreateMs = 0;
    let hotSpareHit = false;
    let hotSparePromotionMs = 0;
    let hotSpareRejectReason: string | null = null;

    const desiredDynamicConfigHash =
      latest.snapshotDynamicConfigHash ?? latest.snapshotConfigHash;
    const desiredAssetSha256 = latest.snapshotAssetSha256;

    const hotSpareDecision = evaluateHotSparePromotion({
      hotSpare: latest.hotSpare,
      desiredSnapshotId: current.snapshotId,
      desiredDynamicConfigHash,
      desiredAssetSha256,
    });

    logInfo("sandbox.restore.hot_spare_considered", {
      snapshotId: current.snapshotId,
      candidateSandboxId: latest.hotSpare?.candidateSandboxId ?? null,
      decision: hotSpareDecision.reason,
    });
    if (!hotSpareDecision.ok) {
      hotSpareRejectReason = hotSpareDecision.reason;
    }

    if (hotSpareDecision.ok && latest.hotSpare?.candidateSandboxId) {
      const promotionStartedAt = Date.now();
      const promoteResult = await promoteHotSpare(latest, {
        get: (opts) => getSandboxController().get(opts),
      });

      if (promoteResult.status === "promoted" && promoteResult.promotedSandboxId) {
        sandbox = await getSandboxController().get({
          sandboxId: promoteResult.promotedSandboxId,
        });
        await mutateMeta((meta) => applyPromoteToMeta(meta, promoteResult));
        hotSpareHit = true;
        hotSparePromotionMs = Date.now() - promotionStartedAt;
        logInfo("sandbox.restore.hot_spare_promoted", {
          promotedSandboxId: sandbox.sandboxId,
          hotSparePromotionMs,
          snapshotId: current.snapshotId,
        });
      } else {
        hotSpareRejectReason = promoteResult.error ?? promoteResult.status;
        logWarn("sandbox.restore.hot_spare_promotion_failed", {
          snapshotId: current.snapshotId,
          candidateSandboxId: latest.hotSpare?.candidateSandboxId ?? null,
          error: hotSpareRejectReason,
        });
      }
    }

    if (!sandbox) {
      const sandboxCreateStart = Date.now();
      const createParams = {
        ports: SANDBOX_PORTS,
        timeout: sleepAfterMs,
        resources: { vcpus },
        source: {
          type: "snapshot" as const,
          snapshotId: current.snapshotId,
        },
        env: restoreEnv,
        // networkPolicy on snapshot restore returns 400 — apply post-create
      };
      try {
        sandbox = await getSandboxController().create(createParams);
      } catch (createError) {
        // Log full API error details for diagnosing 400s from the sandbox API
        const apiJson = (createError as { json?: unknown }).json;
        const apiText = (createError as { text?: unknown }).text;
        logError("sandbox.restore.create_failed", {
          snapshotId: current.snapshotId,
          error: createError instanceof Error ? createError.message : String(createError),
          ...(apiJson ? { apiErrorJson: apiJson } : {}),
          ...(apiText ? { apiErrorText: apiText } : {}),
          envKeys: Object.keys(restoreEnv),
          envSizes: Object.fromEntries(Object.entries(restoreEnv).map(([k, v]) => [k, v.length])),
        });
        throw createError;
      }
      sandboxCreateMs = Date.now() - sandboxCreateStart;
      logPhase("sandboxCreate", { ms: sandboxCreateMs, sandboxId: sandbox.sandboxId, snapshotId: current.snapshotId });
    }

    markPhase("mutateMeta2");
    await mutateMeta((meta) => {
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
    });
    logPhase("mutateMeta_sandboxId", { ms: elapsedSince("mutateMeta2") });

    // Credentials go via env. Config file (openclaw.json) is skipped when
    // the snapshot's config hash matches (same channels, same deploy).
    // This avoids a ~6s writeFiles API call on the common restore path.
    const tokenWriteMs = 0;
    const forcePairMs = 0;

    const currentConfigHashInput: GatewayConfigHashInput = {
      telegramBotToken: latest.channels.telegram?.botToken,
      telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
      slackCredentials: slackConfig
        ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
        : undefined,
      whatsappConfig: toWhatsAppGatewayConfig(latest.channels.whatsapp),
    };
    const currentConfigHash = computeGatewayConfigHash(currentConfigHashInput);
    // Restore skip gates use snapshot-truth fields only — never runtime-truth.
    const snapshotHash = latest.snapshotDynamicConfigHash ?? latest.snapshotConfigHash;
    const skippedDynamicConfigSync =
      snapshotHash !== null &&
      snapshotHash === currentConfigHash;
    const dynamicConfigReason: "hash-match" | "hash-miss" | "no-snapshot-hash" =
      snapshotHash === null
        ? "no-snapshot-hash"
        : skippedDynamicConfigSync
          ? "hash-match"
          : "hash-miss";
    logInfo("sandbox.restore.config_hash_checkpoint", {
      snapshotDynamicConfigHash: snapshotHash,
      snapshotConfigHash: latest.snapshotConfigHash,
      currentConfigHash,
      hashVersion: GATEWAY_CONFIG_HASH_VERSION,
      dynamicConfigReason,
      skippedDynamicConfigSync,
    });
    const skippedConfigWrite = skippedDynamicConfigSync;

    const assetSyncStart = Date.now();
    if (skippedConfigWrite) {
      logInfo("sandbox.restore.config_write_skipped", {
        configHash: currentConfigHash,
        sandboxId: sandbox.sandboxId,
      });
    } else {
      await sandbox.writeFiles(
        buildDynamicRestoreFiles({
          proxyOrigin: origin,
          telegramBotToken: latest.channels.telegram?.botToken,
          telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
          slackCredentials: slackConfig ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret } : undefined,
          whatsappConfig: toWhatsAppGatewayConfig(latest.channels.whatsapp),
        }),
      );
      logInfo("sandbox.restore.config_written", {
        configHash: currentConfigHash,
        snapshotConfigHash: latest.snapshotConfigHash,
        sandboxId: sandbox.sandboxId,
      });
    }
    if (!skippedStaticAssetSync) {
      const workerSandboxFiles = buildWorkerSandboxRestoreFiles();
      await sandbox.writeFiles(workerSandboxFiles);
      logInfo("sandbox.restore.worker_sandbox_assets_preloaded", {
        sandboxId: sandbox.sandboxId,
        paths: workerSandboxFiles.map((file) => file.path),
      });
    }
    const assetSyncMs = Date.now() - assetSyncStart;

    markPhase("mutateMeta3");
    const next = await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
    });
    logPhase("mutateMeta_booting", { ms: elapsedSince("mutateMeta3"), sandboxId: sandbox.sandboxId, status: "booting" });

    // Config is written via writeFiles() above (or baked into the snapshot).
    // Gateway token and API key are passed via create-time env.
    // The fast-restore script reads credentials from env and config from disk.
    const READINESS_TIMEOUT_SECONDS = 30;
    const bootOverlapStart = Date.now();
    let firewallSyncMs = 0;
    let startupScriptMs = 0;
    let localReadyMs = 0;

    // Pre-compute firewall policy hash for structured outcome reporting.
    const requestedFirewallPolicy = toNetworkPolicy(
      next.firewall.mode,
      next.firewall.allowlist,
      freshApiKey,
    );
    const requestedFirewallPolicyHash = createHash("sha256")
      .update(JSON.stringify(requestedFirewallPolicy))
      .digest("hex");

    // Firewall policy applied post-create (networkPolicy on snapshot restore
    // returns 400).  Runs concurrently with the fast-restore script below.
    // Returns a structured result so enforcing mode can gate readiness.
    const firewallPromise = (async () => {
      const startedAt = Date.now();
      try {
        await applyFirewallPolicyToSandbox(sandbox, next, freshApiKey);
        const completedAt = Date.now();
        return {
          ok: true as const,
          completedAt,
          durationMs: completedAt - startedAt,
          error: null,
          outcome: {
            timestamp: completedAt,
            durationMs: completedAt - startedAt,
            allowlistCount: next.firewall.allowlist.length,
            policyHash: requestedFirewallPolicyHash,
            applied: true,
            reason: "restore-policy-applied",
          } satisfies import("@/shared/types").FirewallSyncOutcome,
        };
      } catch (err) {
        const completedAt = Date.now();
        const error = err instanceof Error ? err.message : String(err);
        logWarn("sandbox.restore.firewall_sync_failed", {
          sandboxId: sandbox.sandboxId,
          mode: next.firewall.mode,
          error,
        });
        return {
          ok: false as const,
          completedAt,
          durationMs: completedAt - startedAt,
          error,
          outcome: {
            timestamp: completedAt,
            durationMs: completedAt - startedAt,
            allowlistCount: next.firewall.allowlist.length,
            policyHash: requestedFirewallPolicyHash,
            applied: false,
            reason: "restore-policy-failed",
          } satisfies import("@/shared/types").FirewallSyncOutcome,
        };
      }
    })();

    {
      const t0 = Date.now();
      logInfo("sandbox.restore.fast_restore_start", { sandboxId: sandbox.sandboxId });
      const restoreResult = await sandbox.runCommand("bash", [
        OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
        String(READINESS_TIMEOUT_SECONDS),
      ]);

        startupScriptMs = Date.now() - t0;

        const stdout = await restoreResult.output("stdout");
        let stderr = "";
        let stderrUnavailable = false;
        try {
          stderr = await restoreResult.output("stderr");
        } catch {
          stderrUnavailable = true;
        }

        logStateSnapshot({
          event:
            restoreResult.exitCode === 0
              ? "sandbox.restore.fast_restore_result"
              : "sandbox.restore.fast_restore_failed",
          level: restoreResult.exitCode === 0 ? "info" : "error",
          meta: next,
          op,
          extra: {
            sandboxId: sandbox.sandboxId,
            exitCode: restoreResult.exitCode,
            stdoutHead: stdout.slice(0, 500),
            stderrHead: stderr.slice(0, 500),
            stderrUnavailable,
            startupScriptMs,
          },
        });

        if (restoreResult.exitCode !== 0) {
          throw new CommandFailedError({
            command: "fast-restore-script",
            exitCode: restoreResult.exitCode,
            output: [stdout, stderr].filter(Boolean).join("\n"),
          });
        }

        // Parse the JSON readiness report from stdout.
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            ready?: boolean;
            attempts?: number;
            readyMs?: number;
          };

          localReadyMs =
            typeof parsed.readyMs === "number" ? parsed.readyMs : startupScriptMs;

          logStateSnapshot({
            event: "sandbox.restore.local_ready_report",
            meta: next,
            op,
            extra: {
              sandboxId: sandbox.sandboxId,
              ready: parsed.ready === true,
              attempts:
                typeof parsed.attempts === "number" ? parsed.attempts : null,
              readyMs: typeof parsed.readyMs === "number" ? parsed.readyMs : null,
              startupScriptMs,
            },
          });
        } catch {
          // Fallback: script exited 0 so gateway is ready.
          localReadyMs = startupScriptMs;
        }

        logPhase("local_ready", {
          startupScriptMs,
          localReadyMs,
          sandboxId: sandbox.sandboxId,
          status: "booting",
        });
    }

    // Await firewall sync result — overlapped with boot above.
    const firewallResult = await firewallPromise;
    firewallSyncMs = firewallResult.durationMs;
    const bootOverlapMs = Date.now() - bootOverlapStart;

    // Record firewall sync outcome in metadata regardless of success/failure.
    await mutateMeta((meta) => {
      meta.firewall.lastSyncReason = firewallResult.outcome.reason;
      meta.firewall.lastSyncOutcome = firewallResult.outcome;
      if (firewallResult.ok) {
        meta.firewall.lastSyncAppliedAt = firewallResult.completedAt;
      } else {
        meta.firewall.lastSyncFailedAt = firewallResult.completedAt;
      }
    });

    logPhase("boot_overlap_complete", {
      bootOverlapMs,
      firewallSyncMs,
      localReadyMs,
      sandboxId: sandbox.sandboxId,
      firewallApplied: firewallResult.ok,
    });

    // In enforcing mode, firewall sync failure is a hard blocker — the
    // sandbox must not become available without its network policy applied.
    if (!firewallResult.ok && next.firewall.mode === "enforcing") {
      logError("sandbox.restore.firewall_sync_blocked_restore", {
        sandboxId: sandbox.sandboxId,
        error: firewallResult.error,
      });

      try {
        await sandbox.stop({ blocking: true });
      } catch (stopError) {
        logWarn("sandbox.restore.firewall_sync_cleanup_failed", {
          sandboxId: sandbox.sandboxId,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      }

      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError = `Firewall sync failed during restore: ${firewallResult.error}`;
        meta.sandboxId = null;
        meta.portUrls = null;
      });

      return getInitializedMeta();
    }

    // Restore cron jobs if they were lost during the snapshot/restore cycle.
    // OpenClaw normally preserves jobs.json across restarts, but edge cases
    // (partial writes during gateway restart, config-triggered re-init, or
    // snapshots taken after a transient empty state) can cause job loss.
    // We persist the full jobs JSON to the store before each snapshot and
    // heartbeat as a safety net.  If the restored sandbox has no jobs but
    // the store does, write them back and restart the gateway to reload.
    let cronRestoreOutcome: CronRestoreOutcome = "no-store-jobs";
    try {
      const storedRecord = parseStoredCronRecord(
        await getStore().getValue<unknown>(cronJobsKey()),
      );
      if (storedRecord && storedRecord.jobCount > 0) {
        // Check current jobs.json — only restore if gateway wiped it.
        const currentBuf = await sandbox.readFileToBuffer({ path: CRON_JOBS_PATH });
        const currentData = currentBuf
          ? (JSON.parse(currentBuf.toString("utf8")) as { jobs?: unknown[] })
          : { jobs: [] };
        if (!Array.isArray(currentData.jobs) || currentData.jobs.length === 0) {
          await sandbox.writeFiles([{
            path: CRON_JOBS_PATH,
            content: Buffer.from(storedRecord.jobsJson),
          }]);
          // Restart gateway so cron module re-reads the restored jobs.
          await restartGateway(sandbox);
          // Wait for the restarted gateway to become ready.
          await pollUntil({
            label: "cron-restore-gateway-ready",
            timeoutMs: 15_000,
            initialDelayMs: 200,
            maxDelayMs: 500,
            step: async () => {
              const result = await sandbox.runCommand("bash", [
                "-c",
                `curl -s -f --max-time 1 http://localhost:${OPENCLAW_PORT}/ 2>/dev/null | grep -q 'openclaw-app' && echo ok || echo not-ready`,
              ]);
              const out = await result.output("stdout");
              if (out.trim() === "ok") return { done: true, result: true };
              return { done: false };
            },
            timeoutError: () => new Error("Gateway did not become ready after cron jobs restore"),
          });
          const restoredBuf = await sandbox.readFileToBuffer({ path: CRON_JOBS_PATH });
          const restoredData = restoredBuf
            ? (JSON.parse(restoredBuf.toString("utf8")) as { jobs?: unknown[] })
            : { jobs: [] };
          const restoredJobCount = Array.isArray(restoredData.jobs) ? restoredData.jobs.length : 0;
          cronRestoreOutcome =
            restoredJobCount === storedRecord.jobCount
              ? "restored-verified"
              : "restore-unverified";
          logInfo("sandbox.restore.cron_jobs_restored", {
            sandboxId: sandbox.sandboxId,
            jobCount: storedRecord.jobCount,
            restoredJobCount,
            storedSha256: storedRecord.sha256,
            storedSource: storedRecord.source,
            verified: cronRestoreOutcome === "restored-verified",
          });
        } else {
          cronRestoreOutcome = "already-present";
        }
      } else if (!storedRecord) {
        cronRestoreOutcome = "no-store-jobs";
      }
    } catch (err) {
      cronRestoreOutcome = "restore-failed";
      // Non-critical — cron jobs are a convenience, not a hard requirement.
      logWarn("sandbox.restore.cron_jobs_restore_failed", {
        sandboxId: sandbox.sandboxId,
        cronRestoreOutcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Gateway is locally healthy and firewall is confirmed (or not enforcing)
    // — mark as running so callers that poll metadata see the correct state.
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.lastError = null;
      // Record token metadata from the credential used during restore.
      if (credential) {
        meta.lastTokenRefreshAt = Date.now();
        meta.lastTokenSource = credential.source;
        meta.lastTokenExpiresAt = credential.expiresAt ?? null;
      }
    });

    // Re-register the Telegram webhook if configured.  Old snapshots may
    // contain a startup script that calls deleteWebhook, which clears the
    // webhook URL on Telegram's side.  Re-registering here ensures the
    // webhook is always active after a restore, regardless of what the
    // baked-in startup script did.
    if (latest.channels.telegram?.botToken && latest.channels.telegram?.webhookUrl) {
      try {
        const { reconcileTelegramIntegration } = await import("@/server/channels/telegram/reconcile");
        await reconcileTelegramIntegration({ force: true });
        logInfo("sandbox.restore.telegram_webhook_reconciled", {
          webhookUrl: redactBypassParam(latest.channels.telegram.webhookUrl),
        });
      } catch (err) {
        logWarn("sandbox.restore.telegram_webhook_reconcile_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Background static asset sync — not on the hot path.  The gateway
    // already booted with the snapshot's cached scripts/skills.  This
    // updates them to the current deploy version for the next session.
    // On success, update lastRestoreMetrics.assetSha256 so the next
    // restore can skip the sync.
    if (!skippedStaticAssetSync) {
      syncRestoreAssetsIfNeeded(sandbox, {
        origin,
        telegramBotToken: latest.channels.telegram?.botToken,
        telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
        slackCredentials: slackConfig ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret } : undefined,
        whatsappConfig: toWhatsAppGatewayConfig(latest.channels.whatsapp),
      }).then(async (result) => {
        await mutateMeta((m) => {
          if (m.lastRestoreMetrics) {
            // Keep the hot-path skip flag truthful for the restore that already happened.
            m.lastRestoreMetrics.assetSha256 = result.assetSha256;
          }
          // Runtime-truth only — snapshot-truth is stamped only by snapshot
          // creation paths.
          m.runtimeAssetSha256 = result.assetSha256;
          if (
            m.restorePreparedStatus === "ready" ||
            m.restorePreparedStatus === "unknown"
          ) {
            m.restorePreparedStatus = "dirty";
            m.restorePreparedReason = "static-assets-changed";
          }

          // Move oracle to pending unless it is mid-cycle.
          if (m.restoreOracle.status !== "running") {
            m.restoreOracle.status = "pending";
          }
          m.restoreOracle.pendingReason = "static-assets-changed";
          m.restoreOracle.lastBlockedReason = null;
        });
        logInfo("sandbox.restore.background_asset_sync_complete", {
          assetSha256: result.assetSha256,
        });
      }).catch((err) => {
        logWarn("sandbox.restore.background_asset_sync_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Public readiness probe — skipped for non-waiting callers (background
    // ensure) since the gateway is locally healthy and the public route will
    // converge on its own.  Callers that explicitly wait (ensure?wait=1,
    // channel drains) go through waitForSandboxReady which polls probeGatewayReady.
    let publicReadyMs = 0;
    if (!skipPublicReady) {
      const publicReadyStart = Date.now();
      try {
        await waitForPublicGatewayReady({
          maxAttempts: 20,
          delayMs: 250,
          timeoutMs: 1_000,
        });
      } catch (err) {
        logInfo("sandbox.restore.public_ready_failed", {
          sandboxId: sandbox.sandboxId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      publicReadyMs = Date.now() - publicReadyStart;
    } else {
      logInfo("sandbox.restore.public_ready_skipped", {
        sandboxId: sandbox.sandboxId,
      });
    }

    const totalMs = Date.now() - restoreStartedAt;

    const metrics: RestorePhaseMetrics = {
      sandboxCreateMs,
      tokenWriteMs,
      assetSyncMs,
      startupScriptMs,
      forcePairMs,
      firewallSyncMs,
      localReadyMs,
      publicReadyMs,
      totalMs,
      skippedStaticAssetSync,
      skippedDynamicConfigSync,
      dynamicConfigHash: currentConfigHash,
      dynamicConfigReason,
      // Only record the new hash if sync was skipped (already matched) or
      // completed.  If background sync is pending, keep the old hash so
      // the next restore retries if it fails.
      assetSha256: skippedStaticAssetSync
        ? currentManifest.sha256
        : (latest.lastRestoreMetrics?.assetSha256 ?? null),
      vcpus,
      recordedAt: Date.now(),
      bootOverlapMs,
      skippedPublicReady: skipPublicReady,
      cronRestoreOutcome,
      hotSpareHit,
      hotSparePromotionMs: hotSpareHit ? hotSparePromotionMs : 0,
      hotSpareRejectReason,
    };

    if (op) {
      logInfo("sandbox.restore.metrics", withOperationContext(op, metrics as unknown as Record<string, unknown>));
    } else {
      logInfo("sandbox.restore.metrics", metrics as unknown as Record<string, unknown>);
    }

    await mutateMeta((meta) => {
      meta.lastRestoreMetrics = metrics;
      meta.restoreHistory = [metrics, ...(meta.restoreHistory ?? [])].slice(
        0,
        MAX_RESTORE_HISTORY,
      );
      // Runtime-truth: what is actually on the running sandbox right now.
      meta.runtimeDynamicConfigHash = currentConfigHash;
      meta.runtimeAssetSha256 = skippedStaticAssetSync
        ? currentManifest.sha256
        : (meta.runtimeAssetSha256 ?? null);
    });

    return getInitializedMeta();
  });
}

// ---------------------------------------------------------------------------
// Restore asset sync
// ---------------------------------------------------------------------------

async function syncRestoreAssetsIfNeeded(
  sandbox: SandboxHandle,
  options: {
    origin: string;
    telegramBotToken?: string;
    telegramWebhookSecret?: string;
    slackCredentials?: { botToken: string; signingSecret: string };
    whatsappConfig?: import("@/server/openclaw/config").WhatsAppGatewayConfig;
  },
): Promise<{ skippedStaticAssetSync: boolean; assetSha256: string }> {
  const manifest = buildRestoreAssetManifest();
  const existing = await sandbox.readFileToBuffer({
    path: OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  });

  let existingSha: string | null = null;
  if (existing) {
    try {
      existingSha = (JSON.parse(existing.toString("utf8")) as RestoreAssetManifest).sha256;
    } catch {
      existingSha = null;
    }
  }

  const files = buildDynamicRestoreFiles({
    proxyOrigin: options.origin,
    telegramBotToken: options.telegramBotToken,
    telegramWebhookSecret: options.telegramWebhookSecret,
    slackCredentials: options.slackCredentials,
    whatsappConfig: options.whatsappConfig,
  });

  const skippedStaticAssetSync = existingSha === manifest.sha256;

  if (!skippedStaticAssetSync) {
    files.push(...buildStaticRestoreFiles());
    files.push({
      path: OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
      content: Buffer.from(JSON.stringify(manifest) + "\n"),
    });
  }

  await sandbox.writeFiles(files);

  return {
    skippedStaticAssetSync,
    assetSha256: manifest.sha256,
  };
}

// ---------------------------------------------------------------------------
// Snapshot metadata
// ---------------------------------------------------------------------------

function _recordSnapshotMetadata(
  meta: SingleMeta,
  snapshotId: string,
  reason: string,
  configHash?: string,
  assetSha256?: string,
): void {
  const timestamp = Date.now();
  meta.snapshotId = snapshotId;
  if (configHash) {
    meta.snapshotConfigHash = configHash;
    // Snapshot-truth: this hash describes the config in the snapshot image.
    meta.snapshotDynamicConfigHash = configHash;
  }
  if (assetSha256) {
    meta.snapshotAssetSha256 = assetSha256;
  }
  // A new snapshot means the restore target is now ready.
  meta.restorePreparedStatus = "ready";
  meta.restorePreparedReason = "prepared";
  meta.restorePreparedAt = timestamp;

  // Seal oracle state — the snapshot is verified-ready.
  meta.restoreOracle.status = "ready";
  meta.restoreOracle.pendingReason = null;
  meta.restoreOracle.lastCompletedAt = timestamp;
  meta.restoreOracle.lastBlockedReason = null;
  meta.restoreOracle.lastError = null;
  meta.restoreOracle.consecutiveFailures = 0;
  meta.restoreOracle.lastResult = "prepared";

  meta.snapshotHistory = [
    {
      id: randomUUID(),
      snapshotId,
      timestamp,
      reason,
    },
    ...meta.snapshotHistory,
  ].slice(0, 50);
}

function collectTrackedSnapshotIds(
  meta: Pick<SingleMeta, "snapshotId" | "snapshotHistory">,
): string[] {
  return [...new Set([
    meta.snapshotId,
    ...meta.snapshotHistory.map((record) => record.snapshotId),
  ].filter((snapshotId): snapshotId is string => Boolean(snapshotId)))];
}

async function destroyCurrentSandboxWithoutSnapshot(
  meta: SingleMeta,
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  if (!meta.sandboxId) {
    logInfo("sandbox.reset.destroy_skipped", ctx({ reason: "no_running_sandbox" }));
    return;
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    await sandbox.stop({ blocking: true });
    logInfo("sandbox.reset.destroyed", ctx({ sandboxId: meta.sandboxId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isGone = message.includes("404") || message.includes("410");
    if (isGone) {
      logWarn("sandbox.reset.sandbox_already_gone", ctx({
        sandboxId: meta.sandboxId,
        error: message,
      }));
      return;
    }

    throw new Error(
      `Failed to destroy sandbox ${meta.sandboxId} during reset: ${message}`,
    );
  }
}

async function deleteTrackedSnapshotsForReset(
  snapshotIds: string[],
  deleteSnapshot: (snapshotId: string) => Promise<void>,
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
): Promise<string[]> {
  const failedSnapshotIds: string[] = [];

  for (const snapshotId of snapshotIds) {
    try {
      await deleteSnapshot(snapshotId);
      logInfo("sandbox.reset.snapshot_deleted", ctx({ snapshotId }));
    } catch (error) {
      if (isSnapshotNotFoundError(error)) {
        logInfo("sandbox.reset.snapshot_missing", ctx({ snapshotId }));
        continue;
      }

      failedSnapshotIds.push(snapshotId);
      logError("sandbox.reset.snapshot_delete_error", ctx({
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return failedSnapshotIds;
}

async function clearResetCronState(
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await Promise.all([
    getStore().deleteValue(cronNextWakeKey()),
    getStore().deleteValue(cronJobsKey()),
  ]);
  logInfo("sandbox.reset.cron_state_cleared", ctx());
}

function clearSandboxRuntimeStateForReset(meta: SingleMeta): void {
  meta.sandboxId = null;
  meta.portUrls = null;
  meta.snapshotId = null;
  meta.snapshotConfigHash = null;
  meta.snapshotDynamicConfigHash = null;
  meta.runtimeDynamicConfigHash = null;
  meta.snapshotAssetSha256 = null;
  meta.runtimeAssetSha256 = null;
  meta.restorePreparedStatus = "unknown";
  meta.restorePreparedReason = null;
  meta.restorePreparedAt = null;
  meta.snapshotHistory = [];
  meta.lastRestoreMetrics = null;
  meta.restoreHistory = [];
  meta.lastAccessedAt = null;
  meta.startupScript = null;
  meta.openclawVersion = null;
  meta.lastError = null;
  meta.lifecycleAttemptId = null;

  // Reset oracle to default idle state.
  meta.restoreOracle = {
    status: "idle",
    pendingReason: null,
    lastEvaluatedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastBlockedReason: null,
    lastError: null,
    consecutiveFailures: 0,
    lastResult: null,
  };
}

// ---------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------

async function withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
  const store = getStore();
  const token = await store.acquireLock(lifecycleLockKey(), LIFECYCLE_LOCK_TTL_SECONDS);
  if (!token) {
    throw new LifecycleLockUnavailableError();
  }

  return withAutoRenewedLock(
    {
      key: lifecycleLockKey(),
      token,
      ttlSeconds: LIFECYCLE_LOCK_TTL_SECONDS,
      label: "sandbox.lifecycle",
    },
    fn,
  );
}

async function withAutoRenewedLock<T>(
  options: AutoRenewedLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const store = getStore();
  let stopRenewal = false;
  const intervalMs = Math.max(
    1_000,
    Math.min(LOCK_RENEW_INTERVAL_MS, Math.floor((options.ttlSeconds * 1000) / 2)),
  );

  const interval = setInterval(() => {
    if (stopRenewal) {
      return;
    }

    void store
      .renewLock(options.key, options.token, options.ttlSeconds)
      .then((renewed) => {
        if (!renewed) {
          stopRenewal = true;
          logWarn("sandbox.lock_renewal_lost", {
            key: options.key,
            label: options.label,
          });
        }
      })
      .catch((error) => {
        logWarn("sandbox.lock_renewal_failed", {
          key: options.key,
          label: options.label,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  const maybeUnref = interval as unknown as { unref?: () => void };
  maybeUnref.unref?.();

  try {
    return await fn();
  } finally {
    stopRenewal = true;
    clearInterval(interval);
    await store.releaseLock(options.key, options.token).catch((error) => {
      logWarn("sandbox.lock_release_failed", {
        key: options.key,
        label: options.label,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Remove the `x-vercel-protection-bypass` query parameter from a URL for
 * safe logging. Falls back to regex replacement if the URL is malformed.
 */
function redactBypassParam(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("x-vercel-protection-bypass")) {
      parsed.searchParams.delete("x-vercel-protection-bypass");
      return parsed.toString();
    }
  } catch {
    return url.replace(
      /([?&])x-vercel-protection-bypass=[^&]+(&|$)/,
      (_match, prefix, suffix) =>
        suffix ? prefix : "",
    );
  }
  return url;
}

function resolvePortUrls(sandbox: SandboxHandle): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const port of SANDBOX_PORTS) {
    try {
      urls[String(port)] = sandbox.domain(port);
    } catch {
      // Ignore missing routes.
    }
  }
  return urls;
}

export function isBusyStatus(status: SingleMeta["status"]): boolean {
  return (
    status === "creating" ||
    status === "setup" ||
    status === "restoring" ||
    status === "booting"
  );
}

function isOperationStale(meta: SingleMeta): boolean {
  return Date.now() - meta.updatedAt > STALE_OPERATION_MS;
}

async function buildRuntimeEnv(): Promise<{ env?: Record<string, string> }> {
  // OpenClaw validates API keys internally (via auth-profiles.json) before
  // sending any HTTP request.  The env vars are needed so OpenClaw can
  // populate its auth store at startup.  The network policy header transform
  // provides defense-in-depth by overwriting the Authorization header at the
  // firewall layer — even if OpenClaw sends a stale token, the transform
  // injects the fresh one.
  const token = await getAiGatewayBearerTokenOptional();
  if (!token) {
    return {
      env: {
        OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      },
    };
  }

  return {
    env: {
      AI_GATEWAY_API_KEY: token,
      OPENAI_API_KEY: token,
      OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    },
  };
}
