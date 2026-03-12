import { randomUUID } from "node:crypto";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import { getAiGatewayBearerTokenOptional } from "@/server/env";
import { syncFirewallPolicyIfRunning } from "@/server/firewall/state";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { setupOpenClaw } from "@/server/openclaw/bootstrap";
import {
  buildForcePairScript,
  buildGatewayConfig,
  buildImageGenScript,
  buildImageGenSkill,
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";
import { getSandboxController } from "@/server/sandbox/controller";
import type { SandboxHandle } from "@/server/sandbox/controller";
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

type BackgroundScheduler = (callback: () => Promise<void> | void) => void;

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

export async function ensureSandboxReady(options: {
  origin: string;
  reason: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<SingleMeta> {
  const deadline = Date.now() + (options.timeoutMs ?? READY_WAIT_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? READY_WAIT_POLL_MS;
  let lastMeta = await getInitializedMeta();

  while (Date.now() < deadline) {
    const result = await ensureSandboxRunning({
      origin: options.origin,
      reason: options.reason,
    });
    lastMeta = result.meta;

    if ((await probeGatewayReady()).ready) {
      return getInitializedMeta();
    }

    await wait(pollIntervalMs);
    lastMeta = await getInitializedMeta();
  }

  throw new ApiError(
    504,
    "SANDBOX_READY_TIMEOUT",
    `Sandbox did not become ready within ${Math.ceil((options.timeoutMs ?? READY_WAIT_TIMEOUT_MS) / 1000)} seconds (last status: ${lastMeta.status}).`,
  );
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
      next.snapshotId = snapshot.snapshotId;
      next.sandboxId = null;
      next.portUrls = null;
      next.status = "stopped";
      next.lastAccessedAt = Date.now();
      next.lastError = null;
      next.snapshotHistory = [
        {
          id: randomUUID(),
          snapshotId: snapshot.snapshotId,
          timestamp: Date.now(),
          reason: "stop",
        },
        ...next.snapshotHistory,
      ].slice(0, 50);
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

const RESTART_OPENCLAW_GATEWAY_SCRIPT = [
  `pkill -f 'openclaw gateway' || true`,
  `bash ${OPENCLAW_STARTUP_SCRIPT_PATH}`,
].join("\n");

async function refreshAiGatewayToken(sandbox: SandboxHandle, sandboxId: string): Promise<void> {
  const freshToken = await getAiGatewayBearerTokenOptional();
  if (!freshToken) {
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
    throw new Error(`Failed to write AI Gateway token: ${output.slice(0, 300)}`);
  }

  const restartResult = await sandbox.runCommand("bash", [
    "-lc",
    RESTART_OPENCLAW_GATEWAY_SCRIPT,
  ]);
  if (restartResult.exitCode !== 0) {
    const output = await restartResult.output("both");
    throw new Error(`Failed to restart OpenClaw gateway: ${output.slice(0, 300)}`);
  }

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

export async function probeGatewayReady(): Promise<ProbeResult> {
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
      signal: AbortSignal.timeout(5_000),
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

    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus: 1 },
      ...(await buildRuntimeEnv()),
    });

    logInfo("sandbox.status_transition", { from: "creating", to: "setup", sandboxId: sandbox.sandboxId });
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
      meta.lastError = null;
    });

    await applyFirewallPolicyToSandbox(sandbox, next);
    logInfo("sandbox.create.complete", { sandboxId: sandbox.sandboxId });
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

    logInfo("sandbox.status_transition", { from: current.status, to: "restoring", snapshotId: current.snapshotId });
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.lastError = null;
    });

    const sandbox = await getSandboxController().create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus: 1 },
      source: {
        type: "snapshot",
        snapshotId: current.snapshotId,
      },
      ...(await buildRuntimeEnv()),
    });

    await mutateMeta((meta) => {
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
    });

    // Write a fresh AI Gateway token before starting — the snapshot's
    // baked-in key file contains a stale OIDC token.
    const freshApiKey = await getAiGatewayBearerTokenOptional();
    if (freshApiKey) {
      await sandbox.runCommand("sh", [
        "-c",
        WRITE_AI_GATEWAY_TOKEN_SCRIPT,
        "--",
        freshApiKey,
      ]);
    }

    // Re-write config, skill files, and force-pair script so snapshots
    // taken before code changes still get the latest versions.
    await sandbox.writeFiles([
      {
        path: OPENCLAW_CONFIG_PATH,
        content: Buffer.from(buildGatewayConfig(freshApiKey, origin)),
      },
      {
        path: OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
        content: Buffer.from(buildForcePairScript()),
      },
      {
        path: OPENCLAW_IMAGE_GEN_SKILL_PATH,
        content: Buffer.from(buildImageGenSkill()),
      },
      {
        path: OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
        content: Buffer.from(buildImageGenScript()),
      },
      {
        path: OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
        content: Buffer.from(buildImageGenSkill()),
      },
      {
        path: OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
        content: Buffer.from(buildImageGenScript()),
      },
    ]);

    const restoreResult = await sandbox.runCommand("bash", [
      OPENCLAW_STARTUP_SCRIPT_PATH,
    ]);
    if (restoreResult.exitCode !== 0) {
      const output = await restoreResult.output("both");
      throw new Error(`Restore startup script failed: ${output.slice(0, 500)}`);
    }

    // Force-pair the device identity so the gateway doesn't require
    // manual pairing after restore (the startup script clears paired.json).
    try {
      await sandbox.runCommand("node", [
        OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
        OPENCLAW_STATE_DIR,
      ]);
    } catch {
      // Best-effort only — matches setupOpenClaw behavior.
    }

    const next = await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
    });

    await applyFirewallPolicyToSandbox(sandbox, next);
    const probe = await probeGatewayReady();
    if (!probe.ready) {
      await mutateMeta((meta) => {
        meta.status = "booting";
      });
    } else {
      await syncFirewallPolicyIfRunning();
    }

    return getInitializedMeta();
  });
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
