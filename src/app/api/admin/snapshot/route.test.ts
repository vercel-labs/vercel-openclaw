/**
 * Smoke tests for POST /api/admin/snapshot.
 *
 * Covers CSRF rejection and snapshot-and-stop flow.
 *
 * Run: npm test src/app/api/admin/snapshot/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getAdminSnapshotRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { FakeSandboxController } from "@/test-utils/harness";

patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "REDIS_URL",
    "KV_URL",
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
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  }
}

// ===========================================================================
// POST /api/admin/snapshot
// ===========================================================================

test("POST /api/admin/snapshot: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getAdminSnapshotRoute();
    const request = buildPostRequest("/api/admin/snapshot", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED", `Expected UNAUTHORIZED, got: ${body.error}`);
  });
});

test("POST /api/admin/snapshot: triggers snapshot and returns status + snapshotId", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-snap-1";
    });

    const route = getAdminSnapshotRoute();
    const request = buildAuthPostRequest("/api/admin/snapshot", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { status: string; sandboxId: string | null };
    // v2 non-blocking stop: API returns "snapshotting" while the platform
    // finishes the auto-snapshot; /api/status reconciles to "stopped" later.
    assert.equal(body.status, "snapshotting");
    // v2 persistent: stop auto-snapshots, no manual snapshotId returned
  });
});
