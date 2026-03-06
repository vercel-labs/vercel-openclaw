import { Sandbox } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import { getAiGatewayBearerTokenOptional } from "@/server/env";
import { syncFirewallPolicyIfRunning } from "@/server/firewall/state";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { setupOpenClaw } from "@/server/openclaw/bootstrap";
import { OPENCLAW_STARTUP_SCRIPT_PATH } from "@/server/openclaw/config";
import { getStore, getInitializedMeta, mutateMeta } from "@/server/store/store";

const OPENCLAW_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_PORTS = [OPENCLAW_PORT];
const EXTEND_TIMEOUT_MS = 15 * 60 * 1000;
const ACCESS_TOUCH_THROTTLE_MS = 30_000;
const LIFECYCLE_LOCK_KEY = "openclaw-single:lock:lifecycle";
const START_LOCK_KEY = "openclaw-single:lock:start";
const LIFECYCLE_LOCK_TTL_SECONDS = 20 * 60;
const START_LOCK_TTL_SECONDS = 60;
const STALE_OPERATION_MS = 5 * 60 * 1000;

type BackgroundScheduler = (callback: () => Promise<void> | void) => void;

export async function ensureSandboxRunning(options: {
  origin: string;
  reason: string;
  schedule?: BackgroundScheduler;
}): Promise<{ state: "running" | "waiting"; meta: SingleMeta }> {
  const meta = await getInitializedMeta();

  if (meta.status === "running" && meta.sandboxId) {
    return { state: "running", meta };
  }

  if (isBusyStatus(meta.status)) {
    if (isOperationStale(meta)) {
      await scheduleLifecycleWork({ ...options, meta });
    }
    return { state: "waiting", meta };
  }

  await scheduleLifecycleWork({ ...options, meta });
  return { state: "waiting", meta: await getInitializedMeta() };
}

export async function stopSandbox(): Promise<SingleMeta> {
  return withLifecycleLock(async () => {
    const meta = await getInitializedMeta();
    if (meta.status === "stopped" && meta.snapshotId) {
      return meta;
    }
    if (!meta.sandboxId) {
      throw new ApiError(
        409,
        "SANDBOX_NOT_RUNNING",
        "Sandbox is not running and cannot be stopped.",
      );
    }

    const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
    const snapshot = await sandbox.snapshot();
    return mutateMeta((next) => {
      next.snapshotId = snapshot.snapshotId;
      next.sandboxId = null;
      next.portUrls = null;
      next.status = "stopped";
      next.lastAccessedAt = Date.now();
      next.lastError = null;
    });
  });
}

export async function snapshotSandbox(): Promise<SingleMeta> {
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

  const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
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

  const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
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

  return mutateMeta((next) => {
    next.lastAccessedAt = now;
  });
}

export async function probeGatewayReady(): Promise<boolean> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || !["running", "setup", "booting"].includes(meta.status)) {
    return false;
  }

  try {
    const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
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
    const ready = response.ok && body.includes("openclaw-app");

    if (ready && meta.status !== "running") {
      await mutateMeta((next) => {
        next.status = "running";
        next.lastError = null;
      });
    }

    return ready;
  } catch {
    return false;
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
    return;
  }

  const nextStatus =
    options.meta.snapshotId && options.meta.status !== "uninitialized"
      ? "restoring"
      : "creating";

  await mutateMeta((meta) => {
    meta.status = nextStatus;
    meta.lastError = null;
  });

  const run = async (): Promise<void> => {
    try {
      if (nextStatus === "restoring") {
        await restoreSandboxFromSnapshot(options.origin);
      } else {
        await createAndBootstrapSandbox(options.origin);
      }
    } catch (error) {
      logError("sandbox.lifecycle_failed", {
        reason: options.reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError = error instanceof Error ? error.message : String(error);
      });
    } finally {
      await store.releaseLock(START_LOCK_KEY, startToken);
    }
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

    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.lastError = null;
      meta.snapshotId = null;
    });

    const sandbox = await Sandbox.create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus: 2 },
      ...(await buildRuntimeEnv()),
    });

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

    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.lastError = null;
    });

    const sandbox = await Sandbox.create({
      ports: SANDBOX_PORTS,
      timeout: DEFAULT_TIMEOUT_MS,
      resources: { vcpus: 2 },
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

    const restoreResult = await sandbox.runCommand("bash", [
      OPENCLAW_STARTUP_SCRIPT_PATH,
    ]);
    if (restoreResult.exitCode !== 0) {
      const output = await restoreResult.output("both");
      throw new Error(`Restore startup script failed: ${output.slice(0, 500)}`);
    }

    const next = await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandbox.sandboxId;
      meta.portUrls = resolvePortUrls(sandbox);
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
    });

    await applyFirewallPolicyToSandbox(sandbox, next);
    const ready = await probeGatewayReady();
    if (!ready) {
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
    throw new Error("Sandbox lifecycle lock unavailable.");
  }

  try {
    return await fn();
  } finally {
    await store.releaseLock(LIFECYCLE_LOCK_KEY, token);
  }
}

function resolvePortUrls(sandbox: Sandbox): Record<string, string> {
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
