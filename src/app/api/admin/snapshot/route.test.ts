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
// POST /api/admin/snapshot
// ===========================================================================

test("POST /api/admin/snapshot: without CSRF headers returns 403", async () => {
  await withTestEnv(async () => {
    const route = getAdminSnapshotRoute();
    const request = buildPostRequest("/api/admin/snapshot", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
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
    assert.equal(body.status, "stopped");
    // v2 persistent: stop auto-snapshots, no manual snapshotId returned
  });
});
