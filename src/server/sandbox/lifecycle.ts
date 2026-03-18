import { randomUUID } from "node:crypto";

import { pollUntil } from "@/server/async/poll";
import { ApiError } from "@/shared/http";
import type { RestorePhaseMetrics, SingleMeta } from "@/shared/types";
import { MAX_RESTORE_HISTORY } from "@/shared/types";
import {
  getAiGatewayBearerTokenOptional,
  resolveAiGatewayCredentialOptional,
  isVercelDeployment,
} from "@/server/env";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { setupOpenClaw, CommandFailedError, waitForGatewayReady } from "@/server/openclaw/bootstrap";
import {
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
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
  getStore,
  getInitializedMeta,
  mutateMeta,
  wait,
} from "@/server/store/store";

const OPENCLAW_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_PORTS = [OPENCLAW_PORT];
const EXTEND_TIMEOUT_MS = 15 * 60 * 1000;
const ACCESS_TOUCH_THROTTLE_MS = 30_000;
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
}): Promise<{ state: "running" | "waiting"; meta: SingleMeta }> {
  const meta = await getInitializedMeta();
  logInfo("sandbox.ensure_running", { reason: options.reason, status: meta.status });

  if (meta.status === "running" && meta.sandboxId) {
    return { state: "running", meta };
  }

  if (isBusyStatus(meta.status)) {
    if (isOperationStale(meta)) {
      logWarn("sandbox.stale_operation", { status: meta.status, updatedAt: meta.updatedAt });
      await scheduleLifecycleWork({ ...options, meta });
    }
    return { state: "waiting", meta };
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
}): Promise<SingleMeta> {
  const result = await waitForSandboxReady({ ...options, reconcile: true });
  return result.meta;
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
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const snapshot = await sandbox.snapshot();
    logInfo("sandbox.status_transition", { from: meta.status, to: "stopped", snapshotId: snapshot.snapshotId });
    return mutateMeta((next) => {
      recordSnapshotMetadata(next, snapshot.snapshotId, "stop");
      next.sandboxId = null;
      next.portUrls = null;
      next.status = "stopped";
      next.lastAccessedAt = Date.now();
      next.lastError = null;
    });
  });
}

export async function snapshotSandbox(): Promise<SingleMeta> {
  logInfo("sandbox.snapshot_requested");
  return stopSandbox();
}

export async function markSandboxUnavailable(reason: string): Promise<SingleMeta> {
  return mutateMeta((meta) => {
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

export async function touchRunningSandbox(): Promise<SingleMeta> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return meta;
  }

  const now = Date.now();
  if (meta.lastAccessedAt && now - meta.lastAccessedAt < ACCESS_TOUCH_THROTTLE_MS) {
    return meta;
  }

  const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
  try {
    await sandbox.extendTimeout(EXTEND_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("sandbox_timeout_invalid")) {
      // Timeout already at max — sandbox is fine, ignore.
    } else {
      logWarn("sandbox.extend_timeout_failed", {
        sandboxId: meta.sandboxId,
        error: message,
      });
      // Sandbox may be auto-suspended — mark unavailable so callers
      // don't attempt a doomed proxy request.
      return markSandboxUnavailable(
        `extend timeout failed: ${message}`,
      );
    }
  }

  return mutateMeta((next) => {
    next.lastAccessedAt = now;
  });
}

// ---------------------------------------------------------------------------
// Token refresh — structured result, distributed lock, circuit breaker, TTL
// ---------------------------------------------------------------------------

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

  // Check TTL of the token last written to the sandbox — skip if it still has
  // sufficient remaining life. We check meta.lastTokenExpiresAt (the sandbox's
  // token), NOT the function-level credential's TTL, because Vercel Functions
  // always get a fresh 1-hour OIDC token that would falsely pass a TTL check
  // even when the sandbox's on-disk token has long expired.
  if (!force && meta.lastTokenExpiresAt != null) {
    const metaRemainingMs = meta.lastTokenExpiresAt * 1000 - Date.now();
    if (metaRemainingMs > minRemainingMs) {
      return {
        refreshed: false,
        reason: "meta-ttl-sufficient",
        credential: credential
          ? { token: credential.token, source: credential.source, expiresAt: credential.expiresAt }
          : null,
      };
    }
  }

  // Circuit breaker check.
  const breakerResult = checkCircuitBreaker(meta);
  if (breakerResult) {
    return breakerResult;
  }

  // Acquire distributed lock before refreshing.
  return withTokenRefreshLock(meta.sandboxId, reason, async (currentMeta) => {
    // Re-check after lock acquisition — another request may have refreshed.
    if (!force && currentMeta.lastTokenRefreshAt) {
      const freshCred = await resolveAiGatewayCredentialOptional();
      if (freshCred?.expiresAt != null) {
        const remainingMs = freshCred.expiresAt * 1000 - Date.now();
        if (remainingMs > minRemainingMs) {
          return {
            refreshed: false,
            reason: "refreshed-by-another-request",
            credential: { token: freshCred.token, source: freshCred.source, expiresAt: freshCred.expiresAt },
          };
        }
      } else if (freshCred?.source === "api-key") {
        return {
          refreshed: false,
          reason: "api-key-no-refresh-needed",
          credential: { token: freshCred.token, source: freshCred.source, expiresAt: freshCred.expiresAt },
        };
      }
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

// Targeted gateway restart for token refresh — avoids re-running the full
// startup script (which deletes paired.json, sets up shell hooks, etc.).
// Instead: kill the old gateway, then start a fresh one with the updated
// token read from disk.
// Use the existing startup script for restart — it reads the token files
// from disk, kills any existing gateway, and starts a fresh one.
// This is the same script used during initial bootstrap and snapshot restore.

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

  // Use the on-disk startup script which reads token files, kills old gateway,
  // and starts a fresh one. Unset the baked-in AI_GATEWAY_API_KEY env var so the
  // script reads the freshly-written file instead of the stale env var.
  const restartResult = await sandbox.runCommand("env", [
    "-u", "AI_GATEWAY_API_KEY",
    "-u", "OPENAI_API_KEY",
    "bash", OPENCLAW_STARTUP_SCRIPT_PATH,
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

  // The startup script deletes paired.json — re-pair the device identity
  // so the gateway continues to accept Control UI connections.
  try {
    await sandbox.runCommand("node", [
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STATE_DIR,
    ]);
  } catch {
    // Best-effort only — matches setupOpenClaw behavior.
  }

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
}): Promise<SandboxHealthResult> {
  const meta = await getInitializedMeta();

  // Not supposed to be running — just ensure.
  if (meta.status !== "running" || !meta.sandboxId) {
    const result = await ensureSandboxRunning(options);
    return {
      status: result.state === "running" ? "ready" : "recovering",
      meta: result.meta,
      repaired: false,
    };
  }

  // Metadata says running — verify with a real probe.
  const probe = await probeGatewayReady();
  if (probe.ready) {
    return { status: "ready", meta, repaired: false };
  }

  // Stale running state detected — repair.
  logWarn("sandbox.health_reconcile", {
    reason: options.reason,
    probeError: probe.error,
    statusCode: probe.statusCode,
    sandboxId: meta.sandboxId,
  });
  await markSandboxUnavailable(
    `Health reconciliation: gateway unreachable (${options.reason})`,
  );
  const ensureResult = await ensureSandboxRunning(options);
  logInfo("sandbox.health_reconcile_recovery_scheduled", {
    reason: options.reason,
    newStatus: ensureResult.meta.status,
    repaired: true,
  });

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
}): Promise<void> {
  const store = getStore();
  const startToken = await store.acquireLock(START_LOCK_KEY, START_LOCK_TTL_SECONDS);
  if (!startToken) {
    logInfo("sandbox.start_lock_contended", { reason: options.reason });
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
            });
          } else {
            await createAndBootstrapSandbox(options.origin);
          }
        } catch (error) {
          if (error instanceof LifecycleLockUnavailableError) {
            logInfo("sandbox.lifecycle_lock_contended", {
              reason: options.reason,
            });
            return;
          }

          logError("sandbox.lifecycle_failed", {
            reason: options.reason,
            error: error instanceof Error ? error.message : String(error),
          });
          await mutateMeta((meta) => {
            meta.status = "error";
            meta.lastError = error instanceof Error ? error.message : String(error);
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

async function createAndBootstrapSandbox(origin: string): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const current = await getInitializedMeta();
    if (current.status === "running" && current.sandboxId) {
      return current;
    }

    // Auth-required boot: on Vercel, require a usable AI Gateway credential.
    const credential = await resolveAiGatewayCredentialOptional();
    if (isVercelDeployment() && !credential) {
      logError("sandbox.create.no_ai_gateway_credential", {
        message: "Cannot create sandbox on Vercel without AI Gateway credential. OIDC may be temporarily unavailable.",
      });
      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError =
          "AI Gateway credential unavailable during sandbox create. " +
          "OIDC may be temporarily unavailable — retry will be attempted automatically.";
      });
      return getInitializedMeta();
    }

    logInfo("sandbox.status_transition", { from: current.status, to: "creating" });
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.lastError = null;
      meta.snapshotId = null;
    });

    const vcpus = getSandboxVcpus();
    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus },
      ...(await buildRuntimeEnv()),
    });

    logInfo("sandbox.status_transition", { from: "creating", to: "setup", sandboxId: sandbox.sandboxId, vcpus });
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
    });

    const latest = await getInitializedMeta();
    const apiKey = credential?.token ?? (await getAiGatewayBearerTokenOptional()) ?? undefined;
    const setupResult = await setupOpenClaw(sandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey,
      proxyOrigin: origin,
    });

    const next = await mutateMeta((meta) => {
      meta.status = "running";
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

    await applyFirewallPolicyToSandbox(sandbox, next);
    logInfo("sandbox.create.complete", {
      sandboxId: sandbox.sandboxId,
      openclawVersion: setupResult.openclawVersion,
    });
    return next;
  });
}

async function restoreSandboxFromSnapshot(
  origin: string,
  options?: { skipPublicReady?: boolean },
): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const current = await getInitializedMeta();
    if (current.status === "running" && current.sandboxId) {
      return current;
    }
    if (!current.snapshotId) {
      return createAndBootstrapSandbox(origin);
    }

    // Auth-required boot: on Vercel, require a usable AI Gateway credential.
    const credential = await resolveAiGatewayCredentialOptional();
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

    logInfo("sandbox.status_transition", { from: current.status, to: "restoring", snapshotId: current.snapshotId });
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.lastError = null;
    });

    const sandboxCreateStart = Date.now();
    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus },
      source: {
        type: "snapshot",
        snapshotId: current.snapshotId,
      },
      ...(await buildRuntimeEnv()),
    });
    const sandboxCreateMs = Date.now() - sandboxCreateStart;

    await mutateMeta((meta) => {
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
    });

    // Write both credential files atomically — the snapshot's baked-in
    // copies contain stale tokens.  When no fresh credential is available
    // do NOT blank the existing .ai-gateway-api-key file — a stale token
    // is better than no token at all during restore.
    const tokenWriteStart = Date.now();
    const freshApiKey = credential?.token ?? (await getAiGatewayBearerTokenOptional());
    const latest = await getInitializedMeta();

    if (freshApiKey) {
      await writeRestoreCredentialFiles(sandbox, {
        gatewayToken: latest.gatewayToken,
        apiKey: freshApiKey,
      });
    } else {
      // No fresh API key — only write the gateway token, preserve
      // whatever AI Gateway key the snapshot already has on disk.
      logWarn("sandbox.restore.preserving_existing_ai_key", {
        sandboxId: sandbox.sandboxId,
        reason: "No fresh AI Gateway credential available",
      });
      await writeRestoreCredentialFiles(sandbox, {
        gatewayToken: latest.gatewayToken,
        // Omit apiKey — writeRestoreCredentialFiles writes empty string,
        // but we still need the gateway token written. Use separate write
        // for gateway token only to avoid blanking the AI key.
      });
    }
    const tokenWriteMs = Date.now() - tokenWriteStart;

    // Sync restore assets — skip static files when the manifest hash matches.
    const assetSyncStart = Date.now();
    const assetSyncResult = await syncRestoreAssetsIfNeeded(sandbox, {
      origin,
      apiKey: freshApiKey,
    });
    const assetSyncMs = Date.now() - assetSyncStart;
    logInfo("sandbox.restore.asset_sync", {
      skippedStaticAssetSync: assetSyncResult.skippedStaticAssetSync,
      assetSha256: assetSyncResult.assetSha256,
    });

    // Use the dedicated fast-restore script which inlines force-pair and
    // skips shell-hook setup already baked into the snapshot.  This replaces
    // the previous two-step sequence of generic startup + separate force-pair.
    const startupScriptStart = Date.now();
    logInfo("sandbox.restore.fast_restore_start", { sandboxId: sandbox.sandboxId });
    const restoreResult = await sandbox.runCommand("bash", [
      OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
    ]);
    if (restoreResult.exitCode !== 0) {
      const output = await restoreResult.output("both");
      throw new CommandFailedError({
        command: "fast-restore-script",
        exitCode: restoreResult.exitCode,
        output,
      });
    }
    const startupScriptMs = Date.now() - startupScriptStart;
    logInfo("sandbox.restore.fast_restore_complete", { startupScriptMs, sandboxId: sandbox.sandboxId });

    // Force-pair is now inlined in the fast-restore script, so this phase
    // is always 0.  Kept for RestorePhaseMetrics backward compatibility.
    const forcePairMs = 0;

    const next = await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
    });

    // Overlap firewall sync with local gateway readiness polling.
    // Firewall policy application does not depend on the gateway being
    // healthy, and gateway boot does not depend on firewall rules.
    // Running them concurrently saves the full firewallSyncMs from the
    // critical path.
    const bootOverlapStart = Date.now();
    let firewallSyncMs = 0;
    let localReadyMs = 0;

    await Promise.all([
      (async () => {
        const t0 = Date.now();
        await applyFirewallPolicyToSandbox(sandbox, next);
        firewallSyncMs = Date.now() - t0;
        logInfo("sandbox.restore.firewall_sync_overlapped", {
          firewallSyncMs,
          sandboxId: sandbox.sandboxId,
        });
      })(),
      (async () => {
        const t0 = Date.now();
        await waitForGatewayReady(sandbox, { maxAttempts: 120, delayMs: 250 });
        localReadyMs = Date.now() - t0;
        logInfo("sandbox.restore.local_ready", {
          localReadyMs,
          sandboxId: sandbox.sandboxId,
        });
      })(),
    ]);

    const bootOverlapMs = Date.now() - bootOverlapStart;
    logInfo("sandbox.restore.boot_overlap_complete", {
      bootOverlapMs,
      firewallSyncMs,
      localReadyMs,
      sandboxId: sandbox.sandboxId,
    });

    // Gateway is locally healthy — mark as running so callers that poll
    // metadata (channel drains, waitForSandboxReady) see the correct state.
    // This is set before the optional public probe because locally-healthy is
    // the authoritative signal; the public probe below is best-effort and its
    // failure does not invalidate the sandbox (it will converge on its own).
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
      skippedStaticAssetSync: assetSyncResult.skippedStaticAssetSync,
      assetSha256: assetSyncResult.assetSha256,
      vcpus,
      recordedAt: Date.now(),
      bootOverlapMs,
      skippedPublicReady: skipPublicReady,
    };

    logInfo("sandbox.restore.metrics", metrics as unknown as Record<string, unknown>);

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
  options: { origin: string; apiKey?: string },
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
): void {
  const timestamp = Date.now();
  meta.snapshotId = snapshotId;
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

function isBusyStatus(status: SingleMeta["status"]): boolean {
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
