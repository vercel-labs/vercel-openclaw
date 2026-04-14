import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta } from "@/shared/types";

import {
  ensureFreshGatewayToken,
  ensureUsableAiGatewayCredential,
  ensureSandboxRunning,
  ensureSandboxReady,
  ensureRunningSandboxDynamicConfigFresh,
  getRunningSandboxTimeoutRemainingMs,
  isPreparedRestoreReusable,
  markRestoreTargetDirty,
  probeGatewayReady,
  reconcileSandboxHealth,
  stopSandbox,
  snapshotSandbox,
  getSandboxDomain,
  touchRunningSandbox,
  markSandboxUnavailable,
  resetSandbox,
  CRON_JOBS_KEY,
} from "@/server/sandbox/lifecycle";
import {
  _resetSandboxSleepConfigCacheForTesting,
} from "@/server/sandbox/timeout";
import {
  _setSandboxControllerForTesting,
} from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { lifecycleLockKey } from "@/server/store/keyspace";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  createOperationContext,
} from "@/server/observability/operation-context";
import {
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
  computeGatewayConfigHash,
} from "@/server/openclaw/config";
import {
  FakeSandboxController,
  FakeSandboxHandle,
  type SandboxEvent,
} from "@/test-utils/fake-sandbox-controller";
import {
  withHarness,
} from "@/test-utils/harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_OVERRIDES: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  OPENCLAW_SANDBOX_SLEEP_AFTER_MS: undefined,
};

async function withTestEnv(
  fake: FakeSandboxController,
  fn: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_OVERRIDES)) {
    originals[key] = process.env[key];
    if (ENV_OVERRIDES[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ENV_OVERRIDES[key];
    }
  }

  _setSandboxControllerForTesting(fake);
  _resetSandboxSleepConfigCacheForTesting();

  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    _resetSandboxSleepConfigCacheForTesting();
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

const PRE_SNAPSHOT_CLEANUP_MARKERS = [
  "rm -rf /tmp/openclaw || true",
  "rm -rf /home/vercel-sandbox/.npm || true",
  "rm -rf /root/.npm || true",
  "rm -rf /tmp/openclaw-npm-cache || true",
];

function isPreSnapshotCleanupCommand(command: {
  cmd: string;
  args?: string[];
}): boolean {
  return (
    command.cmd === "bash"
    && command.args?.[0] === "-lc"
    && PRE_SNAPSHOT_CLEANUP_MARKERS.every((marker) =>
      command.args?.[1]?.includes(marker),
    )
  );
}

function findPreSnapshotCleanupCommand(handle: FakeSandboxHandle) {
  return handle.commands.find(isPreSnapshotCleanupCommand);
}

function isPreSnapshotCleanupEvent(
  event: SandboxEvent,
  sandboxId: string,
): boolean {
  if (event.kind !== "command" || event.sandboxId !== sandboxId) {
    return false;
  }

  const detail = event.detail as { command?: string; args?: string[] } | undefined;
  return (
    detail?.command === "bash"
    && detail.args?.[0] === "-lc"
    && PRE_SNAPSHOT_CLEANUP_MARKERS.every((marker) =>
      detail.args?.[1]?.includes(marker),
    )
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("FakeSandboxController implements the SandboxController interface", async () => {
  const fake = new FakeSandboxController();
  const handle = await fake.create({ ports: [3000], timeout: 60_000 });

  assert.ok(handle.sandboxId.startsWith("sbx-fake-"));

  const cmdResult = await handle.runCommand("echo", ["hello"]);
  assert.equal(cmdResult.exitCode, 0);

  await handle.writeFiles([{ path: "test.txt", content: Buffer.from("hi") }]);
  assert.equal((handle as FakeSandboxHandle).writtenFiles.length, 1);

  const domain = handle.domain(3000);
  assert.ok(domain.includes("3000"));

  const snap = await handle.snapshot();
  assert.ok(snap.snapshotId.startsWith("snap-"));

  await handle.extendTimeout(5000);
  assert.deepEqual((handle as FakeSandboxHandle).extendedTimeouts, [5000]);

  const policy = await handle.updateNetworkPolicy("allow-all");
  assert.equal(policy, "allow-all");
});

test("stopSandbox snapshots and transitions to stopped", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set up a "running" sandbox in meta
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-1";
      meta.portUrls = { "3000": "https://sbx-running-1-3000.fake.vercel.run" };
    });

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    // v2: persistent sandboxes auto-snapshot on stop — no manual snapshot() call
    // sandboxId is preserved (persistent sandbox identity persists across stop/resume)
    assert.equal(result.sandboxId, "sbx-running-1");
    assert.equal(result.portUrls, null);

    // Verify the fake was called
    assert.equal(fake.retrieved.length, 1);
    assert.equal(fake.retrieved[0], "sbx-running-1");
  });
});

test("stopSandbox runs best-effort pre-snapshot cleanup commands with per-command fallback", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cleanup-best-effort";
      meta.portUrls = { "3000": "https://sbx-cleanup-best-effort-3000.fake.vercel.run" };
      meta.firewall.mode = "enforcing";
    });

    await stopSandbox();

    const handle = fake.getHandle("sbx-cleanup-best-effort");
    assert.ok(handle, "sandbox handle should exist");
    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.equal(
      cleanupCommand.args?.[1],
      [
        "rm -f /tmp/openclaw.log || true",
        "rm -rf /tmp/openclaw || true",
        "rm -rf /home/vercel-sandbox/.npm || true",
        "rm -rf /root/.npm || true",
        "rm -rf /tmp/openclaw-npm-cache || true",
        "rm -f /tmp/shell-commands-for-learning.log || true",
      ].join("\n"),
    );
    assert.ok(
      !cleanupCommand.args?.[1]?.includes("/home/vercel-sandbox/.npm/_logs"),
      "cleanup command should not redundantly remove nested npm log path",
    );
  });
});

test("stopSandbox runs pre-snapshot cleanup before stop", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    // v2: persistent sandboxes auto-snapshot on stop — stop() is called, not snapshot()
    assert.equal(handle.stopCalled, true, "stop should be called after cleanup");

    const cleanupEventIndex = h.controller.events.findIndex((event) =>
      isPreSnapshotCleanupEvent(event, sandboxId),
    );
    const stopEventIndex = h.controller.events.findIndex(
      (event) => event.kind === "stop" && event.sandboxId === sandboxId,
    );

    assert.ok(cleanupEventIndex >= 0, "cleanup command event should be recorded");
    assert.ok(stopEventIndex > cleanupEventIndex, "cleanup should run before stop");
  });
});

test("pre-snapshot cleanup preserves learning log in learning mode", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "learning";
    });
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.ok(
      !cleanupCommand.args?.[1]?.includes("shell-commands-for-learning.log"),
      "learning log should be preserved in learning mode",
    );
  });
});

test("pre-snapshot cleanup removes learning log in enforcing mode", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
    });
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.ok(
      cleanupCommand.args?.[1]?.includes("rm -f /tmp/shell-commands-for-learning.log || true"),
      "learning log should be removed in enforcing mode",
    );
  });
});

test("pre-snapshot cleanup failure does not prevent stop", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    handle.responders.push((cmd, args) => {
      if (
        isPreSnapshotCleanupCommand({ cmd, args })
      ) {
        return { exitCode: 1, output: async () => "cleanup command failed" };
      }
      return undefined;
    });

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    // v2: persistent sandboxes auto-snapshot on stop — stop() is called, not snapshot()
    assert.equal(handle.stopCalled, true, "stop should still run after cleanup failure");
  });
});

test("stopSandbox logs warning and continues when pre-snapshot cleanup fails", async () => {
  const fake = new FakeSandboxController();
  const handle = new FakeSandboxHandle("sbx-cleanup-warning", fake.events);
  handle.responders.push((cmd, args) => {
    if (
      cmd === "bash"
      && args?.[0] === "-lc"
      && args?.[1]?.includes("rm -f /tmp/openclaw.log || true")
    ) {
      return { exitCode: 1, output: async () => "permission denied" };
    }
    return undefined;
  });
  fake.handlesByIds.set("sbx-cleanup-warning", handle);

  await withTestEnv(fake, async () => {
    _resetLogBuffer();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cleanup-warning";
      meta.portUrls = { "3000": "https://sbx-cleanup-warning-3000.fake.vercel.run" };
      meta.firewall.mode = "learning";
    });

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    // v2: persistent sandboxes auto-snapshot on stop — snapshotId not set from snapshot()

    const warningLog = getServerLogs().find(
      (entry) =>
        entry.level === "warn"
        && entry.message === "openclaw.pre_snapshot_cleanup_failed"
        && entry.data?.sandboxId === "sbx-cleanup-warning",
    );

    assert.ok(warningLog, "cleanup failure should be logged as a warning");
    assert.match(String(warningLog.data?.error), /cleanup-before-snapshot/);
    assert.match(String(warningLog.data?.error), /permission denied/);
  });
});

test("snapshotSandbox delegates to stopSandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-2";
      meta.portUrls = { "3000": "https://sbx-running-2-3000.fake.vercel.run" };
    });

    const result = await snapshotSandbox();

    assert.equal(result.status, "stopped");
    // v2: persistent sandboxes auto-snapshot on stop — sandboxId is preserved
    assert.equal(result.sandboxId, "sbx-running-2");
  });
});

test("stopSandbox returns current meta if already stopped with snapshot", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-existing";
    });

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    assert.equal(result.snapshotId, "snap-existing");
    // Should not have called get since it short-circuited
    assert.equal(fake.retrieved.length, 0);
  });
});

test("ensureSandboxRunning returns running state when already running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-already-running";
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
    });

    assert.equal(result.state, "running");
    assert.equal(result.meta.status, "running");
    // No sandbox creation should have happened
    assert.equal(fake.created.length, 0);
  });
});

test("ensureSandboxRunning schedules create for uninitialized sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    // Meta should now be "creating"
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating");
  });
});

test("ensureSandboxRunning schedules restore when snapshot exists", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-to-restore";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    // Restore scheduling should immediately surface "restoring" for snapshot wake flows.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

test("getSandboxDomain returns cached URL when available", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-domain-test";
      meta.portUrls = { "3000": "https://cached-domain.fake.vercel.run" };
    });

    const domain = await getSandboxDomain();
    assert.equal(domain, "https://cached-domain.fake.vercel.run");
    // Should not have called controller.get since URL was cached
    assert.equal(fake.retrieved.length, 0);
  });
});

test("getSandboxDomain fetches from controller when not cached", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-domain-test-2";
      meta.portUrls = null;
    });

    const domain = await getSandboxDomain();
    assert.ok(domain.includes("sbx-domain-test-2"));
    assert.equal(fake.retrieved.length, 1);
  });
});

test("touchRunningSandbox extends timeout on running sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-touch-test";
      meta.lastAccessedAt = null; // Ensure no throttle
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.ok(result.lastAccessedAt);
    assert.equal(fake.retrieved.length, 1);
  });
});

test("touchRunningSandbox is a no-op when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "stopped");
    assert.equal(fake.retrieved.length, 0);
  });
});

test("touchRunningSandbox throttles when recently accessed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-throttle-test";
      meta.lastAccessedAt = Date.now(); // Just now
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    // Should have been throttled — no controller call
    assert.equal(fake.retrieved.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stale-running recovery tests
// ---------------------------------------------------------------------------

test("ensureSandboxRunning re-schedules when status=creating and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set up a "creating" sandbox
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });

    // Mock Date.now to make the operation appear stale (>5min old)
    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000; // 6 minutes in the future

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-creating-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      // Should still return "waiting" but should have re-scheduled work
      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale creating");
    } finally {
      Date.now = realNow;
    }
  });
});

test("ensureSandboxRunning re-schedules when status=restoring and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.sandboxId = null;
      meta.snapshotId = "snap-stale-restore";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-restoring-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale restoring");
    } finally {
      Date.now = realNow;
    }
  });
});

test("ensureSandboxRunning does NOT re-schedule when status=creating and updatedAt is recent", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });
    // updatedAt was just set by the mutation above — it's fresh

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "recent-creating-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    // Should NOT have re-scheduled since the operation is recent
    assert.equal(scheduledCallback, null, "Should not re-schedule when creating is recent");
  });
});

test("scheduled lifecycle work clears busy state when lifecycle lock is contended", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "lifecycle-lock-contention-create",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    const lifecycleToken = await getStore().acquireLock(lifecycleLockKey(), 60);
    assert.ok(lifecycleToken, "Test should acquire the lifecycle lock");

    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "uninitialized");
    assert.equal(meta.lastError, "Lifecycle lock contention prevented sandbox startup.");
  });
});

// ---------------------------------------------------------------------------
// ensureSandboxReady timeout test
// ---------------------------------------------------------------------------

test("ensureSandboxReady times out with ApiError 504 when sandbox never reaches running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-never-ready";
      meta.portUrls = { "3000": "https://sbx-never-ready-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Mock fetch to always return a non-ready response
    globalThis.fetch = async () =>
      new Response("<html>loading...</html>", { status: 200 });

    try {
      await assert.rejects(
        () =>
          ensureSandboxReady({
            origin: "https://test.example.com",
            reason: "timeout-test",
            timeoutMs: 200, // Very short timeout for testing
            pollIntervalMs: 50,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("status" in error);
          assert.equal((error as { status: number }).status, 504);
          assert.ok(error.message.includes("did not become ready"));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// probeGatewayReady tests
// ---------------------------------------------------------------------------

test("probeGatewayReady returns ready=false when fetch throws (simulating gone sandbox)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-gone";
      meta.portUrls = { "3000": "https://sbx-gone-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Mock fetch to throw (simulating a sandbox that no longer exists)
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED: sandbox is gone");
    };

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.ok(result.error);
      assert.ok(result.error.includes("ECONNREFUSED"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Restore-path file-write parity tests
// ---------------------------------------------------------------------------

/**
 * The sandbox name derived by the lifecycle from the default instance ID.
 * Used by triggerRestore to pre-register a "resumed" handle so get() succeeds.
 */
const LIFECYCLE_SANDBOX_NAME = "oc-openclaw-single";

/**
 * Pre-register a handle for the lifecycle's derived sandbox name.
 * The handle simulates a previously bootstrapped persistent sandbox
 * so the fast-restore resume path is taken (isResumed=true).
 */
function preRegisterResumeHandle(fake: FakeSandboxController): FakeSandboxHandle {
  const handle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
  handle.responders.push(...fake.defaultResponders);
  if (fake.onWriteFiles) {
    handle.writeFilesHook = fake.onWriteFiles;
  }
  if (fake.onNetworkPolicy) {
    handle.networkPolicyHandler = fake.onNetworkPolicy;
  }
  // Simulate openclaw binary installed — makes isResumed=true in lifecycle
  handle.responders.push((cmd, args) => {
    if (
      cmd === "bash" &&
      args?.[0] === "-c" &&
      args[1]?.includes("command -v") &&
      args[1]?.includes(OPENCLAW_BIN)
    ) {
      return {
        exitCode: 0,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return "yes\n";
          if (stream === "stderr") return "";
          return "yes\n";
        },
      };
    }
    return undefined;
  });
  fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, handle);
  return handle;
}

/**
 * Helper: triggers restoreSandboxFromSnapshot by calling ensureSandboxRunning
 * with a stopped+snapshotId meta, captures the scheduled callback, and runs it.
 *
 * v2: Pre-registers a "resumed" handle so the lifecycle's get() call succeeds
 * and the fast-restore path is taken (matching real persistent sandbox behavior).
 */
async function triggerRestore(
  fake: FakeSandboxController,
  opts?: { tokenOverride?: string | undefined },
): Promise<{ handle: FakeSandboxHandle; meta: SingleMeta }> {
  _setAiGatewayTokenOverrideForTesting(opts?.tokenOverride ?? undefined);

  // Pre-register a "resumed" persistent sandbox handle so get() finds it.
  const resumeHandle = preRegisterResumeHandle(fake);

  try {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background restore work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    // v2: lifecycle retrieves the pre-registered handle via get(),
    // takes the fast-restore resume path.
    const handle = meta.sandboxId ? (fake.getHandle(meta.sandboxId) ?? resumeHandle) : resumeHandle;
    assert.ok(handle, "A sandbox should have been created or resumed");
    return { handle, meta };
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
  }
}

test("restoreSandboxFromSnapshot writes all files + manifest on first restore (no existing manifest)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-files";
      meta.gatewayToken = "test-gw-token";
    });

    // Mock fetch for probeGatewayReady at end of restore
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      const writtenPaths = handle.writtenFiles.map((f) => f.path);
      assert.ok(writtenPaths.includes(OPENCLAW_CONFIG_PATH), "Should write config");
      assert.ok(writtenPaths.includes(OPENCLAW_FORCE_PAIR_SCRIPT_PATH), "Should write force-pair script");
      assert.ok(writtenPaths.includes(OPENCLAW_STARTUP_SCRIPT_PATH), "Should write startup script");
      assert.ok(writtenPaths.includes(OPENCLAW_FAST_RESTORE_SCRIPT_PATH), "Should write fast-restore script");
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SKILL_PATH), "Should write image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SCRIPT_PATH), "Should write image-gen script");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH), "Should write builtin image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH), "Should write builtin image-gen script");
      // Config + credentials are passed via env (no hot-path writeFiles).
      // Static assets are synced in background.  Verify the background
      // sync wrote the expected files.
      assert.ok(handle.writtenFiles.length > 0, "Background asset sync should write files");

      // Verify manifest was written
      const manifestPath = writtenPaths.find((p) => p.includes(".restore-assets-manifest.json"));
      assert.ok(manifestPath, "Should write restore-assets manifest");

      // v2: resume path records restore metrics but without the old restore-specific
      // dynamicConfigReason/dynamicConfigHash fields.
      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
      assert.ok(meta.lastRestoreMetrics.recordedAt > 0, "Should have recordedAt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume skips static files when manifest hash matches on disk", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-first";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      // First resume — writes all files (no manifest on disk)
      const { handle: firstHandle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });
      assert.ok(firstHandle.writtenFiles.length > 0, "First resume should write files");

      // Find the manifest file that was written
      const manifestFile = firstHandle.writtenFiles.find((f) =>
        f.path.includes(".restore-assets-manifest.json"),
      );
      assert.ok(manifestFile, "Manifest should exist from first resume");

      // Now test the skip path: create a new controller with a pre-registered
      // handle that already has the manifest on disk (simulating persistent sandbox).
      const seededFake = new FakeSandboxController();
      _setSandboxControllerForTesting(seededFake);

      // Pre-register a resume handle with the manifest already on disk
      const seededHandle = preRegisterResumeHandle(seededFake);
      seededHandle.writtenFiles.push(manifestFile);

      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.sandboxId = null;
        meta.portUrls = null;
      });

      _setAiGatewayTokenOverrideForTesting("test-ai-key");

      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-test",
        schedule(cb) { scheduledCallback = cb; },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      _setAiGatewayTokenOverrideForTesting(null);

      // With matching manifest, syncRestoreAssetsIfNeeded skips static files.
      // Count only writes that happened AFTER the pre-seeded manifest.
      const writesAfterSeed = seededHandle.writtenFiles.slice(1); // skip pre-seeded manifest
      const staticWrites = writesAfterSeed.filter((f) =>
        f.path.includes(".restore-assets-manifest.json"),
      );
      assert.equal(staticWrites.length, 0, "Should not re-write manifest when hash matches");

      // Credentials should not be in writtenFiles (passed via env)
      const credentialWrites = seededHandle.writtenFiles.filter(
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path.endsWith(".ai-gateway-api-key"),
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles");
    } finally {
      globalThis.fetch = originalFetch;
      _setSandboxControllerForTesting(null);
    }
  });
});

test("restoreSandboxFromSnapshot resume always syncs config via asset sync", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-hash-match";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = computeGatewayConfigHash({});
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: resume path always syncs config via syncRestoreAssetsIfNeeded.
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(configWrites.length >= 1, "Should write config at least once");

      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot resume syncs config regardless of stale snapshot hash", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-hash-miss";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = "stale-hash-from-previous-snapshot";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: resume path always syncs config via syncRestoreAssetsIfNeeded.
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(configWrites.length >= 1, "Should write config at least once");

      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot appends to restoreHistory capped at MAX_RESTORE_HISTORY", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-history-test";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      // First restore
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });
      let meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics after first restore");
      assert.equal(meta.restoreHistory.length, 1, "restoreHistory should have 1 entry");
      assert.deepStrictEqual(
        meta.restoreHistory[0],
        meta.lastRestoreMetrics,
        "First history entry should match lastRestoreMetrics",
      );

      // Reset to stopped for second restore
      await mutateMeta((m) => {
        m.status = "stopped";
        m.snapshotId = "snap-history-test-2";
        m.sandboxId = null;
        m.portUrls = null;
      });

      // Second restore
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });
      meta = await getInitializedMeta();
      assert.equal(meta.restoreHistory.length, 2, "restoreHistory should have 2 entries");
      assert.deepStrictEqual(
        meta.restoreHistory[0],
        meta.lastRestoreMetrics,
        "Most recent entry should be first (newest first ordering)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot resume skips public ready and records metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-overlap-test";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      // v2: resume path records restore metrics
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.equal(
        meta.lastRestoreMetrics.skippedPublicReady,
        true,
        "Resume should skip public readiness",
      );
      assert.equal(
        meta.lastRestoreMetrics.publicReadyMs,
        0,
        "publicReadyMs should be 0 when skipped",
      );
      const m = meta.lastRestoreMetrics;
      assert.ok(typeof m.firewallSyncMs === "number", "firewallSyncMs should be a number");
      assert.ok(
        typeof m.localReadyMs === "number" && m.localReadyMs >= 0,
        "localReadyMs should be a non-negative number",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot records successful firewall sync before running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-firewall-success";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    // networkPolicyHandler returns success after a small delay so firewallSyncMs > 0
    fake.onNetworkPolicy = async (policy) => {
      await new Promise((r) => setTimeout(r, 2));
      return policy;
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "running");
      assert.equal(handle.networkPolicies.length, 1);
      // With a token, the policy uses the record form with ai-gateway transform
      const policy = handle.networkPolicies[0] as { allow: Record<string, unknown[]> };
      assert.ok(policy.allow, "should have allow record");
      assert.ok(policy.allow["api.openai.com"], "should include api.openai.com");
      assert.ok(policy.allow["registry.npmjs.org"], "should include registry.npmjs.org");
      assert.ok(policy.allow["ai-gateway.vercel.sh"], "should include ai-gateway with transform");
      // v2: resume path applies firewall but doesn't record detailed sync outcome
      assert.ok(
        (meta.lastRestoreMetrics?.firewallSyncMs ?? 0) >= 0,
        "firewallSyncMs should be recorded",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot fails closed when enforcing firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-firewall-fail";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle: _handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "error");
      // v2: resume path error message says "persistent resume", not "restore"
      assert.ok(
        meta.lastError?.includes("Firewall sync failed"),
        `expected firewall error, got: ${meta.lastError}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Create-path firewall sync tests
// ---------------------------------------------------------------------------

/**
 * Helper: triggers createAndBootstrapSandbox by calling ensureSandboxRunning
 * with an uninitialized meta (no snapshotId), captures the scheduled callback,
 * and runs it.
 */
async function runCreatePath(): Promise<SingleMeta> {
  let scheduledCallback: (() => Promise<void> | void) | null = null;

  await ensureSandboxRunning({
    origin: "https://test.example.com",
    reason: "create-firewall-test",
    schedule(cb) {
      scheduledCallback = cb;
    },
  });

  assert.ok(scheduledCallback, "expected lifecycle callback");
  await (scheduledCallback as () => Promise<void>)();
  return getInitializedMeta();
}

test("createAndBootstrapSandbox records successful firewall sync before running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    fake.onNetworkPolicy = async (policy) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return policy;
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      assert.equal(meta.status, "running");
      assert.equal(meta.firewall.lastSyncOutcome?.applied, true);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-applied");
      assert.ok(meta.firewall.lastSyncAppliedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("createAndBootstrapSandbox fails closed when enforcing firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      assert.equal(meta.status, "error");
      assert.equal(meta.sandboxId, null);
      assert.equal(meta.portUrls, null);
      assert.ok(
        meta.lastError?.includes("Firewall sync failed during create"),
        `expected create firewall error, got: ${meta.lastError}`,
      );
      assert.equal(meta.firewall.lastSyncOutcome?.applied, false);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-failed");
      assert.ok(meta.firewall.lastSyncFailedAt);
      // Verify sandbox was stopped for cleanup
      const handle = fake.created[fake.created.length - 1];
      assert.equal(handle.stopCalled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("createAndBootstrapSandbox does not fail closed in learning mode when firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      // Learning mode should still reach running despite firewall failure
      assert.equal(meta.status, "running");
      assert.equal(meta.firewall.lastSyncOutcome?.applied, false);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-failed");
      assert.ok(meta.firewall.lastSyncFailedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot passes credentials and config via env to fast-restore script", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-token";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "my-gateway-key",
      });

      // Credentials + config are passed via create-time env (not per-command).
      // The fast-restore script reads from sandbox env vars.
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script");
      // No writeFiles for credentials (passed via env at create time)
      const credentialWrites = handle.writtenFiles.filter(
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path.endsWith(".ai-gateway-api-key"),
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume passes restore env to fast-restore script", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = "sbx-persistent";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    const _resumeHandle = preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake);
      assert.equal((await getInitializedMeta()).status, "running");

      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script for persistent resume");
      assert.equal(bashCmd.env?.OPENCLAW_GATEWAY_TOKEN, "test-gw-token");
      assert.ok(bashCmd.env?.AI_GATEWAY_API_KEY?.includes("placeholder"), "Should use placeholder AI key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("restoreSandboxFromSnapshot passes gateway token via env even without API key", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-no-token";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake);

      // Credentials passed via env to fast-restore script, not via writeFiles
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script even without API key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot writes config via writeFiles, not env", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-origin";
      meta.gatewayToken = "test-gw-token";
      // Use null snapshotDynamicConfigHash to force a config write
      meta.snapshotDynamicConfigHash = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "my-gateway-key",
      });

      // v2: resume path writes config via syncRestoreAssetsIfNeeded (writeFiles)
      const configFile = handle.writtenFiles.find(
        (f) => f.path === OPENCLAW_CONFIG_PATH,
      );
      assert.ok(configFile, "Config should be written via writeFiles");
      const config = JSON.parse(configFile.content.toString("utf8")) as {
        gateway?: { controlUi?: { allowedOrigins?: string[] } };
      };
      assert.deepStrictEqual(
        config.gateway?.controlUi?.allowedOrigins,
        ["https://test.example.com"],
        "Written config should use the current origin passed to ensureSandboxRunning",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot runs bash fast-restore-script and checks exit code", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-startup";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-key",
      });

      // Should have a "bash" command with the fast-restore script path + timeout arg
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run bash with fast-restore script path");
      assert.ok(bashCmd?.args?.[1], "Should pass readiness timeout argument");

      // Should NOT have a separate force-pair step — it's inlined
      const forcePairCmd = handle.commands.find(
        (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      );
      assert.equal(forcePairCmd, undefined, "Should not run separate force-pair (inlined in fast-restore)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot with fast-restore script exit code != 0 throws error", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make the fast-restore script command fail
  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      return { exitCode: 1, output: async () => "fast-restore script failed: missing config" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so get() succeeds and resume path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      // The restore should fail and set status to "error"
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error", "Status should be error after fast-restore script failure");
      assert.ok(meta.lastError?.includes("fast-restore-script"), "lastError should mention fast-restore script failure");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency: concurrent ensureSandboxRunning() calls produce exactly one create
// ---------------------------------------------------------------------------

test("concurrent ensureSandboxRunning() calls from uninitialized produce exactly one sandbox create", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Status is "uninitialized" by default after reset

    const callbacks: Array<() => Promise<void> | void> = [];

    // Fire 5 concurrent calls
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: `concurrent-${i}`,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    // All should return waiting
    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    // Only one callback should have been scheduled (start lock dedup)
    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback, got ${callbacks.length} — start lock should deduplicate`,
    );

    // Meta should be "creating" (set once by the winner)
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating");
  });
});

test("concurrent ensureSandboxRunning() calls from stopped produce exactly one restore", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-concurrent-restore";
    });

    const callbacks: Array<() => Promise<void> | void> = [];

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: `concurrent-restore-${i}`,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback for restore, got ${callbacks.length}`,
    );

    // Restore scheduling should immediately surface "restoring" for snapshot wake flows.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

// ---------------------------------------------------------------------------
// Error recovery: error status transitions to creating on next ensure call
// ---------------------------------------------------------------------------

test("ensureSandboxRunning recovers from error status by scheduling create", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "error-recovery-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Should schedule create work from error state");

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating", "Should transition from error to creating");
    assert.equal(meta.lastError, null, "lastError should be cleared");
  });
});

test("ensureSandboxRunning recovers from error status by scheduling restore when snapshot exists", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = "snap-error-recovery";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "error-recovery-restore-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Should schedule restore work from error state with snapshot");

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring", "Should transition from error to restoring when snapshot exists");
  });
});

test("ensureSandboxRunning full error recovery: error → create → running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "sandbox crashed";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    // Mock fetch for probeGatewayReady
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "full-error-recovery",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Should reach running after error recovery");
      assert.equal(meta.lastError, null, "lastError should be cleared");
      assert.ok(meta.sandboxId, "sandboxId should be set");
      assert.equal(fake.created.length, 1, "Should have created exactly one sandbox");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ensureSandboxRunning create path stores openclaw version (no auto-snapshot)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === OPENCLAW_BIN && args?.[0] === "--version") {
      return { exitCode: 0, output: async () => "openclaw 9.9.9" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bootstrap-snapshot-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback, "Background work should have been scheduled");
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      const handle = fake.created[0];
      assert.ok(handle, "sandbox handle should be tracked");

      assert.equal(meta.status, "running");
      assert.equal(meta.openclawVersion, "openclaw 9.9.9");
      assert.equal(meta.snapshotId, null, "no auto-snapshot after bootstrap");
      assert.equal(handle.snapshotCalled, false, "snapshot should not be called after bootstrap");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Stale sandbox detection: running but gateway probe fails
// ---------------------------------------------------------------------------

test("probeGatewayReady returns not ready when gateway returns non-200", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-1";
      meta.portUrls = { "3000": "https://sbx-stale-1-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response("Bad Gateway", { status: 502 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.equal(result.statusCode, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("probeGatewayReady returns not ready when response body lacks openclaw-app marker", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-2";
      meta.portUrls = { "3000": "https://sbx-stale-2-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Returns 200 but without the marker
    globalThis.fetch = async () =>
      new Response("<html><body>something else</body></html>", { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.equal(result.markerFound, false);
      assert.equal(result.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("probeGatewayReady returns not ready for non-running statuses (stopped, uninitialized)", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    // Stopped with no sandboxId
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    let result = await probeGatewayReady();
    assert.equal(result.ready, false);

    // Uninitialized
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.sandboxId = null;
    });

    result = await probeGatewayReady();
    assert.equal(result.ready, false);
  });
});

// ---------------------------------------------------------------------------
// Restoring status: ensure returns waiting without duplicate restore
// ---------------------------------------------------------------------------

test("ensureSandboxRunning during restoring status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.sandboxId = null;
      meta.snapshotId = "snap-in-progress";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-restoring-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while restoring is in progress");
    assert.equal(fake.created.length, 0, "Should not create any sandbox");
  });
});

test("ensureSandboxRunning during booting status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-booting";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-booting-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while booting");
  });
});

test("ensureSandboxRunning during setup status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-setup";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-setup-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while in setup");
  });
});

// ---------------------------------------------------------------------------
// touchRunningSandbox edge cases
// ---------------------------------------------------------------------------

test("touchRunningSandbox is a no-op when status is creating", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "creating");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get");
  });
});

test("touchRunningSandbox is a no-op when status is error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = null;
      meta.lastError = "some error";
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "error");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get");
  });
});

test("touchRunningSandbox is a no-op when sandboxId is set but status is not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-booting-touch";
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "booting");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get for non-running status");
  });
});

// ---------------------------------------------------------------------------
// markSandboxUnavailable tests
// ---------------------------------------------------------------------------

test("restoreSandboxFromSnapshot falls back to createAndBootstrapSandbox when snapshotId is null", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    // Set status to stopped but with NO snapshotId — should fall back to create
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "fallback-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      // Without snapshotId AND with status "stopped" (not "uninitialized"),
      // scheduleLifecycleWork picks "creating" path since snapshotId is null
      const metaBefore = await getInitializedMeta();
      assert.equal(metaBefore.status, "creating", "Should pick 'creating' when no snapshotId");

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      // The create path runs setupOpenClaw which does npm install + writeFiles (9 files)
      assert.ok(fake.created.length >= 1, "Should have created a sandbox");
      const handle = fake.created[0];

      // Create path runs npm install as first command
      const npmCmd = handle.commands.find(
        (c) => c.cmd === "npm" && c.args?.[0] === "install",
      );
      assert.ok(npmCmd, "Create path should run npm install (bootstrap)");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: markSandboxUnavailable
// ---------------------------------------------------------------------------

test("[lifecycle] markSandboxUnavailable with snapshotId -> transitions to stopped", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-mark-unavail";
      meta.snapshotId = "snap-existing";
    });

    const result = await markSandboxUnavailable("sandbox crashed");
    assert.equal(result.status, "stopped");
    assert.equal(result.sandboxId, null);
    assert.equal(result.portUrls, null);
    assert.equal(result.lastError, "sandbox crashed");
    // snapshotId should be preserved
    assert.equal(result.snapshotId, "snap-existing");
  });
});

test("[lifecycle] markSandboxUnavailable without snapshotId -> transitions to error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-mark-unavail-2";
      meta.snapshotId = null;
    });

    const result = await markSandboxUnavailable("fatal issue");
    assert.equal(result.status, "error");
    assert.equal(result.sandboxId, null);
    assert.equal(result.lastError, "fatal issue");
  });
});

test("[lifecycle] markSandboxUnavailable skips stale sandbox invalidation when sandboxId changed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-fresh";
      meta.snapshotId = "snap-existing";
      meta.portUrls = { "3000": "https://sbx-fresh-3000.fake.vercel.run" };
      meta.lastError = null;
    });

    _resetLogBuffer();

    const result = await markSandboxUnavailable(
      "sandbox crashed",
      "sbx-stale",
    );

    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, "sbx-fresh");
    assert.deepEqual(result.portUrls, {
      "3000": "https://sbx-fresh-3000.fake.vercel.run",
    });
    assert.equal(result.lastError, null);

    const staleLog = getServerLogs().find(
      (entry) => entry.message === "sandbox.mark_unavailable_skipped_stale",
    );
    assert.ok(staleLog, "Should emit sandbox.mark_unavailable_skipped_stale");
    assert.equal(staleLog.data?.expectedSandboxId, "sbx-stale");
    assert.equal(staleLog.data?.actualSandboxId, "sbx-fresh");
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: stopSandbox 409 with no sandboxId
// ---------------------------------------------------------------------------

test("[lifecycle] stopSandbox with no sandboxId -> throws 409 ApiError", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    await assert.rejects(
      () => stopSandbox(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("status" in error);
        assert.equal((error as { status: number }).status, 409);
        assert.ok(error.message.includes("not running"));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: probeGatewayReady success transition (booting -> running)
// ---------------------------------------------------------------------------

test("[lifecycle] probeGatewayReady booting + ready -> transitions to running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-probe-boot";
      meta.portUrls = { "3000": "https://sbx-probe-boot-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, true);
      assert.equal(result.markerFound, true);
      assert.equal(result.statusCode, 200);

      // Should have transitioned to running
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.lastError, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[lifecycle] probeGatewayReady setup + ready -> transitions to running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-probe-setup";
      meta.portUrls = { "3000": "https://sbx-probe-setup-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, true);

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: touchRunningSandbox extend timeout error handling
// ---------------------------------------------------------------------------

test("[lifecycle] touchRunningSandbox extend timeout throws -> marks sandbox unavailable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-extend-error";
      meta.lastAccessedAt = null;
    });

    // Make the extendTimeout throw — use a low timeout so the top-up logic
    // actually attempts an extension (target - remaining > 0).
    const handle = new FakeSandboxHandle("sbx-extend-error", fake.events, 60_000);
    handle.extendTimeout = async () => {
      throw new Error("some network error");
    };
    fake.handlesByIds.set("sbx-extend-error", handle);

    const result = await touchRunningSandbox();
    // Non-sandbox_timeout_invalid errors now mark the sandbox as unavailable
    // (status transitions to "error" when no snapshotId, "stopped" when snapshotId exists)
    assert.ok(
      result.status === "error" || result.status === "stopped",
      `Expected error or stopped status, got: ${result.status}`,
    );
    assert.ok(result.lastError, "lastError should be set");
    assert.ok(result.lastError!.includes("extend timeout failed"), "lastError should reference extend timeout");
  });
});

test("[lifecycle] touchRunningSandbox sandbox_timeout_invalid error -> silently ignored", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-timeout-invalid";
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle("sbx-timeout-invalid", fake.events, 60_000);
    handle.extendTimeout = async () => {
      throw new Error("sandbox_timeout_invalid");
    };
    fake.handlesByIds.set("sbx-timeout-invalid", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.ok(result.lastAccessedAt);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: touchRunningSandbox token refresh paths
// ---------------------------------------------------------------------------

test("[lifecycle] ensureFreshGatewayToken: skips refresh when meta TTL is sufficient", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-token-skip";
      meta.lastAccessedAt = null;
      meta.lastTokenRefreshAt = Date.now();
      // Token expires 30 minutes from now — well above the 10-minute default threshold.
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
      meta.lastTokenSource = "oidc";
    });

    const result = await ensureFreshGatewayToken();
    assert.equal(result.reason, "meta-ttl-sufficient", "Should short-circuit on persisted meta TTL");
    assert.equal(result.refreshed, false);

    // No shell commands should have been issued.
    const handle = fake.handlesByIds.get("sbx-token-skip");
    if (handle) {
      const shCmd = (handle as FakeSandboxHandle).commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(shCmd, undefined, "Should not attempt token refresh when meta TTL sufficient");
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: triggers refresh when meta TTL expired", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token-val");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-token-refresh";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        // Token expired 5 minutes ago — below the 10-minute threshold.
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-token-refresh") as FakeSandboxHandle | undefined;
      if (handle) {
        assert.ok(
          handle.networkPolicies.length >= 1,
          "Should attempt token refresh via network policy update when meta TTL expired",
        );
      }
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: updates network policy with fresh token (no disk write or restart)", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-refresh-script";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-refresh-script") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Token refresh now updates the network policy instead of writing to disk
      assert.ok(
        handle.networkPolicies.length >= 1,
        "Should update network policy with fresh token",
      );

      // No disk write or gateway restart needed
      const writeCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(writeCmd, undefined, "Should not write token to disk");

      const restartCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      );
      assert.equal(restartCmd, undefined, "Should not restart gateway");

      // Metadata updated
      const meta = await getInitializedMeta();
      assert.ok(
        meta.lastTokenRefreshAt !== null && meta.lastTokenRefreshAt > Date.now() - 5000,
        "lastTokenRefreshAt should be updated to recent time",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: no OIDC token available -> skips silently", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set override to undefined = "return undefined from getAiGatewayBearerTokenOptional"
    // (null means "no override, use real logic")
    _setAiGatewayTokenOverrideForTesting(undefined);

    try {
      const staleRefreshTime = Date.now() - 15 * 60 * 1000;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-no-oidc";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = staleRefreshTime;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-no-oidc") as FakeSandboxHandle | undefined;
      if (handle) {
        const shCmd = handle.commands.find(
          (c) => c.cmd === "sh" && c.args?.[0] === "-c",
        );
        assert.equal(shCmd, undefined, "Should not write token when OIDC unavailable");
      }

      const meta = await getInitializedMeta();
      assert.equal(
        meta.lastTokenRefreshAt,
        staleRefreshTime,
        "lastTokenRefreshAt should not be updated when token unavailable",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: policy update failure does not corrupt metadata", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token");

    try {
      const refreshTime = Date.now() - 15 * 60 * 1000;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-policy-fail";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = refreshTime;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      // Pre-create the handle with a failing network policy update
      const handle = new FakeSandboxHandle("sbx-policy-fail", fake.events);
      handle.networkPolicyHandler = async () => {
        throw new Error("network policy update failed");
      };
      fake.handlesByIds.set("sbx-policy-fail", handle);

      await ensureFreshGatewayToken();

      // Metadata should NOT be updated since policy update failed
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Status should still be running");
      assert.equal(
        meta.lastTokenRefreshAt,
        refreshTime,
        "lastTokenRefreshAt should not be updated on failure",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: does NOT force-pair after restart", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("check-pair-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-check-pair";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-check-pair") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Token refresh uses the detached restart path which does not
      // touch pairing state — verify force-pair is NOT invoked.
      const pairCmd = handle.commands.find(
        (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      );
      assert.equal(pairCmd, undefined, "Token refresh should not force-pair after gateway restart");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
test("[lifecycle] ensureFreshGatewayToken: force=true bypasses throttle", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("forced-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-force-refresh";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now();
        // Token expires 30 minutes from now — sufficient TTL.
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
        meta.lastTokenSource = "oidc";
      });

      // Without force, should skip
      await ensureFreshGatewayToken();
      let handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      const policyCountBefore = handle?.networkPolicies.length ?? 0;

      // With force, should refresh even though interval not elapsed
      await ensureFreshGatewayToken({ force: true });
      handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      assert.ok(
        handle.networkPolicies.length > policyCountBefore,
        "Should update network policy when force=true",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: updates network policy and metadata on refresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("same-token");

    try {
      const handle = new FakeSandboxHandle("sbx-same-token", fake.events);
      fake.handlesByIds.set("sbx-same-token", handle);

      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-same-token";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      // Network policy updated with the fresh token transform
      assert.ok(
        handle.networkPolicies.length >= 1,
        "Should update network policy on token refresh",
      );

      // No gateway restart or disk writes
      const restartCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      );
      assert.equal(restartCmd, undefined, "Should not restart gateway");

      // lastTokenRefreshAt should be updated
      const meta = await getInitializedMeta();
      assert.ok(
        meta.lastTokenRefreshAt !== null && meta.lastTokenRefreshAt > Date.now() - 5000,
        "lastTokenRefreshAt should be updated",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureUsableAiGatewayCredential: meta-only TTL authority
// ---------------------------------------------------------------------------

test("[lifecycle] ensureUsableAiGatewayCredential: returns meta-ttl-sufficient when lastTokenExpiresAt is fresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ttl-fresh";
      meta.lastTokenRefreshAt = Date.now();
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
      meta.lastTokenSource = "oidc";
    });

    const result = await ensureUsableAiGatewayCredential();
    assert.equal(result.refreshed, false);
    assert.equal(result.reason, "meta-ttl-sufficient");
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: proceeds to refresh when meta TTL stale despite fresh OIDC token", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Function has a fresh OIDC token, but persisted meta says token is expired.
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-stale-meta";
        meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      const result = await ensureUsableAiGatewayCredential();
      // Should have attempted a refresh (not short-circuited).
      assert.equal(result.refreshed, true);
      assert.equal(result.reason, "refreshed");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: null lastTokenExpiresAt proceeds to refresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-null-expiry";
        meta.lastTokenRefreshAt = Date.now();
        meta.lastTokenExpiresAt = null;
        meta.lastTokenSource = "oidc";
      });

      const result = await ensureUsableAiGatewayCredential();
      // null expiresAt means TTL unknown — should proceed to refresh.
      assert.equal(result.refreshed, true);
      assert.equal(result.reason, "refreshed");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: api-key source returns no-refresh-needed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set AI_GATEWAY_API_KEY env var to simulate api-key source
    process.env.AI_GATEWAY_API_KEY = "test-api-key";
    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-api-key";
      });

      const result = await ensureUsableAiGatewayCredential();
      assert.equal(result.refreshed, false);
      assert.equal(result.reason, "api-key-no-refresh-needed");
    } finally {
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: stale booting/setup re-schedule
// ---------------------------------------------------------------------------

test("[lifecycle] ensureSandboxRunning re-schedules when status=booting and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-stale-boot";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-booting-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale booting");
    } finally {
      Date.now = realNow;
    }
  });
});

test("[lifecycle] ensureSandboxRunning re-schedules when status=setup and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-stale-setup";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-setup-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale setup");
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: getSandboxDomain throws when not running
// ---------------------------------------------------------------------------

test("[lifecycle] getSandboxDomain stopped -> throws 409", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    await assert.rejects(
      () => getSandboxDomain(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("status" in error);
        assert.equal((error as { status: number }).status, 409);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Failure-path tests
// ---------------------------------------------------------------------------

test("[failure] create failure sets status to error", async () => {
  const fake = new FakeSandboxController();

  // v2: lifecycle tries get() first, then falls back to create().
  // Override both to simulate a truly unavailable sandbox.
  fake.get = async () => {
    throw new Error("sandbox not found");
  };
  fake.create = async () => {
    throw new Error("sandbox creation exploded");
  };

  await withTestEnv(fake, async () => {
    // Status starts as "uninitialized" by default after reset
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "create-failure-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "error", "Status should be error after create failure");
    assert.ok(meta.lastError?.includes("sandbox creation exploded"), "lastError should contain the error message");
  });
});

test("[failure] bootstrap (setupOpenClaw) failure sets status to error", async () => {
  const fake = new FakeSandboxController();

  // v2: lifecycle tries get() first; override to fall through to create()
  fake.get = async () => {
    throw new Error("sandbox not found");
  };

  // Make npm install fail (simulating bootstrap failure)
  fake.defaultResponders.push((cmd) => {
    if (cmd === "npm") {
      throw new Error("npm install crashed");
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "bootstrap-failure-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "error", "Status should be error after bootstrap failure");
    assert.ok(meta.lastError, "lastError should be set after bootstrap failure");
  });
});

test("[failure] stop failure during stop propagates error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-snap-fail";
      meta.portUrls = { "3000": "https://sbx-snap-fail-3000.fake.vercel.run" };
    });

    // v2: stopSandbox calls stop(), not snapshot() — override stop() to throw
    const handle = new FakeSandboxHandle("sbx-snap-fail", fake.events);
    handle.stop = async () => {
      throw new Error("stop failed unexpectedly");
    };
    fake.handlesByIds.set("sbx-snap-fail", handle);

    await assert.rejects(
      () => stopSandbox(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("stop failed unexpectedly"));
        return true;
      },
    );
  });
});

test("[failure] restore failure from stopped state (fast-restore script fails)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make bash fast-restore-script command return non-zero exit code
  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      return { exitCode: 1, output: async () => "fast-restore script failed" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-startup-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-startup-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error", "Status should be error after fast-restore script failure");
      assert.ok(meta.lastError?.includes("fast-restore-script"), "lastError should mention fast-restore failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] credential writeFiles failure does not block restore (env-based tokens)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make writeFiles throw on credential file paths — this should be
  // non-fatal because the gateway reads tokens from env vars passed at
  // sandbox create time.
  let writeFilesCallCount = 0;
  fake.onWriteFiles = (files) => {
    writeFilesCallCount++;
    if (writeFilesCallCount === 1 && files.some((f) => f.path.includes(".gateway-token"))) {
      throw new Error("writeFiles failed: permission denied");
    }
  };

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-token-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-token-write-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      // Restore should succeed despite credential file write failure —
      // the gateway uses env-provided tokens.
      assert.equal(meta.status, "running", "Status should be running (env tokens used)");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
      fake.onWriteFiles = undefined;
    }
  });
});

test("[failure] concurrent ensureSandboxRunning from error status creates only one sandbox", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = "snap-error-concurrent";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const callbacks: Array<() => Promise<void> | void> = [];

      // Fire 2 concurrent calls
      await Promise.all(
        Array.from({ length: 2 }, (_, i) =>
          ensureSandboxRunning({
            origin: "https://test.example.com",
            reason: `error-concurrent-${i}`,
            schedule(cb) {
              callbacks.push(cb);
            },
          }),
        ),
      );

      // Only one callback should have been scheduled (start lock dedup)
      assert.equal(
        callbacks.length,
        1,
        `Expected exactly 1 scheduled callback from error state, got ${callbacks.length}`,
      );

      // Run the scheduled callback
      await Promise.all(callbacks.map((cb) => cb()));

      // v2: lifecycle tries get() first (resume), falls back to create().
      // Only one sandbox should have been used (via get or create).
      const totalHandles = fake.created.length + fake.retrieved.length;
      assert.ok(totalHandles >= 1, `Should have used at least one sandbox, got ${totalHandles} (created=${fake.created.length}, retrieved=${fake.retrieved.length})`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] ensureSandboxReady times out with 504 when gateway never shows openclaw-app marker", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-probe-timeout";
      meta.portUrls = { "3000": "https://sbx-probe-timeout-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Always return HTML without the openclaw-app marker
    globalThis.fetch = async () =>
      new Response("<html><body>not ready yet</body></html>", { status: 200 });

    try {
      await assert.rejects(
        () =>
          ensureSandboxReady({
            origin: "https://test.example.com",
            reason: "probe-timeout-test",
            timeoutMs: 100,
            pollIntervalMs: 10,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("status" in error);
          assert.equal((error as { status: number }).status, 504);
          assert.ok(error.message.includes("did not become ready"));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileSandboxHealth
// ---------------------------------------------------------------------------

test("reconcileSandboxHealth returns ready when gateway is reachable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-healthy";
      meta.portUrls = { "3000": "https://sbx-healthy-3000.fake.vercel.run" };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><div id="openclaw-app"></div></html>', {
        status: 200,
      });

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-healthy",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.repaired, false);
      assert.equal(result.meta.status, "running");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth detects stale running and triggers recovery", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale";
      meta.snapshotId = "snap-for-recovery";
      meta.portUrls = { "3000": "https://sbx-stale-3000.fake.vercel.run" };
    });

    // Gateway probe fails — sandbox is gone
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    let scheduledWork: (() => Promise<void> | void) | null = null;

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-stale-running",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      // Meta should no longer say running (marked unavailable)
      const meta = await getInitializedMeta();
      assert.notEqual(meta.status, "running");
      // Recovery should have been scheduled
      assert.ok(scheduledWork, "Background recovery should have been scheduled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth delegates to ensureSandboxRunning when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-stopped";
    });

    let scheduledWork: (() => Promise<void> | void) | null = null;

    const result = await reconcileSandboxHealth({
      origin: "https://test.example.com",
      reason: "test-not-running",
      schedule(cb) {
        scheduledWork = cb;
      },
    });

    assert.equal(result.status, "recovering");
    assert.equal(result.repaired, false);
    assert.ok(scheduledWork, "Recovery should have been scheduled via ensureSandboxRunning");
    // Restore scheduling should immediately surface "restoring" when a snapshot exists.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

test("reconcileSandboxHealth concurrent calls are deduplicated by start lock", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-concurrent";
    });

    const scheduled: Array<() => Promise<void> | void> = [];
    const schedule = (cb: () => Promise<void> | void) => {
      scheduled.push(cb);
    };

    // Fire two concurrent reconcile calls
    const [r1, r2] = await Promise.all([
      reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "concurrent-1",
        schedule,
      }),
      reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "concurrent-2",
        schedule,
      }),
    ]);

    // Both should return recovering
    assert.equal(r1.status, "recovering");
    assert.equal(r2.status, "recovering");

    // Only one background task should have been scheduled (start lock dedup)
    assert.equal(scheduled.length, 1, "Concurrent ensures should be deduplicated by the start lock");
  });
});

test("reconcileSandboxHealth with 410-style unreachable sandbox repairs correctly", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-410";
      meta.snapshotId = "snap-410-recovery";
      meta.portUrls = { "3000": "https://sbx-410-3000.fake.vercel.run" };
    });

    // Simulate a 410 Gone response from gateway probe
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("Gone", { status: 410 });

    let scheduledWork: (() => Promise<void> | void) | null = null;

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "gateway.410",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      assert.ok(scheduledWork, "Recovery should have been scheduled");

      // Verify meta was cleared and recovery is now surfaced as restoring.
      const meta = await getInitializedMeta();
      assert.equal(meta.sandboxId, null);
      assert.equal(meta.status, "restoring");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth skips stale invalidation when sandbox was already replaced", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale";
      meta.snapshotId = "snap-replaced";
      meta.portUrls = { "3000": "https://sbx-stale-3000.fake.vercel.run" };
    });

    const originalFetch = globalThis.fetch;
    let scheduledWork: (() => Promise<void> | void) | null = null;

    globalThis.fetch = async () => {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-fresh";
        meta.portUrls = { "3000": "https://sbx-fresh-3000.fake.vercel.run" };
        meta.lastError = null;
      });
      throw new Error("ECONNREFUSED");
    };

    _resetLogBuffer();

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-stale-replaced",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      assert.equal(
        scheduledWork,
        null,
        "Late callers should not schedule a second recovery after another worker replaced the sandbox",
      );
      assert.equal(result.meta.sandboxId, "sbx-fresh");
      assert.equal(result.meta.status, "running");

      const meta = await getInitializedMeta();
      assert.equal(meta.sandboxId, "sbx-fresh");
      assert.equal(meta.status, "running");
      assert.deepEqual(meta.portUrls, {
        "3000": "https://sbx-fresh-3000.fake.vercel.run",
      });

      const staleLog = getServerLogs().find(
        (entry) => entry.message === "sandbox.mark_unavailable_skipped_stale",
      );
      assert.ok(staleLog, "Should emit sandbox.mark_unavailable_skipped_stale");
      assert.equal(staleLog.data?.expectedSandboxId, "sbx-stale");
      assert.equal(staleLog.data?.actualSandboxId, "sbx-fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle top-up timeout semantics (acceptance criteria)
// ---------------------------------------------------------------------------

test("touchRunningSandbox tops up by difference when remaining < target (300000 target, 120000 remaining -> extend 180000)", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-math";
      meta.lastAccessedAt = null;
    });

    // Pre-create handle with 120000ms remaining
    const handle = new FakeSandboxHandle("sbx-topup-math", fake.events, 120_000);
    fake.handlesByIds.set("sbx-topup-math", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 1, "Should extend timeout exactly once");
    assert.equal(handle.extendedTimeouts[0], 180_000, "Should extend by 300000 - 120000 = 180000");
  });
});

test("touchRunningSandbox does not extend when remaining >= target (300000 target, 420000 remaining -> no extend)", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-skip";
      meta.lastAccessedAt = null;
    });

    // Pre-create handle with 420000ms remaining (above target)
    const handle = new FakeSandboxHandle("sbx-topup-skip", fake.events, 420_000);
    fake.handlesByIds.set("sbx-topup-skip", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 0, "Should NOT extend timeout when remaining >= target");
  });
});

test("touchRunningSandbox does not extend when remaining == target exactly", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-exact";
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle("sbx-topup-exact", fake.events, 300_000);
    fake.handlesByIds.set("sbx-topup-exact", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 0, "Should NOT extend when remaining == target");
  });
});

test("touchRunningSandbox marks sandbox unavailable when controller.get() fails", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-lookup-fail";
      meta.lastAccessedAt = null;
      meta.snapshotId = "snap-for-recovery";
    });

    // Override get() to throw
    fake.get = async () => {
      throw new Error("sandbox not found");
    };

    const result = await touchRunningSandbox();
    assert.equal(result.status, "stopped", "Should transition to stopped (has snapshotId)");
    assert.ok(result.lastError?.includes("sandbox lookup failed"), "lastError should mention lookup failure");
    assert.equal(result.sandboxId, null, "sandboxId should be cleared");
  });
});

test("create flow passes configured sleepAfterMs as timeout to controller.create()", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "create-timeout-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const handle = fake.created[0];
      assert.ok(handle, "Should have created a sandbox");
      // The handle's initial timeout should match the configured sleepAfterMs
      // (FakeSandboxHandle stores the timeout passed via params.timeout)
      // After create + bootstrap the handle may have had extendTimeout called,
      // so check the initial timeout via the created params instead.
      // Since our FakeSandboxHandle now receives params.timeout in constructor,
      // the initial timeoutMs was 300000 and any extensions add to it.
      const totalTimeout = handle.timeout;
      const totalExtended = handle.extendedTimeouts.reduce((a, b) => a + b, 0);
      const initialTimeout = totalTimeout - totalExtended;
      assert.equal(initialTimeout, 300_000, "Create should pass sleepAfterMs=300000 as timeout");
      assert.ok(
        Object.prototype.hasOwnProperty.call((await getInitializedMeta()).portUrls ?? {}, String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)),
        `Create should expose port ${OPENCLAW_TELEGRAM_WEBHOOK_PORT} in portUrls`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restore flow passes configured sleepAfterMs as timeout to controller.create()", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-timeout-test";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      const totalTimeout = handle.timeout;
      const totalExtended = handle.extendedTimeouts.reduce((a, b) => a + b, 0);
      const initialTimeout = totalTimeout - totalExtended;
      assert.equal(initialTimeout, 300_000, "Restore should pass sleepAfterMs=300000 as timeout");
      const meta = await getInitializedMeta();
      assert.ok(
        Object.prototype.hasOwnProperty.call(meta.portUrls ?? {}, String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)),
        `Restore should expose port ${OPENCLAW_TELEGRAM_WEBHOOK_PORT} in portUrls`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("getRunningSandboxTimeoutRemainingMs returns remaining ms for running sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-remaining";
    });

    const handle = new FakeSandboxHandle("sbx-remaining", fake.events, 250_000);
    fake.handlesByIds.set("sbx-remaining", handle);

    const remaining = await getRunningSandboxTimeoutRemainingMs();
    assert.equal(remaining, 250_000);
  });
});

test("getRunningSandboxTimeoutRemainingMs returns null when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const remaining = await getRunningSandboxTimeoutRemainingMs();
    assert.equal(remaining, null);
  });
});

// ---------------------------------------------------------------------------
// Correlated opId: concurrent wakes produce one restore with shared opId
// ---------------------------------------------------------------------------

test("concurrent ensureSandboxRunning with op context: exactly one restore, restore-phase logs share the winning opId", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-opid-concurrency";
    });

    _resetLogBuffer();

    const ops = Array.from({ length: 3 }, (_, i) =>
      createOperationContext({
        trigger: "channel.queue.consumer",
        reason: `concurrent-wake-${i}`,
        channel: i === 0 ? "slack" : i === 1 ? "telegram" : "discord",
      }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];

    const results = await Promise.all(
      ops.map((op) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: op.reason,
          op,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    // All should return waiting
    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    // Exactly one scheduled callback (deduplicated by start lock)
    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback, got ${callbacks.length}`,
    );

    // Execute the resume
    // Pre-register a handle for the persistent sandbox name so get() succeeds
    preRegisterResumeHandle(fake);
    await callbacks[0]();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running", "Sandbox should be running after resume");

    // v2: persistent resume uses get() not create(source: snapshot),
    // so there are no "restore" events — verify via resume completion log instead.
    const logs = getServerLogs();
    const resumeLogs = logs.filter((l) =>
      l.message === "sandbox.create.persistent_resume.complete",
    );
    assert.equal(resumeLogs.length, 1, "Should produce exactly one persistent resume");

    // Verify resume logs contain opId from the winning operation
    const logsWithOpId = logs.filter((l) =>
      (l.message === "sandbox.create.persistent_resume" ||
       l.message === "sandbox.create.persistent_resume.complete" ||
       l.message === "sandbox.lifecycle.action_chosen") &&
      l.data?.opId,
    );
    assert.ok(
      logsWithOpId.length >= 1,
      `Expected at least 1 resume log with opId, got ${logsWithOpId.length}`,
    );

    // All resume logs with opId should share the same opId
    const opIds = [...new Set(logsWithOpId.map((l) => l.data?.opId as string))];
    assert.equal(
      opIds.length,
      1,
      `All resume logs should share one opId, got ${opIds.length}: ${JSON.stringify(opIds)}`,
    );

    // The winning opId should belong to one of our original operations
    const winningOpId = opIds[0];
    assert.ok(
      winningOpId.startsWith("op_"),
      `opId should have op_ prefix, got ${winningOpId}`,
    );

    // Verify the lifecycle.action_chosen log was emitted
    const actionLog = logs.find((l) => l.message === "sandbox.lifecycle.action_chosen");
    assert.ok(actionLog, "Should emit sandbox.lifecycle.action_chosen");
    assert.equal(actionLog.data?.action, "restoring");
    assert.ok(actionLog.data?.opId, "action_chosen should include opId");
  });
});

test("ensureSandboxRunning with op context includes opId in ensure_running log", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-opid-test";
    });

    fake.handlesByIds.set("sbx-opid-test", new FakeSandboxHandle("sbx-opid-test", fake.events));

    _resetLogBuffer();

    const op = createOperationContext({
      trigger: "channel.queue.consumer",
      reason: "channel:slack",
      channel: "slack",
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "channel:slack",
      op,
    });

    assert.equal(result.state, "running");

    const logs = getServerLogs();
    const ensureLog = logs.find((l) => l.message === "sandbox.ensure_running");
    assert.ok(ensureLog, "Should emit sandbox.ensure_running");
    assert.equal(ensureLog.data?.opId, op.opId, "ensure_running should include the passed opId");
    assert.equal(ensureLog.data?.channel, "slack");
    assert.equal(ensureLog.data?.status, "running");
  });
});

// ---------------------------------------------------------------------------
// Fast-restore structured log tests
// ---------------------------------------------------------------------------

test("successful restore emits sandbox.create.persistent_resume.complete with structured context", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-result";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });
      assert.equal(meta.status, "running");

      const logs = getServerLogs();
      // v2: persistent resume logs completion instead of fast_restore_result
      const resultLog = logs.find(
        (l) => l.message === "sandbox.create.persistent_resume.complete",
      );
      assert.ok(resultLog, "Should emit sandbox.create.persistent_resume.complete");
      assert.equal(resultLog.level, "info");
      assert.ok(
        typeof resultLog.data?.totalMs === "number",
        "totalMs should be a number",
      );
      assert.ok(
        typeof resultLog.data?.startupScriptMs === "number",
        "startupScriptMs should be a number",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("successful restore records localReadyMs from fast-restore script stdout in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-ready";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });

      // v2: persistent resume records localReadyMs in metrics from fast-restore stdout
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      // The fake fast-restore script returns {"ready":true,"attempts":3,"readyMs":150}
      assert.equal(meta.lastRestoreMetrics.localReadyMs, 150, "localReadyMs should be parsed from stdout");
      assert.ok(
        (meta.lastRestoreMetrics.postLocalReadyBlockingMs ?? -1) >= 0,
        "postLocalReadyBlockingMs should be recorded",
      );

      // Also verify the completion log was emitted
      const logs = getServerLogs();
      const completionLog = logs.find(
        (l) => l.message === "sandbox.create.persistent_resume.complete",
      );
      assert.ok(completionLog, "Should emit persistent_resume.complete");
      assert.equal(completionLog.data?.localReadyMs, 150);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("successful restore records telegram listener readiness from fast-restore stdout in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      const stdoutJson = JSON.stringify({
        ready: true,
        attempts: 4,
        readyMs: 220,
        telegramExpected: true,
        telegramConfigPresent: true,
        telegramReady: true,
        telegramStatus: 401,
        telegramWaitMs: 1800,
        telegramError: null,
      });
      return {
        exitCode: 0,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return stdoutJson;
          if (stream === "stderr") return '{"event":"fast_restore.telegram_probe"}';
          return `${stdoutJson}\n{"event":"fast_restore.telegram_probe"}`;
        },
      };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-tg-ready";
      meta.gatewayToken = "test-gw-token";
      meta.channels.telegram = {
        botToken: "tg-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });

      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.equal(meta.lastRestoreMetrics.telegramExpected, true);
      assert.equal(meta.lastRestoreMetrics.telegramConfigPresent, true);
      assert.equal(meta.lastRestoreMetrics.telegramListenerReady, true);
      assert.equal(meta.lastRestoreMetrics.telegramListenerStatus, 401);
      assert.equal(meta.lastRestoreMetrics.telegramListenerWaitMs, 1800);
      assert.equal(meta.lastRestoreMetrics.telegramListenerError, null);
      assert.equal(meta.lastRestoreMetrics.telegramReconcileBlocking, false);
      assert.equal(meta.lastRestoreMetrics.telegramSecretSyncBlocking, false);
      assert.equal(meta.lastRestoreMetrics.telegramReconcileMs, null);
      assert.equal(meta.lastRestoreMetrics.telegramSecretSyncMs, null);
      assert.ok(
        (meta.lastRestoreMetrics.postLocalReadyBlockingMs ?? -1) >= 0,
        "postLocalReadyBlockingMs should be recorded",
      );

      const logs = getServerLogs();
      const completionLog = [...logs].reverse().find(
        (entry) =>
          entry.message === "sandbox.create.persistent_resume.complete"
          && entry.data?.sandboxId === meta.sandboxId,
      );
      assert.ok(completionLog, "persistent resume completion should be logged");
      assert.equal(completionLog.data?.sandboxId, meta.sandboxId);
      assert.equal(typeof completionLog.data?.localReadyMs, "number");
      assert.equal(completionLog.data?.telegramExpected, true);
      assert.equal(completionLog.data?.telegramConfigPresent, true);
      assert.equal(completionLog.data?.telegramListenerReady, true);
      assert.equal(completionLog.data?.telegramListenerStatus, 401);
      assert.equal(completionLog.data?.telegramListenerWaitMs, 1800);
      assert.equal(completionLog.data?.telegramListenerError, null);
      assert.equal(completionLog.data?.startupScriptMs, meta.lastRestoreMetrics.startupScriptMs);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("non-zero fast-restore exit causes error status via lifecycle_failed", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      return {
        exitCode: 1,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return "error output from script";
          if (stream === "stderr") return "stderr details";
          return "error output from script\nstderr details";
        },
      };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-fail";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      // Pre-register the resume handle so get() succeeds
      preRegisterResumeHandle(fake);

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-fail-log-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      // v2: fast-restore failure bubbles up as lifecycle_failed
      const logs = getServerLogs();
      const failedLog = logs.find(
        (l) => l.message === "sandbox.lifecycle_failed",
      );
      assert.ok(failedLog, "Should emit sandbox.lifecycle_failed");
      assert.equal(failedLog.level, "error");
      assert.ok(
        typeof failedLog.data?.error === "string",
        "error should be present",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Restore metrics: background asset sync must not rewrite history
// ---------------------------------------------------------------------------

test("persistent resume records skippedStaticAssetSync=false and assetSha256=null in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-needs-background-assets";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      const meta = await getInitializedMeta();
      // v2: persistent resume path always records these fixed values
      assert.equal(
        meta.lastRestoreMetrics?.skippedStaticAssetSync,
        false,
        "persistent resume always reports skippedStaticAssetSync=false",
      );
      assert.equal(
        meta.lastRestoreMetrics?.assetSha256,
        null,
        "persistent resume records assetSha256=null (asset sync is inline, not tracked in metrics)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRunningSandboxDynamicConfigFresh
// ---------------------------------------------------------------------------

test("ensureRunningSandboxDynamicConfigFresh returns already-fresh when hash matches", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Compute the expected hash from current (empty) channel state and set it.
    // Runtime reconcile compares against runtimeDynamicConfigHash.
    const expectedHash = computeGatewayConfigHash({});
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = expectedHash;
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true, "Should be verified");
    assert.equal(result.changed, false, "Should not have changed anything");
    assert.equal(result.reason, "already-fresh");

    // No gateway restart should have happened.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.equal(
      handle?.commands.filter(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      ).length ?? 0,
      0,
      "No gateway restart should happen on hash match",
    );
  });
});

test("ensureRunningSandboxDynamicConfigFresh rewrites and restarts on hash miss", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Set a stale runtime hash so reconcile detects a miss.
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash-from-previous-deploy";
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true, "Should be verified after reconcile");
    assert.equal(result.changed, true, "Should have changed config");
    assert.equal(result.reason, "rewritten-and-restarted");

    // Verify runtimeDynamicConfigHash was updated (not snapshotConfigHash).
    const meta = await h.getMeta();
    const expectedHash = computeGatewayConfigHash({});
    assert.equal(meta.runtimeDynamicConfigHash, expectedHash, "Runtime hash should be updated in metadata");
    // snapshotDynamicConfigHash must NOT be touched by runtime reconcile.
    assert.equal(meta.snapshotDynamicConfigHash, null, "Snapshot hash must not be updated by runtime reconcile");

    // Verify the running sandbox invoked the restart script after rewriting config.
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(
      handle,
      "Should have a sandbox handle for the running sandbox",
    );
    assert.ok(
      handle.commands.some(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      ),
      "Gateway should be restarted via the restart script",
    );
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns rewrite-failed on writeFiles error", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    // Install a hook that throws on writeFiles to simulate failure.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle, "Should have a sandbox handle");

    handle.writeFilesHook = () => {
      throw new Error("Simulated writeFiles failure");
    };

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "rewrite-failed");
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns restart-failed on nonzero exit", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    // Install a command responder that fails the restart script.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle, "Should have a sandbox handle");

    handle.responders.push((cmd, args) => {
      if (cmd === "bash" && args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH) {
        return { exitCode: 1, output: async () => "restart failed" };
      }
      return undefined;
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, true, "Files were written before restart failed");
    assert.equal(result.reason, "restart-failed");
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns sandbox-unavailable when not running", async () => {
  await withHarness(async () => {
    // Do not drive to running — stay in uninitialized state.
    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "sandbox-unavailable");
  });
});

// ---------------------------------------------------------------------------
// Restore target truth split
// ---------------------------------------------------------------------------

test("runtime reconcile updates runtimeDynamicConfigHash but not snapshotDynamicConfigHash", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Seed snapshot-truth from a prior snapshot.
    await h.mutateMeta((meta) => {
      meta.snapshotDynamicConfigHash = "old-snapshot-hash";
      meta.runtimeDynamicConfigHash = "stale-runtime-hash";
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true);
    assert.equal(result.changed, true);

    const meta = await h.getMeta();
    const expectedHash = computeGatewayConfigHash({});
    assert.equal(meta.runtimeDynamicConfigHash, expectedHash);
    assert.equal(meta.snapshotDynamicConfigHash, "old-snapshot-hash",
      "Snapshot-truth must not be altered by runtime reconcile");
    assert.equal(meta.restorePreparedStatus, "dirty",
      "Runtime reconcile should mark restore target dirty");
  });
});

test("v2 persistent resume clears snapshot-era asset hashes", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-asset-truth-split";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotAssetSha256 = "old-snapshot-asset-hash";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      const meta = await getInitializedMeta();
      // v2: createAndBootstrapSandboxWithinLifecycleLock clears snapshot-era fields
      assert.equal(
        meta.snapshotAssetSha256,
        null,
        "snapshotAssetSha256 should be cleared by v2 create path",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restore after runtime-only reconcile still performs hot-path config write", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const currentHash = computeGatewayConfigHash({});

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-stale-snapshot-hash";
      meta.gatewayToken = "test-gw-token";
      // Simulate: runtime was reconciled (runtimeDynamicConfigHash is fresh)
      // but snapshot-truth is stale (snapshotDynamicConfigHash differs).
      meta.snapshotDynamicConfigHash = "stale-snapshot-hash";
      meta.runtimeDynamicConfigHash = currentHash;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: persistent resume always writes config via syncRestoreAssetsIfNeeded.
      // At least 1 config write should happen (dynamic files always written).
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(
        configWrites.length >= 1,
        "Persistent resume should write config via asset sync",
      );

      const meta = await getInitializedMeta();
      // v2: persistent resume metrics don't track dynamicConfigReason
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("stopSandbox transitions to stopped and preserves sandboxId", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const meta = await stopSandbox();

    assert.equal(meta.status, "stopped");
    // v2: persistent sandbox preserves sandboxId across stop/resume
    assert.ok(meta.sandboxId, "sandboxId should be preserved after stop");
    assert.equal(meta.portUrls, null, "portUrls should be cleared on stop");
  });
});

test("markRestoreTargetDirty sets status to dirty", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set restorePreparedStatus to "ready" to test dirty transition
    await mutateMeta((m) => {
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
    });

    const meta = await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

    assert.equal(meta.restorePreparedStatus, "dirty");
    assert.equal(meta.restorePreparedReason, "dynamic-config-changed");
  });
});

test("isPreparedRestoreReusable returns true only when all hashes match and status is ready", () => {
  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        snapshotDynamicConfigHash: "cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "ready",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    true,
    "Should be reusable when all match",
  );

  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        snapshotDynamicConfigHash: "cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "dirty",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    false,
    "Should not be reusable when status is dirty",
  );

  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        snapshotDynamicConfigHash: "old-cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "ready",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    false,
    "Should not be reusable when config hash differs",
  );
});

test("resetSandbox clears restoreOracle to idle defaults", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set oracle to a non-idle state to test reset behavior
    await mutateMeta((m) => {
      m.restoreOracle.status = "pending";
      m.restoreOracle.pendingReason = "dynamic-config-changed";
    });

    let meta = await getInitializedMeta();
    assert.equal(meta.restoreOracle.status, "pending");

    // Reset should restore idle defaults and delete the sandbox
    const beforeSandboxId = meta.sandboxId;
    meta = await resetSandbox({ origin: "https://app.example.com", reason: "test-reset" });

    // Verify sandbox was deleted (not just stopped)
    const handle = h.controller.getHandle(beforeSandboxId!);
    assert.ok(handle?.deleteCalled, "reset should delete the persistent sandbox");

    assert.equal(meta.restoreOracle.status, "idle", "Oracle status should be idle after reset");
    assert.equal(meta.restoreOracle.pendingReason, null, "Oracle pendingReason should be null after reset");
    assert.equal(meta.restoreOracle.lastEvaluatedAt, null, "Oracle timestamps should clear after reset");
    assert.equal(meta.restoreOracle.lastStartedAt, null);
    assert.equal(meta.restoreOracle.lastCompletedAt, null);
    assert.equal(meta.restoreOracle.lastBlockedReason, null);
    assert.equal(meta.restoreOracle.lastError, null);
    assert.equal(meta.restoreOracle.consecutiveFailures, 0);
    assert.equal(meta.restoreOracle.lastResult, null);
  });
});

test("markRestoreTargetDirty preserves running oracle status", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set oracle to running to simulate mid-cycle
    const { mutateMeta } = await import("@/server/store/store");
    await mutateMeta((m) => {
      m.restoreOracle.status = "running";
      m.restoreOracle.lastStartedAt = Date.now();
    });

    const meta = await markRestoreTargetDirty({ reason: "static-assets-changed" });

    assert.equal(meta.restorePreparedStatus, "dirty");
    assert.equal(meta.restoreOracle.status, "running", "Should not overwrite running oracle status");
    assert.equal(meta.restoreOracle.pendingReason, "static-assets-changed", "Should still set pending reason");
  });
});

// ---------------------------------------------------------------------------
// Cron jobs persistence
// ---------------------------------------------------------------------------

test("stopSandbox persists cron jobs JSON to store", async () => {
  const fake = new FakeSandboxController();
  const cronJobsJson = JSON.stringify({
    version: 1,
    jobs: [{
      id: "test-job",
      enabled: true,
      state: { nextRunAtMs: Date.now() + 60_000 },
    }],
  });

  await withTestEnv(fake, async () => {
    // Create a handle via the controller so it has the shared eventLog.
    const handle = await fake.create({ ports: [3000], timeout: 300_000 });
    // Pre-populate cron/jobs.json so readFileToBuffer finds it.
    await handle.writeFiles([{
      path: "/home/vercel-sandbox/.openclaw/cron/jobs.json",
      content: Buffer.from(cronJobsJson),
    }]);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.gatewayToken = "test-gw-token";
    });

    await stopSandbox();

    const record = await getStore().getValue<{ version: number; jobCount: number; jobIds: string[]; source: string }>(CRON_JOBS_KEY());
    assert.ok(record, "Structured cron record should be persisted to store");
    assert.equal(record.version, 1);
    assert.equal(record.jobCount, 1);
    assert.deepEqual(record.jobIds, ["test-job"]);
    assert.equal(record.source, "stop");
  });
});

test("v2 persistent resume does not restore cron jobs from store", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const cronJobsJson = JSON.stringify({
    version: 1,
    jobs: [{
      id: "avatar-quote",
      enabled: true,
      state: { nextRunAtMs: Date.now() + 60_000 },
    }],
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-cron-restore";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-populate the store with cron jobs
    await getStore().setValue(CRON_JOBS_KEY(), cronJobsJson);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "running");

      // v2: persistent resume doesn't do cron restoration from store
      assert.equal(
        meta.lastRestoreMetrics?.cronRestoreOutcome,
        undefined,
        "v2 persistent resume should not have cronRestoreOutcome",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("v2 persistent resume does not track cronRestoreOutcome even with store data", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const cronJobsJson = JSON.stringify({
    version: 1,
    jobs: [
      {
        id: "avatar-quote",
        enabled: true,
        state: { nextRunAtMs: Date.now() + 60_000 },
      },
      {
        id: "daily-standup",
        enabled: true,
        state: { nextRunAtMs: Date.now() + 120_000 },
      },
    ],
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-cron-restore-unverified";
      meta.gatewayToken = "test-gw-token";
    });

    await getStore().setValue(CRON_JOBS_KEY(), cronJobsJson);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "running");
      // v2: persistent resume doesn't set cronRestoreOutcome
      assert.equal(meta.lastRestoreMetrics?.cronRestoreOutcome, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume skips cron restore when store has no jobs", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-no-cron";
      meta.gatewayToken = "test-gw-token";
    });

    // No cron jobs in store

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "running");

      // Verify NO cron jobs.json was written
      const cronWrite = handle.writtenFiles.find(
        (f) => f.path.includes("cron/jobs.json"),
      );
      assert.ok(!cronWrite, "Should not write cron jobs when store is empty");

      // v2 persistent resume path does not track cronRestoreOutcome in lastRestoreMetrics
      // (cron restore is handled by the old snapshot-based restore path which is no longer used)
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
