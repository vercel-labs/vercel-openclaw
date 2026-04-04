/**
 * Tests for POST /api/admin/ensure.
 *
 * Covers: auth enforcement (403 without CSRF), happy path ensure
 * from uninitialized (returns 202), and ensure when already running (200).
 *
 * Run: npm test src/app/api/admin/ensure/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  callAdminPost,
  getAdminEnsureRoute,
  drainAfterCallbacks,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("admin/ensure POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminEnsureRoute();
    const req = buildPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Happy path: ensure from uninitialized
// ===========================================================================

test("admin/ensure POST: from uninitialized returns 202 waiting", async () => {
  await withHarness(async () => {
    const route = getAdminEnsureRoute();
    const result = await callAdminPost(route.POST, "/api/admin/ensure");

    assert.equal(result.status, 202);
    const body = result.json as { state: string; status: string };
    assert.equal(body.state, "waiting");
    await drainAfterCallbacks();
  });
});

// ===========================================================================
// Ensure when already running
// ===========================================================================

test("admin/ensure POST: when already running returns 200", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const route = getAdminEnsureRoute();
    const result = await callAdminPost(route.POST, "/api/admin/ensure");

    assert.equal(result.status, 200);
    const body = result.json as { state: string; status: string };
    assert.equal(body.state, "running");
    assert.equal(body.status, "running");
    await drainAfterCallbacks();
  });
});

// ===========================================================================
// wait=1 returns restoreHistory
// ===========================================================================

test("admin/ensure POST: wait=1 response includes restoreHistory array", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Install gateway-ready handler so probeGatewayReady succeeds during wait
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const route = getAdminEnsureRoute();
      const req = buildAuthPostRequest("/api/admin/ensure?wait=1", "{}");
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200);
      const body = result.json as {
        mode: string;
        restoreHistory: unknown[];
      };
      assert.equal(body.mode, "wait");
      assert.ok(
        Array.isArray(body.restoreHistory),
        "wait=1 response should include restoreHistory array",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    await drainAfterCallbacks();
  });
});
