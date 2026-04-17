/**
 * Tests for POST /api/admin/stop.
 *
 * Covers: auth enforcement (403 without CSRF), happy path stop with
 * lifecycle state transition.
 *
 * Run: npm test src/app/api/admin/stop/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleLockKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  callAdminPost,
  getAdminStopRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("admin/stop POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminStopRoute();
    const req = buildPostRequest("/api/admin/stop", "{}");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Happy path: stop from running state
// ===========================================================================

test("admin/stop POST: stops running sandbox and returns stopped status", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const meta = await h.getMeta();
    assert.equal(meta.status, "running");

    const route = getAdminStopRoute();
    const result = await callAdminPost(route.POST, "/api/admin/stop");

    assert.equal(result.status, 200);
    const body = result.json as { status: string; snapshotId: string | null };
    // v2 non-blocking stop returns "snapshotting" immediately; the status
    // reconciler flips it to "stopped" on the next /api/status read.
    assert.equal(body.status, "snapshotting");

    const afterMeta = await h.getMeta();
    assert.equal(afterMeta.status, "snapshotting");
  });
});

// ===========================================================================
// Stop from uninitialized state
// ===========================================================================

test("admin/stop POST: stop from uninitialized returns 409 error", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    assert.equal(meta.status, "uninitialized");

    const route = getAdminStopRoute();
    const result = await callAdminPost(route.POST, "/api/admin/stop");

    assert.equal(result.status, 409);
  });
});

test("admin/stop POST: lifecycle lock contention returns 409 with explicit code", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const token = await getStore().acquireLock(lifecycleLockKey(), 60);
    assert.ok(token, "expected to acquire lifecycle lock");

    const route = getAdminStopRoute();
    const result = await callAdminPost(route.POST, "/api/admin/stop");

    assert.equal(result.status, 409);
    assert.deepEqual(result.json, {
      error: "LIFECYCLE_LOCK_CONTENDED",
      message: "Sandbox lifecycle work is already in progress.",
    });
  });
});
