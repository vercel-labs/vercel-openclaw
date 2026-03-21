import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta } from "@/shared/types";

import {
  ensureFreshGatewayToken,
  ensureSandboxRunning,
  ensureSandboxReady,
  getRunningSandboxTimeoutRemainingMs,
  probeGatewayReady,
  reconcileSandboxHealth,
  stopSandbox,
  snapshotSandbox,
  getSandboxDomain,
  touchRunningSandbox,
  markSandboxUnavailable,
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
  mutateMeta,
} from "@/server/store/store";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  createOperationContext,
} from "@/server/observability/operation-context";
import {
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
} from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
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
    assert.ok(result.snapshotId?.startsWith("snap-"));
    assert.equal(result.sandboxId, null);
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

test("stopSandbox runs pre-snapshot cleanup before snapshot", async () => {
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
    assert.equal(handle.snapshotCalled, true, "snapshot should be called after cleanup");

    const cleanupEventIndex = h.controller.events.findIndex((event) =>
      isPreSnapshotCleanupEvent(event, sandboxId),
    );
    const snapshotEventIndex = h.controller.events.findIndex(
      (event) => event.kind === "snapshot" && event.sandboxId === sandboxId,
    );

    assert.ok(cleanupEventIndex >= 0, "cleanup command event should be recorded");
    assert.ok(snapshotEventIndex > cleanupEventIndex, "cleanup should run before snapshot");
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

test("pre-snapshot cleanup failure does not prevent snapshot", async () => {
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
    assert.ok(result.snapshotId?.startsWith("snap-"));
    assert.equal(handle.snapshotCalled, true, "snapshot should still run after cleanup failure");
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
    assert.ok(result.snapshotId?.startsWith("snap-"));

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
    assert.ok(result.snapshotId);
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

    // Meta should now be "restoring"
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
 * Helper: triggers restoreSandboxFromSnapshot by calling ensureSandboxRunning
 * with a stopped+snapshotId meta, captures the scheduled callback, and runs it.
 */
async function triggerRestore(
  fake: FakeSandboxController,
  opts?: { tokenOverride?: string | undefined },
): Promise<{ handle: FakeSandboxHandle; meta: SingleMeta }> {
  _setAiGatewayTokenOverrideForTesting(opts?.tokenOverride ?? undefined);

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

    assert.ok(fake.created.length >= 1, "A sandbox should have been created");
    const handle = fake.created[fake.created.length - 1];
    const meta = await getInitializedMeta();
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot skips static files on second restore when manifest hash matches", async () => {
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
      // First restore — writes all files
      const { handle: firstHandle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });
      assert.ok(firstHandle.writtenFiles.length > 0, "First restore should write background asset files");

      // Snapshot the sandbox so we can restore again
      const snap = await firstHandle.snapshot();

      // Reset meta to stopped with the new snapshot, simulating a second restore
      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.snapshotId = snap.snapshotId;
        meta.sandboxId = null;
        meta.portUrls = null;
      });

      // Second restore — the new sandbox handle will have the manifest from
      // the first restore's written files because FakeSandboxHandle.readFileToBuffer
      // reads from writtenFiles. Since the controller creates a new handle,
      // we need to pre-populate it with the manifest.
      // The new handle won't have the manifest, so we use a custom controller.
      const manifestFile = firstHandle.writtenFiles.find((f) =>
        f.path.includes(".restore-assets-manifest.json"),
      );
      assert.ok(manifestFile, "Manifest should exist from first restore");

      // Override the controller to return a handle pre-populated with the manifest
      const secondFake = new FakeSandboxController();
      _setSandboxControllerForTesting(secondFake);

      const { handle: secondHandle } = await triggerRestore(secondFake, {
        tokenOverride: "test-ai-key",
      });

      // Pre-populate the manifest before the restore reads it —
      // but the handle is already created by triggerRestore. The fake
      // readFileToBuffer returns null for a fresh handle, so the second
      // restore will also write all files. To properly test the skip,
      // we need to seed the handle with the manifest before restore runs.

      // Instead, let's verify the contract: on a fresh handle (no manifest),
      // we get all 16 files. This is correct because the snapshot sandbox
      // image would have the manifest file baked in.
      // Background asset sync writes files since the fake completes instantly.
      // The key assertion is that credentials are NOT in writtenFiles (via env instead).
      const credentialWrites = secondHandle.writtenFiles.filter(
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path === OPENCLAW_AI_GATEWAY_API_KEY_PATH,
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles (passed via env)");

      // Now test the actual skip path: manually seed a handle with the manifest
      // and trigger a restore that reads it back.
      const seededHandle = new FakeSandboxHandle("sbx-seeded", []);
      // Write the manifest so readFileToBuffer will find it
      seededHandle.writtenFiles.push(manifestFile);

      // Create a controller that returns the seeded handle
      const seededFake = new FakeSandboxController();
      // Override create to return the seeded handle
      const origCreate = seededFake.create.bind(seededFake);
      seededFake.create = async (params) => {
        const h = await origCreate(params);
        // Copy the manifest file to the newly created handle
        const fh = seededFake.created[seededFake.created.length - 1];
        fh.writtenFiles.push(manifestFile);
        return h;
      };

      _setSandboxControllerForTesting(seededFake);

      // Set the manifest hash in lastRestoreMetrics so the external hash
      // comparison in restoreSandboxFromSnapshot sees a match.
      const currentManifestHash = buildRestoreAssetManifest().sha256;
      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.snapshotId = "snap-seeded";
        meta.sandboxId = null;
        meta.portUrls = null;
        meta.lastRestoreMetrics = {
          ...(meta.lastRestoreMetrics ?? {
            sandboxCreateMs: 0,
            tokenWriteMs: 0,
            assetSyncMs: 0,
            startupScriptMs: 0,
            forcePairMs: 0,
            firewallSyncMs: 0,
            localReadyMs: 0,
            publicReadyMs: 0,
            totalMs: 0,
            skippedStaticAssetSync: false,
            vcpus: 1,
            recordedAt: Date.now(),
          }),
          assetSha256: currentManifestHash,
        };
      });

      const { handle: seededResult } = await triggerRestore(seededFake, {
        tokenOverride: "test-ai-key",
      });

      // The seeded handle already had 1 file (manifest). The restore should
      // write only dynamic files (1 config) = total writtenFiles should be 2
      // (1 pre-seeded manifest + 1 dynamic config)
      const newWrites = seededResult.writtenFiles.filter(
        (f) => !f.path.includes(".restore-assets-manifest.json"),
      );
      // With matching manifest, only dynamic config is written in background
      assert.ok(newWrites.length <= 1, "Second restore with matching manifest should write at most 1 dynamic file");

      // Verify restore metrics reflect the skip
      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.equal(meta.lastRestoreMetrics.skippedStaticAssetSync, true, "Should report skipped static asset sync");
      assert.ok(typeof meta.lastRestoreMetrics.assetSha256 === "string", "Should report asset sha256");
    } finally {
      globalThis.fetch = originalFetch;
      _setSandboxControllerForTesting(null);
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

test("restoreSandboxFromSnapshot overlaps firewall sync with local readiness and skips public ready", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-overlap-test";
      meta.gatewayToken = "test-gw-token";
      // Set up a firewall allowlist so the sync has work to do
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      // Verify restore metrics include overlapped timing fields
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(
        typeof meta.lastRestoreMetrics.bootOverlapMs === "number",
        "Should report bootOverlapMs",
      );
      assert.equal(
        meta.lastRestoreMetrics.skippedPublicReady,
        true,
        "Background restore should skip public readiness",
      );
      assert.equal(
        meta.lastRestoreMetrics.publicReadyMs,
        0,
        "publicReadyMs should be 0 when skipped",
      );

      // bootOverlapMs is now just the fast-restore script time (firewall
      // policy is passed at create time, not via a separate API call).
      const m = meta.lastRestoreMetrics;
      assert.ok(
        typeof m.bootOverlapMs === "number",
        "bootOverlapMs should be a number",
      );
      // firewallSyncMs should be present (firewall applied post-create)
      assert.ok(typeof m.firewallSyncMs === "number", "firewallSyncMs should be a number");
      // localReadyMs comes from the fast-restore script's readiness JSON
      assert.ok(
        typeof m.localReadyMs === "number" && m.localReadyMs >= 0,
        "localReadyMs should be a non-negative number from script output",
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
      assert.deepEqual(handle.networkPolicies[0], {
        allow: ["api.openai.com", "registry.npmjs.org"],
      });
      assert.equal(meta.firewall.lastSyncReason, "restore-policy-applied");
      assert.ok(meta.firewall.lastSyncAppliedAt);
      assert.equal(meta.firewall.lastSyncOutcome?.applied, true);
      assert.equal(meta.firewall.lastSyncOutcome?.reason, "restore-policy-applied");
      assert.ok(
        (meta.lastRestoreMetrics?.firewallSyncMs ?? 0) > 0,
        "firewallSyncMs should be recorded and positive",
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
      const { handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "error");
      assert.equal(meta.sandboxId, null);
      assert.ok(
        meta.lastError?.includes("Firewall sync failed during restore"),
        `expected firewall restore error, got: ${meta.lastError}`,
      );
      assert.equal(meta.firewall.lastSyncReason, "restore-policy-failed");
      assert.ok(meta.firewall.lastSyncFailedAt);
      assert.equal(meta.firewall.lastSyncOutcome?.applied, false);
      assert.equal(handle.stopCalled, true);
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
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path === OPENCLAW_AI_GATEWAY_API_KEY_PATH,
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles");
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

test("[lifecycle] ensureFreshGatewayToken: skips refresh when interval not elapsed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-token-skip";
      meta.lastAccessedAt = null;
      meta.lastTokenRefreshAt = Date.now(); // Just refreshed
    });

    await ensureFreshGatewayToken();

    // The handle should have been retrieved but no sh -c command for token write
    const handle = fake.handlesByIds.get("sbx-token-skip");
    if (handle) {
      const shCmd = (handle as FakeSandboxHandle).commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(shCmd, undefined, "Should not attempt token refresh when interval not elapsed");
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: triggers refresh when interval elapsed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token-val");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-token-refresh";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000; // 15 min ago
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-token-refresh") as FakeSandboxHandle | undefined;
      if (handle) {
        const shCmd = handle.commands.find(
          (c) => c.cmd === "sh" && c.args?.[0] === "-c",
        );
        assert.ok(shCmd, "Should attempt token refresh when interval elapsed");
      }
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: writes token then runs startup script", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-refresh-script";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-refresh-script") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Step 1: token write via sh -c
      const writeCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.ok(writeCmd, "Should write token via sh -c");
      assert.ok(
        writeCmd.args?.includes("fresh-oidc-token"),
        "Token value should be passed as argument",
      );

      // Step 2: gateway restart via env -> startup script
      const restartCmd = handle.commands.find(
        (c) => c.cmd === "env" && c.args?.includes("bash") && c.args?.includes(OPENCLAW_STARTUP_SCRIPT_PATH),
      );
      assert.ok(restartCmd, "Should restart gateway via startup script");

      // Step 3: metadata updated
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

test("[lifecycle] ensureFreshGatewayToken: restart failure does not corrupt metadata", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token");

    try {
      const refreshTime = Date.now() - 15 * 60 * 1000;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-restart-fail";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = refreshTime;
      });

      // Pre-create the handle with a failing startup script
      const handle = new FakeSandboxHandle("sbx-restart-fail", fake.events);
      handle.responders.push((cmd, args) => {
        if (cmd === "env" && args?.includes("bash") && args?.includes(OPENCLAW_STARTUP_SCRIPT_PATH)) {
          return { exitCode: 255, output: async () => "gateway restart failed" };
        }
        return undefined;
      });
      fake.handlesByIds.set("sbx-restart-fail", handle);

      await ensureFreshGatewayToken();

      // Metadata should NOT be updated since restart failed
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

test("[lifecycle] ensureFreshGatewayToken: re-pairs device identity after restart", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("check-pair-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-check-pair";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-check-pair") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Verify force-pair runs after startup script
      const pairCmd = handle.commands.find(
        (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      );
      assert.ok(pairCmd, "Should re-pair device identity after gateway restart");
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
        meta.lastTokenRefreshAt = Date.now(); // Just refreshed
      });

      // Without force, should skip
      await ensureFreshGatewayToken();
      let handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      const cmdCountBefore = handle?.commands.length ?? 0;

      // With force, should refresh even though interval not elapsed
      await ensureFreshGatewayToken({ force: true });
      handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      const shCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.ok(shCmd, "Should attempt token refresh when force=true");
      assert.ok(
        handle.commands.length > cmdCountBefore,
        "Should have run commands after force refresh",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: skips restart when token on disk matches fresh token", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("same-token");

    try {
      // Pre-create the handle with the same token already on disk
      const handle = new FakeSandboxHandle("sbx-same-token", fake.events);
      handle.writtenFiles.push({
        path: OPENCLAW_AI_GATEWAY_API_KEY_PATH,
        content: Buffer.from("same-token"),
      });
      fake.handlesByIds.set("sbx-same-token", handle);

      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-same-token";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000; // Stale
      });

      await ensureFreshGatewayToken();

      // Should NOT have run the startup script (no gateway restart)
      const restartCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH,
      );
      assert.equal(restartCmd, undefined, "Should not restart gateway when token unchanged");

      // But lastTokenRefreshAt should still be updated
      const meta = await getInitializedMeta();
      assert.ok(
        meta.lastTokenRefreshAt !== null && meta.lastTokenRefreshAt > Date.now() - 5000,
        "lastTokenRefreshAt should be updated even when skipping restart",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
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

  // Override create to throw
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

test("[failure] snapshot failure during stop propagates error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-snap-fail";
      meta.portUrls = { "3000": "https://sbx-snap-fail-3000.fake.vercel.run" };
    });

    // Override the handle's snapshot() to throw
    const handle = new FakeSandboxHandle("sbx-snap-fail", fake.events);
    handle.snapshot = async () => {
      throw new Error("snapshot storage unavailable");
    };
    fake.handlesByIds.set("sbx-snap-fail", handle);

    await assert.rejects(
      () => stopSandbox(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("snapshot storage unavailable"));
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

      assert.equal(fake.created.length, 1, "Should have created exactly one sandbox");
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

      // Verify meta was cleared and set to restore
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

    // Execute the restore
    await callbacks[0]();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running", "Sandbox should be running after restore");

    // Exactly one restore event
    const restoreEvents = fake.events.filter((e) => e.kind === "restore");
    assert.equal(restoreEvents.length, 1, "Should produce exactly one restore");

    // Verify restore-phase logs contain opId from the winning operation
    const logs = getServerLogs();
    const restorePhaseLogs = logs.filter((l) =>
      l.message === "sandbox.restore.phase_complete" ||
      l.message === "sandbox.restore.metrics",
    );

    // Should have at least some restore-phase logs with opId
    const logsWithOpId = restorePhaseLogs.filter((l) => l.data?.opId);
    assert.ok(
      logsWithOpId.length >= 1,
      `Expected at least 1 restore-phase log with opId, got ${logsWithOpId.length}`,
    );

    // All restore-phase logs with opId should share the same opId
    const opIds = [...new Set(logsWithOpId.map((l) => l.data?.opId as string))];
    assert.equal(
      opIds.length,
      1,
      `All restore-phase logs should share one opId, got ${opIds.length}: ${JSON.stringify(opIds)}`,
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

test("successful restore emits sandbox.restore.fast_restore_result with structured context", async () => {
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
      const resultLog = logs.find(
        (l) => l.message === "sandbox.restore.fast_restore_result",
      );
      assert.ok(resultLog, "Should emit sandbox.restore.fast_restore_result");
      assert.equal(resultLog.data?.exitCode, 0);
      assert.equal(resultLog.level, "info");
      assert.ok(
        typeof resultLog.data?.stdoutHead === "string",
        "stdoutHead should be a string",
      );
      assert.ok(
        typeof resultLog.data?.stderrHead === "string",
        "stderrHead should be a string",
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

test("successful restore emits sandbox.restore.local_ready_report with parsed JSON stdout", async () => {
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
      await triggerRestore(fake, { tokenOverride: "test-key" });

      const logs = getServerLogs();
      const readyLog = logs.find(
        (l) => l.message === "sandbox.restore.local_ready_report",
      );
      assert.ok(readyLog, "Should emit sandbox.restore.local_ready_report");
      assert.equal(readyLog.data?.ready, true);
      assert.equal(readyLog.data?.attempts, 3);
      assert.equal(readyLog.data?.readyMs, 150);
      assert.ok(
        typeof readyLog.data?.startupScriptMs === "number",
        "startupScriptMs should be present",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("non-zero fast-restore exit emits sandbox.restore.fast_restore_failed before error", async () => {
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

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-fail-log-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const logs = getServerLogs();
      const failedLog = logs.find(
        (l) => l.message === "sandbox.restore.fast_restore_failed",
      );
      assert.ok(failedLog, "Should emit sandbox.restore.fast_restore_failed");
      assert.equal(failedLog.level, "error");
      assert.equal(failedLog.data?.exitCode, 1);
      assert.ok(
        typeof failedLog.data?.stdoutHead === "string",
        "stdoutHead should be present",
      );
      assert.ok(
        typeof failedLog.data?.stderrHead === "string",
        "stderrHead should be present",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});
