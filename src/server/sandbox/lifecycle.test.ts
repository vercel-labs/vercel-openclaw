import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";
import type { SingleMeta } from "@/shared/types";

import {
  ensureSandboxRunning,
  ensureSandboxReady,
  probeGatewayReady,
  reconcileSandboxHealth,
  stopSandbox,
  snapshotSandbox,
  getSandboxDomain,
  touchRunningSandbox,
  markSandboxUnavailable,
} from "@/server/sandbox/lifecycle";
import {
  _setSandboxControllerForTesting,
  type CommandResult,
  type CreateParams,
  type SandboxController,
  type SandboxHandle,
  type SnapshotResult,
} from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import {
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
} from "@/server/openclaw/config";

// ---------------------------------------------------------------------------
// FakeSandboxController
// ---------------------------------------------------------------------------

type FakeOptions = {
  /** Delay in ms for create/get/snapshot (default 0) */
  delay?: number;
  /** What probeGatewayReady's fetch will see. Null = throw. */
  gatewayHtml?: string | null;
};

type CommandHandler = (
  cmd: string,
  args?: string[],
) => { exitCode: number; output: string };

class FakeSandboxHandle implements SandboxHandle {
  sandboxId: string;
  commands: Array<{ cmd: string; args?: string[] }> = [];
  writtenFiles: Array<{ path: string; content: Buffer }> = [];
  networkPolicies: NetworkPolicy[] = [];
  extendedTimeouts: number[] = [];
  snapshotCalled = false;
  commandHandler: CommandHandler | null = null;

  constructor(sandboxId: string) {
    this.sandboxId = sandboxId;
  }

  async runCommand(
    command: string,
    args?: string[],
  ): Promise<CommandResult> {
    this.commands.push({ cmd: command, args });
    if (this.commandHandler) {
      const result = this.commandHandler(command, args);
      return { exitCode: result.exitCode, output: async () => result.output };
    }
    if (command === OPENCLAW_BIN && args?.[0] === "--version") {
      return { exitCode: 0, output: async () => "openclaw 1.2.3" };
    }
    return { exitCode: 0, output: async () => "" };
  }

  async writeFiles(files: { path: string; content: Buffer }[]): Promise<void> {
    this.writtenFiles.push(...files);
  }

  domain(port: number): string {
    return `https://${this.sandboxId}-${port}.fake.vercel.run`;
  }

  async snapshot(): Promise<SnapshotResult> {
    this.snapshotCalled = true;
    return { snapshotId: `snap-${this.sandboxId}` };
  }

  async extendTimeout(duration: number): Promise<void> {
    this.extendedTimeouts.push(duration);
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy> {
    this.networkPolicies.push(policy);
    return policy;
  }
}

class FakeSandboxController implements SandboxController {
  created: FakeSandboxHandle[] = [];
  retrieved: string[] = [];
  handlesByIds = new Map<string, FakeSandboxHandle>();
  private counter = 0;
  private delay: number;
  commandHandler: CommandHandler | null = null;

  constructor(options?: FakeOptions) {
    this.delay = options?.delay ?? 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async create(params: CreateParams): Promise<SandboxHandle> {
    if (this.delay > 0) {
      await sleep(this.delay);
    }
    this.counter += 1;
    const id = `sbx-fake-${this.counter}`;
    const handle = new FakeSandboxHandle(id);
    if (this.commandHandler) {
      handle.commandHandler = this.commandHandler;
    }
    this.created.push(handle);
    this.handlesByIds.set(id, handle);
    return handle;
  }

  async get(params: { sandboxId: string }): Promise<SandboxHandle> {
    this.retrieved.push(params.sandboxId);
    const existing = this.handlesByIds.get(params.sandboxId);
    if (existing) {
      return existing;
    }
    // Return a fresh handle for the ID (e.g. for sandbox IDs set in meta)
    const handle = new FakeSandboxHandle(params.sandboxId);
    this.handlesByIds.set(params.sandboxId, handle);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENV_OVERRIDES: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
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

  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
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

test("restoreSandboxFromSnapshot writes config, force-pair, image-gen-skill, image-gen-script, builtin-image-gen-skill, builtin-image-gen-script (6 files via writeFiles)", async () => {
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
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SKILL_PATH), "Should write image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SCRIPT_PATH), "Should write image-gen script");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH), "Should write builtin image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH), "Should write builtin image-gen script");
      assert.equal(handle.writtenFiles.length, 6, "Should write exactly 6 files");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot runs sh -c to write AI gateway key when token available", async () => {
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

      // Should have an "sh" command with "-c" for writing the AI gateway token
      const shCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.ok(shCmd, "Should run sh -c to write AI gateway token");
      // The token value is passed as the last arg after "--"
      assert.ok(shCmd.args?.includes("my-gateway-key"), "Should pass the token value");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot skips AI gateway key write when no token available", async () => {
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

      // Should NOT have an "sh" command for writing the AI gateway token
      const shCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(shCmd, undefined, "Should not run sh -c when no token available");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot runs bash startup-script and checks exit code", async () => {
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

      // Should have a "bash" command with the startup script path
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run bash with startup script path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot with startup script exit code != 0 throws error", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make the startup script command fail
  fake.commandHandler = (cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH) {
      return { exitCode: 1, output: "startup script failed: missing config" };
    }
    return { exitCode: 0, output: "" };
  };

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
      assert.equal(meta.status, "error", "Status should be error after startup script failure");
      assert.ok(meta.lastError?.includes("restore-startup-script"), "lastError should mention startup script failure");
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

  // Make curl readiness probe succeed (used by setupOpenClaw's waitForGatewayReady)
  fake.commandHandler = (cmd) => {
    if (cmd === "curl") {
      return { exitCode: 0, output: '<div id="openclaw-app"></div>' };
    }
    return { exitCode: 0, output: "" };
  };

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

test("ensureSandboxRunning create path stores bootstrap snapshot and openclaw version", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.commandHandler = (cmd, args) => {
    if (cmd === OPENCLAW_BIN && args?.[0] === "--version") {
      return { exitCode: 0, output: "openclaw 9.9.9" };
    }
    if (cmd === "curl") {
      return { exitCode: 0, output: '<div id="openclaw-app"></div>' };
    }
    return { exitCode: 0, output: "" };
  };

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
      assert.ok(meta.snapshotId?.startsWith("snap-"), "bootstrap should persist a recovery snapshot");
      assert.equal(meta.openclawVersion, "openclaw 9.9.9");
      assert.equal(meta.snapshotHistory[0]?.reason, "bootstrap-auto");
      assert.equal(meta.snapshotHistory[0]?.snapshotId, meta.snapshotId);
      assert.equal(handle.snapshotCalled, true, "sandbox snapshot API should be called after bootstrap");
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

  // Make curl return the openclaw-app marker so waitForGatewayReady succeeds quickly
  fake.commandHandler = (cmd) => {
    if (cmd === "curl") {
      return { exitCode: 0, output: '<div id="openclaw-app"></div>' };
    }
    return { exitCode: 0, output: "" };
  };

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

test("[lifecycle] touchRunningSandbox extend timeout throws -> logs warning but still updates lastAccessedAt", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-extend-error";
      meta.lastAccessedAt = null;
    });

    // Make the extendTimeout throw
    const handle = new FakeSandboxHandle("sbx-extend-error");
    handle.extendTimeout = async () => {
      throw new Error("some network error");
    };
    fake.handlesByIds.set("sbx-extend-error", handle);

    const result = await touchRunningSandbox();
    // Should still succeed and update lastAccessedAt
    assert.equal(result.status, "running");
    assert.ok(result.lastAccessedAt, "lastAccessedAt should be updated despite extend error");
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

    const handle = new FakeSandboxHandle("sbx-timeout-invalid");
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

test("[lifecycle] touchRunningSandbox token refresh interval not elapsed -> skips refresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-token-skip";
      meta.lastAccessedAt = null;
      meta.lastTokenRefreshAt = Date.now(); // Just refreshed
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");

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

test("[lifecycle] touchRunningSandbox token refresh interval elapsed -> triggers refresh", async () => {
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

      await touchRunningSandbox();

      // Give the fire-and-forget refresh a moment to execute
      await sleep(50);

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
  fake.commandHandler = (cmd) => {
    if (cmd === "npm") {
      throw new Error("npm install crashed");
    }
    return { exitCode: 0, output: "" };
  };

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
    const handle = new FakeSandboxHandle("sbx-snap-fail");
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

test("[failure] restore failure from stopped state (startup script fails)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make bash startup-script command return non-zero exit code
  fake.commandHandler = (cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH) {
      return { exitCode: 1, output: "startup script failed" };
    }
    return { exitCode: 0, output: "" };
  };

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
      assert.equal(meta.status, "error", "Status should be error after startup script failure");
      assert.ok(meta.lastError?.includes("restore-startup-script"), "lastError should mention startup failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] restore failure when token write command fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make the token-write sh command return non-zero exit code
  fake.commandHandler = (cmd, args) => {
    if (cmd === "sh" && args?.includes("-c")) {
      return { exitCode: 1, output: "permission denied: /root/.openclaw" };
    }
    return { exitCode: 0, output: "" };
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
      assert.equal(meta.status, "error", "Status should be error after token write failure");
      assert.ok(meta.lastError?.includes("write-ai-gateway-token"), "lastError should mention token write failure");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] concurrent ensureSandboxRunning from error status creates only one sandbox", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make curl readiness probe succeed
  fake.commandHandler = (cmd) => {
    if (cmd === "curl") {
      return { exitCode: 0, output: '<div id="openclaw-app"></div>' };
    }
    return { exitCode: 0, output: "" };
  };

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
