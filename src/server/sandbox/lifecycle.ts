import { createHash, randomUUID } from "node:crypto";

import { pollUntil } from "@/server/async/poll";
import { ApiError } from "@/shared/http";
import type {
  CronRestoreOutcome,
  OperationContext,
  RestorePhaseMetrics,
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
import { setupOpenClaw, CommandFailedError, waitForGatewayReady } from "@/server/openclaw/bootstrap";
import {
  computeGatewayConfigHash,
  GATEWAY_CONFIG_HASH_VERSION,
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_LOG_FILE,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
  type GatewayConfigHashInput,
} from "@/server/openclaw/config";
import {
  OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  buildDynamicRestoreFiles,
  buildRestoreAssetManifest,
  buildStaticRestoreFiles,
  type RestoreAssetManifest,
} from "@/server/openclaw/restore-assets";
import { getSandboxController } from "@/server/sandbox/controller";
import type { SandboxHandle } from "@/server/sandbox/controller";
import { getSandboxVcpus } from "@/server/sandbox/resources";
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

const OPENCLAW_PORT = 3000;
const SANDBOX_PORTS = [OPENCLAW_PORT, OPENCLAW_TELEGRAM_WEBHOOK_PORT];
export const CRON_NEXT_WAKE_KEY = "openclaw-single:cron-next-wake-ms";
export const CRON_JOBS_KEY = "openclaw-single:cron-jobs-json";
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

const LIFECYCLE_LOCK_KEY = "openclaw-single:lock:lifecycle";
const START_LOCK_KEY = "openclaw-single:lock:start";
const TOKEN_REFRESH_LOCK_KEY = "openclaw-single:lock:token-refresh";
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
    if (meta.status === "stopped" && meta.snapshotId) {
      logInfo("sandbox.already_stopped", { snapshotId: meta.snapshotId });
      return meta;
    }
    if (!meta.sandboxId) {
      throw new ApiError(
        409,
        "SANDBOX_NOT_RUNNING",
        "Sandbox is not running and cannot be stopped.",
      );
    }

    logInfo("sandbox.snapshotting", { sandboxId: meta.sandboxId });
    try {
      const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
      await cleanupBeforeSnapshot(sandbox, meta.firewall.mode);
      const cronWakeRead = await readCronNextWakeFromSandbox(sandbox);
      const snapshot = await sandbox.snapshot();
      // Compute config hash for this snapshot.  The hash covers everything
      // in buildGatewayConfig EXCEPT the proxy origin (which varies per
      // restore) and the API key (passed via env, not in config).  If the
      // hash matches at restore time, the writeFiles call is skipped.
      const configHashInput: GatewayConfigHashInput = {
        telegramBotToken: meta.channels.telegram?.botToken,
        telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
        slackCredentials: meta.channels.slack
          ? {
            botToken: meta.channels.slack.botToken,
            signingSecret: meta.channels.slack.signingSecret,
          }
          : undefined,
      };
      const configHash = computeGatewayConfigHash(configHashInput);

      logInfo("sandbox.status_transition", {
        from: meta.status,
        to: "stopped",
        snapshotId: snapshot.snapshotId,
        configHash,
        cronWakeRead,
      });

      if (cronWakeRead.status === "ok") {
        await getStore().setValue(CRON_NEXT_WAKE_KEY, cronWakeRead.nextWakeMs);
        logInfo("sandbox.cron_wake_saved", { cronNextWakeMs: cronWakeRead.nextWakeMs });
      } else if (cronWakeRead.status === "no-jobs") {
        await getStore().deleteValue(CRON_NEXT_WAKE_KEY);
      }

      // Persist structured cron record as a safety net for snapshot restores.
      // The stop path is authoritative — if there are 0 jobs, the user
      // intentionally deleted them.  Clear the store so a future restore
      // does not resurrect old jobs.
      const rawJobs = cronWakeRead.status !== "error" ? cronWakeRead.rawJobsJson : undefined;
      if (rawJobs) {
        const record = buildCronRecord(rawJobs, "stop");
        if (record) {
          await getStore().setValue(CRON_JOBS_KEY, record);
          logInfo("sandbox.cron_jobs_persisted", {
            source: "stop", jobCount: record.jobCount, sha256: record.sha256,
          });
        }
      } else if (cronWakeRead.status === "no-jobs") {
        await getStore().deleteValue(CRON_JOBS_KEY);
        logInfo("sandbox.cron_jobs_cleared", { reason: "no-jobs-on-stop" });
      }

      return mutateMeta((next) => {
        recordSnapshotMetadata(next, snapshot.snapshotId, "stop", configHash);
        next.sandboxId = null;
        next.portUrls = null;
        next.status = "stopped";
        next.lastAccessedAt = Date.now();
        next.lastError = null;
      });
    } catch (err) {
      // The sandbox may have already been stopped by the platform (timeout
      // expiry, etc.).  The Vercel API returns 404 or 410 in this case.
      // Mark as stopped using the existing snapshot if available so the
      // next ensure can restore from it.
      const message = err instanceof Error ? err.message : String(err);
      const isGone = message.includes("404") || message.includes("410");
      if (isGone && meta.snapshotId) {
        logWarn("sandbox.stop.sandbox_already_gone", {
          sandboxId: meta.sandboxId,
          snapshotId: meta.snapshotId,
          error: message,
        });
        return mutateMeta((next) => {
          next.sandboxId = null;
          next.portUrls = null;
          next.status = "stopped";
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
 * Write an updated openclaw.json into the running sandbox so that OpenClaw's
 * built-in chokidar file watcher detects the change and hot-reloads the
 * affected channel (no gateway restart required).
 *
 * Called after channel credentials are saved or removed in the admin UI.
 * No-op when the sandbox is not running.
 */
export async function syncGatewayConfigToSandbox(): Promise<{ synced: boolean; reason: string }> {
  const meta = await getInitializedMeta();
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("sandbox.config_sync_skipped", {
      reason: "sandbox_not_running",
      status: meta.status,
      sandboxId: meta.sandboxId,
    });
    return { synced: false, reason: "sandbox_not_running" };
  }

  const { getPublicOrigin } = await import("@/server/public-url");
  const apiKey = await getAiGatewayBearerTokenOptional();
  const proxyOrigin = getPublicOrigin();

  const slackConfig = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin,
    apiKey,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slackConfig
      ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
      : undefined,
  });

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    await sandbox.writeFiles(files);
    logInfo("sandbox.config_sync_written", {
      sandboxId: meta.sandboxId,
      fileCount: files.length,
      filePaths: files.map((f) => f.path),
    });
    return { synced: true, reason: "config_written" };
  } catch (error) {
    logWarn("sandbox.config_sync_failed", {
      sandboxId: meta.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { synced: false, reason: error instanceof Error ? error.message : String(error) };
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
  };
  const expectedHash = computeGatewayConfigHash(configHashInput);

  logInfo("sandbox.config_reconcile.checkpoint_before", {
    sandboxId,
    snapshotConfigHash: meta.snapshotConfigHash,
    expectedHash,
    hashVersion: GATEWAY_CONFIG_HASH_VERSION,
  });

  // Already fresh — no work needed.
  if (meta.snapshotConfigHash === expectedHash) {
    logInfo("sandbox.config_reconcile.already_fresh", {
      sandboxId,
      configHash: expectedHash,
    });
    return { verified: true, changed: false, reason: "already-fresh" };
  }

  // Stale — rewrite dynamic config files.
  const apiKey = await getAiGatewayBearerTokenOptional();
  const slackConfig = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin: input.origin,
    apiKey,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slackConfig
      ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
      : undefined,
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
    const restartResult = await sandbox.runCommand("env", [
      "-u", "AI_GATEWAY_API_KEY",
      "-u", "OPENAI_API_KEY",
      "bash", OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
    ]);
    if (restartResult.exitCode !== 0) {
      const output = await restartResult.output("both").catch(() => "");
      logWarn("sandbox.config_reconcile.restart_nonzero", {
        sandboxId,
        exitCode: restartResult.exitCode,
        output: output.slice(0, 300),
      });
      return { verified: false, changed: true, reason: "restart-failed" };
    }
    logInfo("sandbox.config_reconcile.checkpoint_after_restart", { sandboxId });
  } catch (error) {
    logWarn("sandbox.config_reconcile.restart_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: true, reason: "restart-failed" };
  }

  // Update metadata with the new config hash.
  await mutateMeta((next) => {
    next.snapshotConfigHash = expectedHash;
  });

  logInfo("sandbox.config_reconcile.checkpoint_verified", {
    sandboxId,
    configHash: expectedHash,
  });

  return { verified: true, changed: true, reason: "rewritten-and-restarted" };
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
      await getStore().setValue(CRON_NEXT_WAKE_KEY, cronWakeRead.nextWakeMs);
    } else if (cronWakeRead.status === "no-jobs") {
      await getStore().deleteValue(CRON_NEXT_WAKE_KEY);
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
          await getStore().getValue<unknown>(CRON_JOBS_KEY),
        );
        if (!existing || existing.sha256 !== record.sha256) {
          await getStore().setValue(CRON_JOBS_KEY, record);
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
  let lockToken = await store.acquireLock(TOKEN_REFRESH_LOCK_KEY, TOKEN_REFRESH_LOCK_TTL_SECONDS);

  if (!lockToken) {
    // Lock is contended — wait a bounded time, then re-read state.
    const waitStart = Date.now();
    while (Date.now() - waitStart < TOKEN_REFRESH_LOCK_WAIT_MS) {
      await wait(TOKEN_REFRESH_LOCK_POLL_MS);
      lockToken = await store.acquireLock(TOKEN_REFRESH_LOCK_KEY, TOKEN_REFRESH_LOCK_TTL_SECONDS);
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
    await store.releaseLock(TOKEN_REFRESH_LOCK_KEY, lockToken).catch((error) => {
      logWarn("sandbox.token_refresh.lock_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Core token write + gateway restart
// ---------------------------------------------------------------------------

const WRITE_AI_GATEWAY_TOKEN_SCRIPT = [
  `install -d -m 700 ${OPENCLAW_STATE_DIR}`,
  `printf '%s' "$1" > ${OPENCLAW_AI_GATEWAY_API_KEY_PATH}`,
  `chmod 600 ${OPENCLAW_AI_GATEWAY_API_KEY_PATH}`,
].join("\n");

const WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT = [
  `install -d -m 700 ${OPENCLAW_STATE_DIR}`,
  `printf '%s' "$1" > ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
  `chmod 600 ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
  `printf '%s' "$2" > ${OPENCLAW_AI_GATEWAY_API_KEY_PATH}`,
  `chmod 600 ${OPENCLAW_AI_GATEWAY_API_KEY_PATH}`,
].join("\n");

export async function writeRestoreCredentialFiles(
  sandbox: SandboxHandle,
  options: { gatewayToken: string; apiKey?: string },
): Promise<void> {
  logInfo("sandbox.restore.write_credentials", {
    sandboxId: sandbox.sandboxId,
    hasApiKey: options.apiKey != null && options.apiKey.length > 0,
  });

  const result = await sandbox.runCommand("sh", [
    "-c",
    WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT,
    "--",
    options.gatewayToken,
    options.apiKey ?? "",
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

// Targeted gateway restart for token refresh — uses the dedicated restart
// script which kills the old gateway and starts a fresh one with updated
// tokens read from disk.  Unlike the full startup script, the restart script
// does NOT delete paired.json, does NOT set up shell hooks, so token refresh
// is side-effect-free with respect to pairing and learning state.

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

  // Read the current token from the sandbox and skip if unchanged.
  // This avoids killing and restarting the gateway unnecessarily.
  try {
    const existing = await sandbox.readFileToBuffer({
      path: OPENCLAW_AI_GATEWAY_API_KEY_PATH,
    });
    if (existing && existing.toString("utf8").trim() === freshToken) {
      logInfo("sandbox.token_refresh.skipped_unchanged", { sandboxId });
      await mutateMeta((next) => {
        next.lastTokenRefreshAt = Date.now();
        next.lastTokenSource = credential.source;
        next.lastTokenExpiresAt = credential.expiresAt ?? null;
      });
      return;
    }
  } catch {
    // File may not exist yet — proceed with write.
  }

  logInfo("sandbox.token_refresh.start", { sandboxId });

  const writeResult = await sandbox.runCommand("sh", [
    "-c",
    WRITE_AI_GATEWAY_TOKEN_SCRIPT,
    "--",
    freshToken,
  ]);
  if (writeResult.exitCode !== 0) {
    const output = await writeResult.output("both");
    throw new CommandFailedError({
      command: "write-ai-gateway-token",
      exitCode: writeResult.exitCode,
      output,
    });
  }

  logInfo("sandbox.token_refresh.token_written", { sandboxId });

  // Use the dedicated restart script which reads token files from disk, kills
  // the old gateway, and starts a fresh one — without touching pairing state
  // or shell hooks.  Unset baked-in env vars so the script reads the freshly-
  // written files instead of stale env values.
  const restartResult = await sandbox.runCommand("env", [
    "-u", "AI_GATEWAY_API_KEY",
    "-u", "OPENAI_API_KEY",
    "bash", OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  ]);

  const restartOutput = await restartResult.output("both").catch(() => "");

  if (restartResult.exitCode !== 0) {
    logWarn("sandbox.token_refresh.restart_failed", {
      sandboxId,
      exitCode: restartResult.exitCode,
      output: restartOutput.slice(0, 300),
    });
    throw new CommandFailedError({
      command: "restart-openclaw-gateway",
      exitCode: restartResult.exitCode,
      output: restartOutput,
    });
  }

  logInfo("sandbox.token_refresh.gateway_restarted", {
    sandboxId,
    output: restartOutput.slice(0, 200),
  });

  // Wait for the gateway to become healthy before returning.
  // Without this, the caller's immediate forwardToGateway() hits a dead gateway.
  await waitForGatewayReady(sandbox, { maxAttempts: 40, delayMs: 250 });
  logInfo("sandbox.token_refresh.gateway_ready", { sandboxId });

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
  const startToken = await store.acquireLock(START_LOCK_KEY, START_LOCK_TTL_SECONDS);
  if (!startToken) {
    const lockCtx = options.op
      ? withOperationContext(options.op, { lock: "start", contention: true })
      : { reason: options.reason };
    logInfo("sandbox.start_lock_contended", lockCtx);
    return;
  }

  const latest = await getInitializedMeta();
  if (latest.status === "running" && latest.sandboxId) {
    await store.releaseLock(START_LOCK_KEY, startToken);
    return;
  }

  if (isBusyStatus(latest.status) && !isOperationStale(latest)) {
    await store.releaseLock(START_LOCK_KEY, startToken);
    return;
  }

  const nextStatus =
    latest.snapshotId && latest.status !== "uninitialized"
      ? "restoring"
      : "creating";

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
        key: START_LOCK_KEY,
        token: startToken,
        ttlSeconds: START_LOCK_TTL_SECONDS,
        label: "sandbox.start",
      },
      async () => {
        try {
          if (nextStatus === "restoring") {
            // Background restores skip the public readiness probe — the
            // gateway is locally healthy and callers that need public
            // reachability poll via waitForSandboxReady / probeGatewayReady.
            await restoreSandboxFromSnapshot(options.origin, {
              skipPublicReady: true,
              op: options.op,
            });
          } else {
            await createAndBootstrapSandbox(options.origin, { op: options.op });
          }
        } catch (error) {
          if (error instanceof LifecycleLockUnavailableError) {
            const lockCtx = options.op
              ? withOperationContext(options.op, { lock: "lifecycle", contention: true })
              : { reason: options.reason };
            logInfo("sandbox.lifecycle_lock_contended", lockCtx);
            return;
          }

          const errMsg = error instanceof Error ? error.message : String(error);
          const errCtx = options.op
            ? withOperationContext(options.op, { error: errMsg })
            : { reason: options.reason, error: errMsg };
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
  return withLifecycleLock(async () => {
    const current = await getInitializedMeta();
    if (current.status === "running" && current.sandboxId) {
      return current;
    }

    /** Merge operation context (when available) with extra fields for structured logs. */
    const ctx = (extra?: Record<string, unknown>) =>
      options?.op ? withOperationContext(options.op, extra) : (extra ?? {});

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

    logInfo("sandbox.status_transition", ctx({ from: current.status, to: "creating" }));
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.lastError = null;
      meta.snapshotId = null;
    });

    const vcpus = getSandboxVcpus();
    const sleepAfterMs = getSandboxSleepAfterMs();
    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: sleepAfterMs,
      resources: { vcpus },
      ...(await buildRuntimeEnv()),
    });

    logInfo("sandbox.status_transition", ctx({ from: "creating", to: "setup", sandboxId: sandbox.sandboxId, vcpus, sleepAfterMs }));
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
    });

    const latest = await getInitializedMeta();
    // Reuse the already-resolved credential — no redundant second lookup.
    const apiKey = credential?.token;
    const slackCfg = latest.channels.slack;
    const setupResult = await setupOpenClaw(sandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey,
      proxyOrigin: origin,
      telegramBotToken: latest.channels.telegram?.botToken,
      telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
      slackCredentials: slackCfg ? { botToken: slackCfg.botToken, signingSecret: slackCfg.signingSecret } : undefined,
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
    );
    const firewallPolicyHash = createHash("sha256")
      .update(JSON.stringify(firewallPolicy))
      .digest("hex");

    let firewallApplied = false;
    let firewallError: string | null = null;
    const firewallStartedAt = Date.now();
    try {
      await applyFirewallPolicyToSandbox(sandbox, pending);
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

    logInfo("sandbox.create.complete", ctx({
      sandboxId: sandbox.sandboxId,
      openclawVersion: setupResult.openclawVersion,
      firewallApplied,
    }));
    return getInitializedMeta();
  });
}

async function restoreSandboxFromSnapshot(
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
      return createAndBootstrapSandbox(origin);
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
    // (~2-3s) for the static asset skip check.
    const currentManifest = buildRestoreAssetManifest();
    const skippedStaticAssetSync =
      latest.lastRestoreMetrics?.assetSha256 === currentManifest.sha256;

    const restoreEnv: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: latest.gatewayToken,
    };
    if (freshApiKey) {
      restoreEnv.AI_GATEWAY_API_KEY = freshApiKey;
      restoreEnv.OPENAI_API_KEY = freshApiKey;
      restoreEnv.OPENAI_BASE_URL = "https://ai-gateway.vercel.sh/v1";
    }

    const sandboxCreateStart = Date.now();
    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: sleepAfterMs,
      resources: { vcpus },
      source: {
        type: "snapshot",
        snapshotId: current.snapshotId,
      },
      env: restoreEnv,
      // networkPolicy on snapshot restore returns 400 — apply post-create
    });
    const sandboxCreateMs = Date.now() - sandboxCreateStart;
    logPhase("sandboxCreate", { ms: sandboxCreateMs, sandboxId: sandbox.sandboxId, snapshotId: current.snapshotId });

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
    };
    const currentConfigHash = computeGatewayConfigHash(currentConfigHashInput);
    const skippedDynamicConfigSync =
      latest.snapshotConfigHash !== null &&
      latest.snapshotConfigHash === currentConfigHash;
    const dynamicConfigReason: "hash-match" | "hash-miss" | "no-snapshot-hash" =
      latest.snapshotConfigHash === null
        ? "no-snapshot-hash"
        : skippedDynamicConfigSync
          ? "hash-match"
          : "hash-miss";
    logInfo("sandbox.restore.config_hash_checkpoint", {
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
          apiKey: freshApiKey,
          telegramBotToken: latest.channels.telegram?.botToken,
          telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
          slackCredentials: slackConfig ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret } : undefined,
        }),
      );
      logInfo("sandbox.restore.config_written", {
        configHash: currentConfigHash,
        snapshotConfigHash: latest.snapshotConfigHash,
        sandboxId: sandbox.sandboxId,
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

    // Config, credentials, and firewall policy are all passed via create-time
    // env.  The fast-restore script reads them from env and writes locally.
    // No per-command env needed — everything is in the sandbox env.
    const READINESS_TIMEOUT_SECONDS = 30;
    const bootOverlapStart = Date.now();
    let firewallSyncMs = 0;
    let startupScriptMs = 0;
    let localReadyMs = 0;

    // Pre-compute firewall policy hash for structured outcome reporting.
    const requestedFirewallPolicy = toNetworkPolicy(
      next.firewall.mode,
      next.firewall.allowlist,
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
        await applyFirewallPolicyToSandbox(sandbox, next);
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
        await getStore().getValue<unknown>(CRON_JOBS_KEY),
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
          await sandbox.runCommand("bash", [OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH]);
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
        apiKey: freshApiKey,
        telegramBotToken: latest.channels.telegram?.botToken,
        telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
        slackCredentials: slackConfig ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret } : undefined,
      }).then(async (result) => {
        await mutateMeta((m) => {
          if (m.lastRestoreMetrics) {
            // Keep the hot-path skip flag truthful for the restore that already happened.
            m.lastRestoreMetrics.assetSha256 = result.assetSha256;
          }
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
    apiKey?: string;
    telegramBotToken?: string;
    telegramWebhookSecret?: string;
    slackCredentials?: { botToken: string; signingSecret: string };
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
    apiKey: options.apiKey,
    telegramBotToken: options.telegramBotToken,
    telegramWebhookSecret: options.telegramWebhookSecret,
    slackCredentials: options.slackCredentials,
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

function recordSnapshotMetadata(
  meta: SingleMeta,
  snapshotId: string,
  reason: string,
  configHash?: string,
): void {
  const timestamp = Date.now();
  meta.snapshotId = snapshotId;
  if (configHash) {
    meta.snapshotConfigHash = configHash;
  }
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

// ---------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------

async function withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
  const store = getStore();
  const token = await store.acquireLock(LIFECYCLE_LOCK_KEY, LIFECYCLE_LOCK_TTL_SECONDS);
  if (!token) {
    throw new LifecycleLockUnavailableError();
  }

  return withAutoRenewedLock(
    {
      key: LIFECYCLE_LOCK_KEY,
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
  const token = await getAiGatewayBearerTokenOptional();
  if (!token) {
    return {};
  }

  return {
    env: {
      AI_GATEWAY_API_KEY: token,
      OPENAI_API_KEY: token,
      OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    },
  };
}
