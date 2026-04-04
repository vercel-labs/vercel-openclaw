/**
 * Route-level tests for admin lifecycle control routes and the status endpoint.
 *
 * Covers:
 * - POST /api/admin/ensure  (ensureSandboxRunning)
 * - POST /api/admin/stop    (stop + idempotent stop)
 * - POST /api/admin/snapshot (snapshot-and-stop)
 * - GET  /api/admin/snapshots (list snapshots)
 * - POST /api/admin/snapshots/restore (restore from snapshot)
 * - GET  /api/status        (metadata incl. sandbox status & firewall mode)
 * - POST /api/status        (heartbeat / touchRunningSandbox)
 *
 * Uses the scenario harness (memory store, fake sandbox controller).
 * Run: npm test src/app/api/admin/admin-lifecycle.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { buildRestoreAssetManifest, OPENCLAW_RESTORE_ASSET_MANIFEST_PATH } from "@/server/openclaw/restore-assets";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildGetRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
  pendingAfterCount,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Lazy-load route modules (after patching)
// ---------------------------------------------------------------------------

type RouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
};

function loadRoute(path: string): RouteModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as RouteModule;
}

const ensureRoute = loadRoute("@/app/api/admin/ensure/route");
const stopRoute = loadRoute("@/app/api/admin/stop/route");
const snapshotRoute = loadRoute("@/app/api/admin/snapshot/route");
const snapshotsRoute = loadRoute("@/app/api/admin/snapshots/route");
const restoreRoute = loadRoute("@/app/api/admin/snapshots/restore/route");
const statusRoute = loadRoute("@/app/api/status/route");
const prepareRestoreRoute = loadRoute("@/app/api/admin/prepare-restore/route");
const restoreTargetRoute = loadRoute("@/app/api/admin/restore-target/route");

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    resetAfterCallbacks();
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Request builders with CSRF headers
// ---------------------------------------------------------------------------

function authPost(path: string, body = "{}"): Request {
  return buildPostRequest(path, body, {
    authorization: "Bearer test-admin-secret-for-scenarios",
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
  });
}

function authGet(path: string): Request {
  return buildGetRequest(path, {
    authorization: "Bearer test-admin-secret-for-scenarios",
    origin: "http://localhost:3000",
    host: "localhost:3000",
    "x-requested-with": "XMLHttpRequest",
  });
}

// ---------------------------------------------------------------------------
// Fake sandbox controller
// ---------------------------------------------------------------------------

function installFakeController(): {
  snapshotCalls: number;
  appliedPolicies: NetworkPolicy[];
  restore(): void;
} {
  let snapshotCalls = 0;
  const appliedPolicies: NetworkPolicy[] = [];

  const fake: SandboxController = {
    async create() {
      return makeFakeHandle("sbx-test-create", () => snapshotCalls++, appliedPolicies);
    },
    async get(opts: { sandboxId: string }) {
      return makeFakeHandle(opts.sandboxId, () => snapshotCalls++, appliedPolicies);
    },
  };

  _setSandboxControllerForTesting(fake);

  return {
    get snapshotCalls() { return snapshotCalls; },
    appliedPolicies,
    restore() { _setSandboxControllerForTesting(null); },
  };
}

function makeFakeHandle(
  sandboxId: string,
  onSnapshot: () => void,
  policies: NetworkPolicy[],
): SandboxHandle {
  let snapCount = 0;
  const restoreAssetManifest = Buffer.from(
    `${JSON.stringify(buildRestoreAssetManifest())}\n`,
  );
  return {
    sandboxId,
    get timeout() { return 1800000; },
    get status() { return "running" as const; },
    async runCommand() {
      return { exitCode: 0, output: async () => "" };
    },
    async writeFiles() {},
    domain() {
      return `https://${sandboxId}-3000.fake.vercel.run`;
    },
    async snapshot() {
      onSnapshot();
      snapCount++;
      return { snapshotId: `snap-${sandboxId}-${snapCount}` };
    },
    async extendTimeout() {},
    async updateNetworkPolicy(policy: NetworkPolicy) {
      policies.push(policy);
      return policy;
    },
    async readFileToBuffer(file) {
      if (file.path === OPENCLAW_RESTORE_ASSET_MANIFEST_PATH) {
        return restoreAssetManifest;
      }
      return null;
    },
    async stop() {},
    async runDetachedCommand() { return { cmdId: "fake-cmd" }; },
    async getCommand() { return { async kill() {} }; },
  } satisfies SandboxHandle;
}

// ===========================================================================
// POST /api/admin/ensure
// ===========================================================================

test("POST /api/admin/ensure: returns running state when sandbox already running", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-already-up";
    });

    const result = await callRoute(ensureRoute.POST!, authPost("/api/admin/ensure"));

    assert.equal(result.status, 200);
    const body = result.json as { state: string; status: string; sandboxId: string };
    assert.equal(body.state, "running");
    assert.equal(body.status, "running");
    assert.equal(body.sandboxId, "sbx-already-up");
  });
});

test("POST /api/admin/ensure: schedules create for uninitialized sandbox and returns 202", async () => {
  await withTestEnv(async () => {
    installFakeController();
    // Default meta is uninitialized

    const result = await callRoute(ensureRoute.POST!, authPost("/api/admin/ensure"));

    assert.equal(result.status, 202);
    const body = result.json as { state: string; status: string };
    assert.equal(body.state, "waiting");
    // After scheduling, status should be "creating"
    assert.equal(body.status, "creating");
    // Should have scheduled an after() callback
    assert.ok(pendingAfterCount() > 0, "Should schedule background work via after()");
  });
});

test("POST /api/admin/ensure: schedules create when stopped with snapshot (v2 persistent)", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-restore-target";
      m.sandboxId = null;
    });

    const result = await callRoute(ensureRoute.POST!, authPost("/api/admin/ensure"));

    assert.equal(result.status, 202);
    const body = result.json as { state: string; status: string };
    assert.equal(body.state, "waiting");
    // v2 persistent sandboxes always use "creating" — SDK auto-resumes
    assert.equal(body.status, "creating");
  });
});

test("POST /api/admin/ensure: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest("/api/admin/ensure", "{}", {});
    const result = await callRoute(ensureRoute.POST!, request);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// POST /api/admin/stop
// ===========================================================================

test("POST /api/admin/stop: stops running sandbox and returns status", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-to-stop";
      m.portUrls = { "3000": "https://sbx-to-stop-3000.fake.vercel.run" };
    });

    const result = await callRoute(stopRoute.POST!, authPost("/api/admin/stop"));

    assert.equal(result.status, 200);
    const body = result.json as { status: string; snapshotId: string | null };
    assert.equal(body.status, "stopped");
    // v2 persistent sandboxes auto-snapshot on stop — no manual snapshot() call
    // snapshotId may be null since metadata no longer tracks it from snapshot()

    // sandboxId should be preserved (persistent sandbox identity persists)
    const meta = await getInitializedMeta();
    assert.equal(meta.sandboxId, "sbx-to-stop", "sandboxId should be preserved after stop");
    assert.equal(meta.status, "stopped");
  });
});

test("POST /api/admin/stop: idempotent on already-stopped sandbox with snapshot", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.sandboxId = null;
      m.snapshotId = "snap-already-stopped";
    });

    const result = await callRoute(stopRoute.POST!, authPost("/api/admin/stop"));

    assert.equal(result.status, 200);
    const body = result.json as { status: string; snapshotId: string };
    assert.equal(body.status, "stopped");
    assert.equal(body.snapshotId, "snap-already-stopped");
  });
});

test("POST /api/admin/stop: returns 409 when no sandbox exists (uninitialized)", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      // v2: stopSandbox() returns idempotently when status=stopped.
      // To hit the 409, status must not be "stopped" AND sandboxId must be null.
      m.status = "uninitialized";
      m.sandboxId = null;
      m.snapshotId = null;
    });

    const result = await callRoute(stopRoute.POST!, authPost("/api/admin/stop"));

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "SANDBOX_NOT_RUNNING");
  });
});

test("POST /api/admin/stop: idempotent when already stopped with no snapshot", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.sandboxId = null;
      m.snapshotId = null;
    });

    // v2: stopSandbox() returns current state when status=stopped
    const result = await callRoute(stopRoute.POST!, authPost("/api/admin/stop"));
    assert.equal(result.status, 200);
    const body = result.json as { status: string };
    assert.equal(body.status, "stopped");
  });
});

test("POST /api/admin/stop: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest("/api/admin/stop", "{}", {});
    const result = await callRoute(stopRoute.POST!, request);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// POST /api/admin/snapshot
// ===========================================================================

test("POST /api/admin/snapshot: triggers stop flow (v2 auto-snapshots on stop)", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-snap-me";
      m.portUrls = { "3000": "https://sbx-snap-me-3000.fake.vercel.run" };
    });

    const result = await callRoute(snapshotRoute.POST!, authPost("/api/admin/snapshot"));

    assert.equal(result.status, 200);
    const body = result.json as { status: string; snapshotId: string | null };
    assert.equal(body.status, "stopped");
    // v2: snapshot() is not called manually — SDK auto-snapshots on stop

    // Verify metadata was updated
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "stopped");
    // v2: sandboxId is preserved (persistent sandbox identity persists)
    assert.equal(meta.sandboxId, "sbx-snap-me");
  });
});

// ===========================================================================
// GET /api/admin/snapshots
// ===========================================================================

test("GET /api/admin/snapshots: lists available snapshots", async () => {
  await withTestEnv(async () => {
    await mutateMeta((m) => {
      m.snapshotHistory = [
        { id: "r1", snapshotId: "snap-a", timestamp: 1000, reason: "manual" },
        { id: "r2", snapshotId: "snap-b", timestamp: 2000, reason: "stop" },
      ];
    });

    const result = await callRoute(snapshotsRoute.GET!, authGet("/api/admin/snapshots"));

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: Array<{ snapshotId: string }> };
    assert.equal(body.snapshots.length, 2);
    assert.equal(body.snapshots[0].snapshotId, "snap-a");
    assert.equal(body.snapshots[1].snapshotId, "snap-b");
  });
});

test("GET /api/admin/snapshots: returns empty array when no history", async () => {
  await withTestEnv(async () => {
    const result = await callRoute(snapshotsRoute.GET!, authGet("/api/admin/snapshots"));

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: unknown[] };
    assert.deepEqual(body.snapshots, []);
  });
});

// ===========================================================================
// POST /api/admin/snapshots/restore
// ===========================================================================

test("POST /api/admin/snapshots/restore: restores from valid snapshotId", async () => {
  // Suppress unhandled rejections from the fire-and-forget lifecycle work
  // that continues after the route returns (void run() in scheduleLifecycleWork).
  // The detached restore may call getInitializedMeta() after the test resets the store.
  const suppressedErrors: unknown[] = [];
  const handler = (err: unknown) => { suppressedErrors.push(err); };
  process.on("unhandledRejection", handler);

  try {
    await withTestEnv(async () => {
      installFakeController();
      await mutateMeta((m) => {
        m.status = "stopped";
        m.snapshotId = "snap-to-restore";
        m.sandboxId = null;
      });

      const result = await callRoute(
        restoreRoute.POST!,
        authPost(
          "/api/admin/snapshots/restore",
          JSON.stringify({ snapshotId: "snap-to-restore" }),
        ),
      );

      resetAfterCallbacks();

      assert.ok(
        result.status === 200 || result.status === 202,
        `Expected 200 or 202, got ${result.status}`,
      );
      const body = result.json as { snapshotId: string; state: string };
      assert.equal(body.snapshotId, "snap-to-restore");
    });
  } finally {
    // Give the detached lifecycle work time to settle before removing the handler
    await new Promise((r) => setTimeout(r, 250));
    process.removeListener("unhandledRejection", handler);
  }
});

test("POST /api/admin/snapshots/restore: returns 404 for unknown snapshotId", async () => {
  await withTestEnv(async () => {
    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-current";
      m.snapshotHistory = [];
    });

    const result = await callRoute(
      restoreRoute.POST!,
      authPost(
        "/api/admin/snapshots/restore",
        JSON.stringify({ snapshotId: "snap-nonexistent" }),
      ),
    );

    assert.equal(result.status, 404);
    const body = result.json as { error: string };
    assert.equal(body.error, "SNAPSHOT_NOT_FOUND");
  });
});

test("POST /api/admin/snapshots/restore: returns 400 for missing snapshotId", async () => {
  await withTestEnv(async () => {
    const result = await callRoute(
      restoreRoute.POST!,
      authPost("/api/admin/snapshots/restore", JSON.stringify({})),
    );

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_SNAPSHOT_ID");
  });
});

// ===========================================================================
// GET /api/status
// ===========================================================================

test("GET /api/status: returns metadata including sandbox status and firewall mode", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-status-check";
      m.portUrls = { "3000": "https://sbx-status-check-3000.fake.vercel.run" };
      m.gatewayToken = "test-gw-token";
      m.snapshotId = "snap-latest";
      m.firewall.mode = "learning";
      m.firewall.allowlist = ["api.openai.com"];
    });

    // Mock fetch for probeGatewayReady (called by status route when health=1)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const result = await callRoute(statusRoute.GET!, authGet("/api/status"));

      assert.equal(result.status, 200);
      const body = result.json as {
        status: string;
        sandboxId: string;
        snapshotId: string;
        firewall: { mode: string; allowlist: string[] };
        storeBackend: string;
        authMode: string;
        user: { sub: string };
      };
      assert.equal(body.status, "running");
      assert.equal(body.sandboxId, "sbx-status-check");
      assert.equal(body.snapshotId, "snap-latest");
      assert.equal(body.firewall.mode, "learning");
      assert.deepEqual(body.firewall.allowlist, ["api.openai.com"]);
      assert.equal(body.storeBackend, "memory");
      assert.equal(body.authMode, "admin-secret");
      assert.ok(body.user, "Should include user info");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("GET /api/status: returns status for stopped sandbox", async () => {
  await withTestEnv(async () => {
    await mutateMeta((m) => {
      m.status = "stopped";
      m.sandboxId = null;
      m.snapshotId = "snap-stopped";
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("no sandbox to probe");
    };

    try {
      const result = await callRoute(statusRoute.GET!, authGet("/api/status"));

      assert.equal(result.status, 200);
      const body = result.json as { status: string; sandboxId: null; gatewayReady: boolean };
      assert.equal(body.status, "stopped");
      assert.equal(body.sandboxId, null);
      assert.equal(body.gatewayReady, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// POST /api/status (heartbeat)
// ===========================================================================

test("POST /api/status: heartbeat extends sandbox timeout on running sandbox", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-heartbeat";
      m.lastAccessedAt = null;
    });

    const result = await callRoute(statusRoute.POST!, authPost("/api/status"));

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");

    // Verify lastAccessedAt was updated
    const meta = await getInitializedMeta();
    assert.ok(meta.lastAccessedAt, "lastAccessedAt should be set after heartbeat");
  });
});

test("POST /api/status: heartbeat is a no-op when sandbox not running", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.sandboxId = null;
    });

    const result = await callRoute(statusRoute.POST!, authPost("/api/status"));

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "stopped");
  });
});

test("POST /api/status: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest("/api/status", "{}", {});
    const result = await callRoute(statusRoute.POST!, request);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// GET /api/admin/prepare-restore
// ===========================================================================

test("GET /api/admin/prepare-restore: returns RestoreTargetInspectionPayload with attestation and plan", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-inspect";
      m.sandboxId = null;
      m.restorePreparedStatus = "dirty";
      m.restorePreparedReason = "dynamic-config-changed";
    });

    const result = await callRoute(prepareRestoreRoute.GET!, authGet("/api/admin/prepare-restore"));

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      generatedAt: string;
      attestation: { reusable: boolean; needsPrepare: boolean; reasons: string[] };
      preview: { ok: boolean; destructive: boolean; state: string };
      plan: { schemaVersion: number; status: string; blocking: boolean; actions: Array<{ id: string }> };
      decision: { reusable: boolean; reasons: string[]; requiredActions: string[]; nextAction: string | null };
    };

    // Payload has full inspection shape
    assert.equal(typeof body.generatedAt, "string");
    assert.ok(body.attestation, "Should include attestation");
    assert.ok(body.preview, "Should include preview");
    assert.ok(body.plan, "Should include plan");
    assert.ok(body.decision, "Should include decision");

    // Dirty target is not reusable
    assert.equal(body.ok, false);
    assert.equal(body.attestation.reusable, false);
    assert.equal(body.attestation.needsPrepare, true);

    // Plan includes prepare-destructive action
    assert.equal(body.plan.status, "needs-prepare");
    assert.equal(body.plan.blocking, true);
    assert.ok(
      body.plan.actions.some((a) => a.id === "prepare-destructive"),
      "Plan should include prepare-destructive action",
    );

    // Decision invariants
    assert.equal(body.ok, body.attestation.reusable);
    assert.equal(body.preview.ok, body.attestation.reusable);
    assert.equal(body.decision.reusable, body.attestation.reusable);
  });
});

test("GET /api/admin/prepare-restore: returns ok=true when restore target is reusable", async () => {
  await withTestEnv(async () => {
    installFakeController();

    // Build current desired hashes
    const { computeGatewayConfigHash } = await import("@/server/openclaw/config");
    const { buildRestoreAssetManifest } = await import("@/server/openclaw/restore-assets");
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-ready";
      m.sandboxId = null;
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
      m.restorePreparedAt = Date.now();
      m.snapshotDynamicConfigHash = desiredConfigHash;
      m.runtimeDynamicConfigHash = desiredConfigHash;
      m.snapshotAssetSha256 = desiredAssetSha256;
      m.runtimeAssetSha256 = desiredAssetSha256;
    });

    const result = await callRoute(prepareRestoreRoute.GET!, authGet("/api/admin/prepare-restore"));

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      attestation: { reusable: boolean; reasons: string[] };
      plan: { status: string; actions: unknown[] };
    };

    assert.equal(body.ok, true);
    assert.equal(body.attestation.reusable, true);
    assert.equal(body.plan.status, "ready");
    assert.equal(body.plan.actions.length, 0);
  });
});

test("GET /api/admin/prepare-restore: missing snapshotId cannot report reusable even when snapshot hashes match", async () => {
  await withTestEnv(async () => {
    installFakeController();

    const { computeGatewayConfigHash } = await import("@/server/openclaw/config");
    const { buildRestoreAssetManifest } = await import("@/server/openclaw/restore-assets");
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = null;
      m.snapshotDynamicConfigHash = desiredConfigHash;
      m.runtimeDynamicConfigHash = desiredConfigHash;
      m.snapshotAssetSha256 = desiredAssetSha256;
      m.runtimeAssetSha256 = desiredAssetSha256;
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
      m.restorePreparedAt = Date.now();
    });

    const result = await callRoute(
      prepareRestoreRoute.GET!,
      authGet("/api/admin/prepare-restore"),
    );

    assert.equal(result.status, 200);

    const body = result.json as {
      ok: boolean;
      attestation: {
        reusable: boolean;
        needsPrepare: boolean;
        reasons: string[];
      };
      plan: {
        status: string;
        blocking: boolean;
        actions: Array<{ id: string }>;
      };
      decision: {
        schemaVersion: number;
        source: string;
        destructive: boolean;
        reusable: boolean;
        needsPrepare: boolean;
        blocking: boolean;
        reasons: string[];
        requiredActions: string[];
        nextAction: string | null;
      };
    };

    assert.equal(body.ok, false);
    assert.equal(body.attestation.reusable, false);
    assert.equal(body.attestation.needsPrepare, true);
    assert.ok(body.attestation.reasons.includes("snapshot-missing"));
    assert.equal(body.plan.status, "needs-prepare");
    assert.equal(body.plan.blocking, true);
    assert.ok(
      body.plan.actions.some((action) => action.id === "prepare-destructive"),
      "Plan should require prepare-destructive when snapshotId is missing",
    );

    // Decision kernel invariants
    assert.equal(body.ok, body.attestation.reusable);
    assert.equal(body.decision.reusable, body.attestation.reusable);
    assert.ok(body.decision.reasons.includes("snapshot-missing"));
    assert.deepEqual(body.decision.requiredActions, [
      "ensure-running",
      "prepare-destructive",
    ]);
    assert.equal(body.decision.nextAction, "ensure-running");
  });
});

test("GET /api/admin/prepare-restore: inspect mode is read-only", async () => {
  await withTestEnv(async () => {
    installFakeController();

    const { computeGatewayConfigHash } = await import("@/server/openclaw/config");
    const { buildRestoreAssetManifest } = await import("@/server/openclaw/restore-assets");
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-stable";
      m.snapshotDynamicConfigHash = desiredConfigHash;
      m.runtimeDynamicConfigHash = desiredConfigHash;
      m.snapshotAssetSha256 = desiredAssetSha256;
      m.runtimeAssetSha256 = desiredAssetSha256;
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
      m.restorePreparedAt = 123456;
    });

    const before = await getInitializedMeta();

    const result = await callRoute(
      prepareRestoreRoute.GET!,
      authGet("/api/admin/prepare-restore"),
    );

    assert.equal(result.status, 200);

    // Verify decision is present on read-only response
    const body = result.json as {
      ok: boolean;
      attestation: { reusable: boolean };
      decision: { reusable: boolean; source: string };
    };
    assert.ok(body.decision, "Read-only inspect must include decision");
    assert.equal(body.decision.reusable, body.attestation.reusable);

    // State must not mutate
    const after = await getInitializedMeta();
    assert.equal(after.version, before.version);
    assert.equal(after.status, before.status);
    assert.equal(after.snapshotId, before.snapshotId);
    assert.equal(after.snapshotDynamicConfigHash, before.snapshotDynamicConfigHash);
    assert.equal(after.snapshotAssetSha256, before.snapshotAssetSha256);
    assert.equal(after.restorePreparedStatus, before.restorePreparedStatus);
    assert.equal(after.restorePreparedReason, before.restorePreparedReason);
    assert.equal(after.restorePreparedAt, before.restorePreparedAt);
  });
});

// ===========================================================================
// /api/admin/restore-target delegates to /api/admin/prepare-restore
// ===========================================================================

test("GET /api/admin/restore-target: returns same shape as prepare-restore (delegation)", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-delegate";
      m.sandboxId = null;
      m.restorePreparedStatus = "dirty";
      m.restorePreparedReason = "static-assets-changed";
    });

    const result = await callRoute(restoreTargetRoute.GET!, authGet("/api/admin/restore-target"));

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      attestation: { reusable: boolean };
      preview: { ok: boolean };
      plan: { status: string };
    };

    assert.equal(typeof body.ok, "boolean");
    assert.ok(body.attestation, "Should include attestation");
    assert.ok(body.preview, "Should include preview");
    assert.ok(body.plan, "Should include plan");
  });
});
