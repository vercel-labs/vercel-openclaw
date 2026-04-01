/**
 * Tests for POST /api/admin/snapshots/restore.
 *
 * Covers: auth enforcement (403 without CSRF), missing snapshotId (400),
 * unknown snapshot (404), happy path restore from stopped state.
 *
 * Run: npm test src/app/api/admin/snapshots/restore/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  callAdminPost,
  getAdminRestoreRoute,
  drainAfterCallbacks,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("admin/snapshots/restore POST: without CSRF headers returns 403", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const req = buildPostRequest(
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-123" }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

test("admin/snapshots/restore POST: missing snapshotId returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(route.POST, "/api/admin/snapshots/restore", "{}");
    assert.equal(result.status, 400);
  });
});

test("admin/snapshots/restore POST: empty snapshotId returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "  " }),
    );
    assert.equal(result.status, 400);
  });
});

test("admin/snapshots/restore POST: invalid JSON returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const req = buildPostRequest("/api/admin/snapshots/restore", "not-json", {
      authorization: "Bearer test-admin-secret-for-scenarios",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("admin/snapshots/restore POST: unknown snapshotId returns 404", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-nonexistent" }),
    );
    assert.equal(result.status, 404);
  });
});

// ===========================================================================
// Happy path: restore a known snapshot
// ===========================================================================

test("admin/snapshots/restore POST: restores known snapshot", async () => {
  await withHarness(async (h) => {
    // Drive to running, then stop
    await h.driveToRunning();
    const snapshotId = await h.stopToSnapshot();

    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId }),
    );

    // v2 persistent: restore sets the snapshotId and triggers ensure
    assert.ok(result.status === 200 || result.status === 202);
    await drainAfterCallbacks();
  });
});

test("admin/snapshots/restore POST: restores snapshot from history", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "hist-1",
          snapshotId: "snap-from-history",
          timestamp: Date.now() - 1_000,
          reason: "scheduled",
        },
      ];
    });

    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-from-history" }),
    );

    assert.ok(result.status === 200 || result.status === 202);
    const body = result.json as { snapshotId: string; state: string };
    assert.equal(body.snapshotId, "snap-from-history");
    await drainAfterCallbacks();
  });
});
