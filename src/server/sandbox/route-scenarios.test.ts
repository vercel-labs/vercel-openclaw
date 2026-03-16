/**
 * Route-level integration tests for gateway proxy, auth gate, and admin endpoints.
 *
 * These tests call the actual Next.js route handler exports (GET/POST) with
 * injected fake infrastructure (sandbox controller, store, fetch) so no real
 * network or sandbox API calls are made.
 *
 * Run: npm test -- src/server/sandbox/route-scenarios.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  type ScenarioHarness,
} from "@/test-utils/harness";
import {
  gatewayReadyResponse,
} from "@/test-utils/fake-fetch";
import {
  patchNextServerAfter,
  getGatewayRoute,
  getAdminEnsureRoute,
  getAdminStopRoute,
  callGatewayGet,
  callAdminPost,
  drainAfterCallbacks,
  buildGetRequest,
  buildPostRequest,
} from "@/test-utils/route-caller";
import {
  ensureSandboxRunning,
  probeGatewayReady,
  stopSandbox,
} from "@/server/sandbox/lifecycle";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// Pre-load route modules (they will use the patched `after`)
const gatewayRoute = getGatewayRoute();
const adminEnsureRoute = getAdminEnsureRoute();
const adminStopRoute = getAdminStopRoute();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive a sandbox from uninitialized → running via lifecycle functions
 * (not through route handlers) to set up preconditions.
 */
async function driveToRunning(h: ScenarioHarness): Promise<void> {
  h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = h.fakeFetch.fetch;

  try {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "http://localhost:3000",
      reason: "route-test-setup",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const probe = await probeGatewayReady();
    if (!probe.ready) {
      const meta = await h.getMeta();
      assert.equal(meta.status, "running");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ===========================================================================
// Auth gate tests
// ===========================================================================

test("Auth gate: unauthenticated GET /gateway returns 401 when no bearer token", async () => {
  const h = createScenarioHarness();
  try {
    // Request without bearer token or admin session cookie
    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: undefined }),
    });
    const text = await response.text();

    // Should be 401 — no bearer token, no admin session cookie
    assert.equal(response.status, 401);
  } finally {
    h.teardown();
  }
});

test("Auth gate: admin-secret mode passes auth transparently", async () => {
  const h = createScenarioHarness();
  try {
    // admin-secret is the default — auth always succeeds.
    // Sandbox is uninitialized so we expect a waiting page, not an auth error.
    const result = await callGatewayGet("/", { accept: "text/html" });

    // Should NOT be 401 or 302-to-authorize — should be 202 waiting page
    assert.equal(result.status, 202);
    assert.ok(
      result.text.includes("waiting") || result.text.includes("Creating"),
      "Expected waiting page HTML",
    );
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Waiting page tests
// ===========================================================================

test("Waiting page: GET /gateway when sandbox is stopped returns 202 with waiting page", async () => {
  const h = createScenarioHarness();
  try {
    // Set meta to stopped with a snapshot
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-test-waiting";
    });

    const result = await callGatewayGet("/", { accept: "text/html" });

    assert.equal(result.status, 202);
    assert.ok(result.text.includes("<!DOCTYPE html>") || result.text.includes("<html"), "Should be HTML");
    assert.ok(
      result.text.includes("/api/status") || result.text.includes("waiting"),
      "Expected waiting page with status polling",
    );

    // Verify Content-Type
    const ct = result.response.headers.get("content-type");
    assert.ok(ct?.includes("text/html"), `Expected text/html, got: ${ct}`);
  } finally {
    h.teardown();
  }
});

test("Waiting page: GET /gateway when sandbox is creating returns 202", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "creating";
    });

    const result = await callGatewayGet("/", { accept: "text/html" });

    assert.equal(result.status, 202);
    assert.ok(result.text.includes("Creating"), "Expected 'Creating' status label");
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Proxy pass-through tests
// ===========================================================================

test("Proxy pass-through: GET /gateway when sandbox is running returns proxied upstream content", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    const meta = await h.getMeta();
    assert.equal(meta.status, "running");

    // Reset handlers from driveToRunning, then set up JSON upstream
    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const result = await callGatewayGet("/api/data");

      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { hello: "world" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Proxy pass-through: GET /gateway/ for HTML triggers injection", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    // Reset handlers from driveToRunning, then set up HTML upstream
    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(
        '<html><head></head><body><div id="openclaw-app">ready</div></body></html>',
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const result = await callGatewayGet("/");

      assert.equal(result.status, 200);
      // The injected script should be present in the HTML
      assert.ok(
        result.text.includes("openclaw-app"),
        "Proxied HTML should include upstream content",
      );
      // HTML injection adds a <script> and <base> tag
      assert.ok(
        result.text.includes("<script") || result.text.includes("<base"),
        "Expected HTML injection artifacts (script or base tag)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Proxy: upstream 502 when fetch fails", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    // Reset handlers from driveToRunning, then set up failure
    h.fakeFetch.reset();
    h.fakeFetch.otherwise(() => {
      throw new Error("connection refused");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const result = await callGatewayGet("/api/test");

      assert.equal(result.status, 502);
      assert.ok(result.text.includes("Bad Gateway"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Admin endpoint tests
// ===========================================================================

test("Admin: POST /api/admin/ensure returns waiting state when sandbox is uninitialized", async () => {
  const h = createScenarioHarness();
  try {
    const result = await callAdminPost(
      adminEnsureRoute.POST,
      "/api/admin/ensure",
    );

    assert.equal(result.status, 202);
    const body = result.json as { state: string; status: string };
    assert.equal(body.state, "waiting");
    assert.ok(
      body.status === "creating" || body.status === "restoring",
      `Expected creating or restoring, got: ${body.status}`,
    );
  } finally {
    h.teardown();
  }
});

test("Admin: POST /api/admin/ensure returns running state when sandbox is running", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    const result = await callAdminPost(
      adminEnsureRoute.POST,
      "/api/admin/ensure",
    );

    assert.equal(result.status, 200);
    const body = result.json as { state: string; status: string; sandboxId: string };
    assert.equal(body.state, "running");
    assert.equal(body.status, "running");
    assert.ok(body.sandboxId, "sandboxId should be set");
  } finally {
    h.teardown();
  }
});

test("Admin: POST /api/admin/stop returns stopped state after stopping a running sandbox", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    const meta = await h.getMeta();
    assert.equal(meta.status, "running");

    const result = await callAdminPost(
      adminStopRoute.POST,
      "/api/admin/stop",
    );

    assert.equal(result.status, 200);
    const body = result.json as { status: string; snapshotId: string };
    assert.equal(body.status, "stopped");
    assert.ok(body.snapshotId, "snapshotId should be set");
    assert.ok(body.snapshotId.startsWith("snap-"), "snapshotId should have snap- prefix");
  } finally {
    h.teardown();
  }
});

test("Admin: POST /api/admin/ensure without CSRF headers returns 403", async () => {
  const h = createScenarioHarness();
  try {
    // Build a request without origin or x-requested-with headers
    const request = buildPostRequest("/api/admin/ensure", "{}", {});
    const result = await callRoute(adminEnsureRoute.POST, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Invalid path test
// ===========================================================================

test("Gateway: path traversal attempt returns 400", async () => {
  const h = createScenarioHarness();
  try {
    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway/../../../etc/passwd");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: ["..", "..", "..", "etc", "passwd"] }),
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.ok(text.includes("Invalid path"));
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Re-export callRoute for CSRF test above
// ---------------------------------------------------------------------------
import { callRoute } from "@/test-utils/route-caller";
