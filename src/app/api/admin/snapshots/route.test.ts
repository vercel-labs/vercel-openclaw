/**
 * Smoke tests for GET/POST /api/admin/snapshots.
 *
 * Covers CSRF rejection, snapshot history listing, and snapshot creation.
 *
 * Run: npm test src/app/api/admin/snapshots/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SnapshotRecord } from "@/shared/types";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  buildAuthGetRequest,
  getAdminSnapshotsRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

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
// GET /api/admin/snapshots
// ===========================================================================

test("GET /api/admin/snapshots: returns snapshot history", async () => {
  await withTestEnv(async () => {
    const record: SnapshotRecord = {
      id: "test-uuid",
      snapshotId: "snap-history-1",
      timestamp: Date.now(),
      reason: "manual",
    };

    await mutateMeta((meta) => {
      meta.snapshotHistory = [record];
    });

    const route = getAdminSnapshotsRoute();
    const request = buildAuthGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: SnapshotRecord[] };
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].snapshotId, "snap-history-1");
    assert.equal(body.snapshots[0].reason, "manual");
  });
});

test("GET /api/admin/snapshots: returns empty array when no snapshots", async () => {
  await withTestEnv(async () => {
    const route = getAdminSnapshotsRoute();
    const request = buildAuthGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: SnapshotRecord[] };
    assert.deepEqual(body.snapshots, []);
  });
});

// ===========================================================================
// POST /api/admin/snapshots (CSRF check)
// ===========================================================================

test("POST /api/admin/snapshots: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getAdminSnapshotsRoute();
    const request = buildPostRequest("/api/admin/snapshots", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED", `Expected UNAUTHORIZED, got: ${body.error}`);
  });
});

test("POST /api/admin/snapshots: returns 409 when sandbox is not running", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const route = getAdminSnapshotsRoute();
    const request = buildAuthPostRequest("/api/admin/snapshots", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "SANDBOX_NOT_RUNNING");
  });
});

test("POST /api/admin/snapshots: returns 500 when Sandbox.get fails", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-snap";
    });

    const route = getAdminSnapshotsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/snapshots",
      JSON.stringify({ reason: "test-snapshot" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 500);
    const body = result.json as { error: string };
    assert.ok(body.error, "Should return a JSON error");
  });
});
