import { randomUUID } from "node:crypto";

import { pollUntil } from "@/server/async/poll";
import { ApiError } from "@/shared/http";
import type { RestorePhaseMetrics, SingleMeta } from "@/shared/types";
import { getAiGatewayBearerTokenOptional } from "@/server/env";
import { syncFirewallPolicyIfRunning } from "@/server/firewall/state";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { setupOpenClaw, CommandFailedError, waitForGatewayReady } from "@/server/openclaw/bootstrap";
import {
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_LOG_FILE,
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
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const LIFECYCLE_LOCK_KEY = "openclaw-single:lock:lifecycle";
const START_LOCK_KEY = "openclaw-single:lock:start";
const LIFECYCLE_LOCK_TTL_SECONDS = 20 * 60;
const START_LOCK_TTL_SECONDS = 15 * 60;
const LOCK_RENEW_INTERVAL_MS = 30_000;
const STALE_OPERATION_MS = 5 * 60 * 1000;
const READY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const READY_WAIT_POLL_MS = 1_000;

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
    if (!message.includes("sandbox_timeout_invalid")) {
      logWarn("sandbox.extend_timeout_failed", {
        sandboxId: meta.sandboxId,
        error: message,
      });
    }
  }

  // Refresh the AI Gateway token if it's been a while.
  const lastRefresh = meta.lastTokenRefreshAt ?? 0;
  if (now - lastRefresh > TOKEN_REFRESH_INTERVAL_MS) {
    void refreshAiGatewayToken(sandbox, meta.sandboxId).catch((err) => {
      logWarn("sandbox.token_refresh_failed", {
        sandboxId: meta.sandboxId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return mutateMeta((next) => {
    next.lastAccessedAt = now;
  });
}

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
const REFRESH_RESTART_GATEWAY_SCRIPT = [
  `exec 2>&1`,  // merge stderr into stdout so we capture all output
  `pkill -f 'openclaw gateway' || true`,
  `sleep 0.5`,
  `if [ ! -f "${OPENCLAW_GATEWAY_TOKEN_PATH}" ]; then echo "ERR: gateway token file missing"; exit 1; fi`,
  `gateway_token="$(cat ${OPENCLAW_GATEWAY_TOKEN_PATH})"`,
  `if [ -z "$gateway_token" ]; then echo "ERR: gateway token is empty"; exit 1; fi`,
  `ai_gateway_api_key="$(cat ${OPENCLAW_AI_GATEWAY_API_KEY_PATH} 2>/dev/null || true)"`,
  `if [ ! -x "${OPENCLAW_BIN}" ]; then echo "ERR: openclaw binary not found at ${OPENCLAW_BIN}"; exit 1; fi`,
  `setsid env \\`,
  `  OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \\`,
  `  OPENCLAW_GATEWAY_TOKEN="$gateway_token" \\`,
  `  AI_GATEWAY_API_KEY="$ai_gateway_api_key" \\`,
  `  OPENAI_API_KEY="$ai_gateway_api_key" \\`,
  `  OPENAI_BASE_URL="https://ai-gateway.vercel.sh/v1" \\`,
  `  ${OPENCLAW_BIN} gateway --port 3000 --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &`,
  `echo "gateway restarted pid=$!"`,
].join("\n");

async function refreshAiGatewayToken(sandbox: SandboxHandle, sandboxId: string): Promise<void> {
  const freshToken = await getAiGatewayBearerTokenOptional();
  if (!freshToken) {
    logWarn("sandbox.token_refresh.no_oidc_token", { sandboxId });
    return;
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

  const restartResult = await sandbox.runCommand("bash", [
    "-c",
    REFRESH_RESTART_GATEWAY_SCRIPT,
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

  await mutateMeta((next) => {
    next.lastTokenRefreshAt = Date.now();
  });

  logInfo("sandbox.token_refresh.complete", { sandboxId });
}

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
            await restoreSandboxFromSnapshot(options.origin);
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

async function createAndBootstrapSandbox(origin: string): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const current = await getInitializedMeta();
    if (current.status === "running" && current.sandboxId) {
      return current;
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
    const setupResult = await setupOpenClaw(sandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey: (await getAiGatewayBearerTokenOptional()) ?? undefined,
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
    });

    await applyFirewallPolicyToSandbox(sandbox, next);
    logInfo("sandbox.create.complete", {
      sandboxId: sandbox.sandboxId,
      openclawVersion: setupResult.openclawVersion,
    });
    return next;
  });
}

async function restoreSandboxFromSnapshot(origin: string): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const current = await getInitializedMeta();
    if (current.status === "running" && current.sandboxId) {
      return current;
    }
    if (!current.snapshotId) {
      return createAndBootstrapSandbox(origin);
    }

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
    // copies contain stale tokens.  When no fresh OIDC token is available
    // the AI key file is truncated to empty so the startup script does not
    // silently reuse a stale credential.
    const tokenWriteStart = Date.now();
    const freshApiKey = await getAiGatewayBearerTokenOptional();
    const latest = await getInitializedMeta();

    await writeRestoreCredentialFiles(sandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey: freshApiKey ?? undefined,
    });
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

    const startupScriptStart = Date.now();
    const restoreResult = await sandbox.runCommand("bash", [
      OPENCLAW_STARTUP_SCRIPT_PATH,
    ]);
    if (restoreResult.exitCode !== 0) {
      const output = await restoreResult.output("both");
      throw new CommandFailedError({
        command: "restore-startup-script",
        exitCode: restoreResult.exitCode,
        output,
      });
    }
    const startupScriptMs = Date.now() - startupScriptStart;

    // Force-pair the device identity so the gateway doesn't require
    // manual pairing after restore (the startup script clears paired.json).
    const forcePairStart = Date.now();
    try {
      await sandbox.runCommand("node", [
        OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
        OPENCLAW_STATE_DIR,
      ]);
    } catch {
      // Best-effort only — matches setupOpenClaw behavior.
    }
    const forcePairMs = Date.now() - forcePairStart;

    const next = await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
    });

    const firewallSyncStart = Date.now();
    await applyFirewallPolicyToSandbox(sandbox, next);
    const firewallSyncMs = Date.now() - firewallSyncStart;

    // Local-first readiness: curl inside the sandbox is much faster than
    // going through the public proxy/DNS path.
    const localReadyStart = Date.now();
    await waitForGatewayReady(sandbox, { maxAttempts: 120, delayMs: 250 });
    const localReadyMs = Date.now() - localReadyStart;
    logInfo("sandbox.restore.local_ready", { localReadyMs, sandboxId: sandbox.sandboxId });

    // Short public probe — once the gateway is locally healthy the public
    // route should come up quickly.  Uses a tight 1s per-probe timeout
    // instead of the default 5s to avoid accumulating tail latency.
    const publicReadyStart = Date.now();
    await waitForPublicGatewayReady({
      maxAttempts: 20,
      delayMs: 250,
      timeoutMs: 1_000,
    });
    const publicReadyMs = Date.now() - publicReadyStart;

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
    };

    logInfo("sandbox.restore.metrics", metrics as unknown as Record<string, unknown>);

    await mutateMeta((meta) => {
      meta.lastRestoreMetrics = metrics;
    });

    await syncFirewallPolicyIfRunning();
    return getInitializedMeta();
  });
}

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
