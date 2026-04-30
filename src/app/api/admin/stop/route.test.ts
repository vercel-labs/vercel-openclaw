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
  buildAuthGetRequest,
  buildPostRequest,
  callAdminPost,
  getAdminStopRoute,
  getStatusRoute,
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

test("admin/stop POST: parks running sandbox in snapshotting", async () => {
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

test("admin/stop POST: status polling holds snapshotting until SDK reports stopped", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const handle = h.controller.lastCreated();
    assert.ok(handle, "driveToRunning should create a sandbox handle");

    handle.stop = async (options?: { blocking?: boolean }) => {
      handle.stopCalled = true;
      handle.lastStopOptions = options;
      handle.setStatus("snapshotting");
    };

    const stopRoute = getAdminStopRoute();
    const statusRoute = getStatusRoute();

    const stopResult = await callAdminPost(stopRoute.POST, "/api/admin/stop");
    assert.equal(stopResult.status, 200);
    assert.equal((stopResult.json as { status: string }).status, "snapshotting");
    assert.equal(handle.lastStopOptions?.blocking, false);

    for (let i = 0; i < 3; i += 1) {
      const poll = await callRoute(
        statusRoute.GET!,
        buildAuthGetRequest("/api/status"),
      );
      assert.equal(poll.status, 200);
      assert.equal(
        (poll.json as { status: string }).status,
        "snapshotting",
        `poll ${i + 1} should not force stopped while SDK is still snapshotting`,
      );
    }

    handle.setStatus("stopped");
    const finalPoll = await callRoute(
      statusRoute.GET!,
      buildAuthGetRequest("/api/status"),
    );
    assert.equal(finalPoll.status, 200);
    assert.equal((finalPoll.json as { status: string }).status, "stopped");

    const meta = await h.getMeta();
    assert.equal(meta.status, "stopped");
    assert.equal(meta.sandboxId, handle.sandboxId);
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
