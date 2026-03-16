/**
 * Auth enforcement tests for admin-secret auth.
 *
 * Covers:
 * - Routes reject unauthenticated requests (no bearer token, no admin cookie) → 401
 * - Routes reject requests with wrong bearer token → 401
 * - Mutations without bearer token fall through to CSRF check → 403 if no origin
 * - Mutations with valid bearer token succeed (CSRF not needed)
 * - GET with valid bearer token succeeds
 * - Gateway proxy blocks unauthenticated requests (no token leak)
 * - admin-secret mode: GET with bearer token works without CSRF
 *
 * Run: npm test src/app/api/auth/auth-enforcement.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import { FakeSandboxController } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildGetRequest,
  buildAuthPostRequest,
  buildAuthGetRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
  getStatusRoute,
  getAdminEnsureRoute,
  getAdminSnapshotsRoute,
  getAdminLogsRoute,
  getGatewayRoute,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "SESSION_SECRET",
  "ADMIN_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "NEXT_PUBLIC_BASE_DOMAIN",
];

function withAdminAuthEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;

  _resetStoreForTesting();

  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  });
}

// ===========================================================================
// 1. Unauthenticated requests → 401
// ===========================================================================

test("admin/ensure: unauthenticated POST (no bearer, with CSRF) returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    // POST with CSRF headers but no bearer token or admin cookie
    const request = buildPostRequest("/api/admin/ensure", "{}", {
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("admin/snapshots: unauthenticated GET returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminSnapshotsRoute();
    const request = buildGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("GET /api/status: unauthenticated returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getStatusRoute();
    const request = buildGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

// ===========================================================================
// 2. Wrong bearer token → 401
// ===========================================================================

test("admin/ensure: wrong bearer token returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    const request = buildPostRequest("/api/admin/ensure", "{}", {
      authorization: "Bearer wrong-secret",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

// ===========================================================================
// 3. Mutations without bearer → CSRF check → 403 if no origin
// ===========================================================================

test("admin/ensure: POST without bearer or CSRF returns 403", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    // POST without bearer and without CSRF headers
    const request = buildPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403, `Expected 403, got ${result.status}`);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

test("POST /api/status: heartbeat without bearer or CSRF returns 403", async () => {
  await withAdminAuthEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403, `Expected 403, got ${result.status}`);
  });
});

// ===========================================================================
// 4. Valid bearer token → succeeds
// ===========================================================================

test("admin/ensure: POST with valid bearer token succeeds", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    const request = buildAuthPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.ok(
      result.status === 200 || result.status === 202,
      `Expected 200/202, got ${result.status}`,
    );
  });
});

test("GET /api/status: bearer token succeeds", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getStatusRoute();
    const result = await callRoute(route.GET!, buildAuthGetRequest("/api/status"));

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { status: string; user: { sub: string } };
    assert.ok(body.user, "Should include user info");
    assert.equal(body.user.sub, "admin");
  });
});

// ===========================================================================
// 5. Gateway proxy blocks unauthenticated requests (no token leak)
// ===========================================================================

test("Gateway: unauthenticated GET returns 401 (no HTML with token)", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-gate";
      m.gatewayToken = "secret-gateway-token";
      m.portUrls = { "3000": "https://sbx-auth-gate-3000.fake.vercel.run" };
    });

    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: undefined }),
    });
    const text = await response.text();

    // Should return 401, not serve HTML with embedded gateway token
    assert.equal(response.status, 401, `Expected 401, got ${response.status}`);
    // Ensure no gateway token is leaked in the response body
    assert.ok(
      !text.includes("secret-gateway-token"),
      "Gateway token must not be leaked in unauthenticated response",
    );
  });
});

test("Gateway: unauthenticated POST returns 401 (no token leak)", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-gate-post";
      m.gatewayToken = "secret-gateway-token-2";
      m.portUrls = { "3000": "https://sbx-auth-gate-post-3000.fake.vercel.run" };
    });

    const mod = getGatewayRoute();
    const request = new Request("http://localhost:3000/gateway/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    const response = await mod.POST(request, {
      params: Promise.resolve({ path: ["v1", "chat"] }),
    });
    const text = await response.text();

    assert.equal(response.status, 401, `Expected 401, got ${response.status}`);
    assert.ok(
      !text.includes("secret-gateway-token-2"),
      "Gateway token must not leak in POST response",
    );
  });
});

test("Gateway: authenticated GET with valid bearer proxies normally", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-ok";
      m.gatewayToken = "gw-token-auth-ok";
      m.portUrls = { "3000": "https://sbx-auth-ok-3000.fake.vercel.run" };
    });

    // Mock fetch for upstream response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("fake.vercel.run")) {
        return new Response(JSON.stringify({ data: "proxied" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    try {
      const mod = getGatewayRoute();
      const request = buildGetRequest("/gateway/api/data", {
        authorization: "Bearer test-admin-secret-for-scenarios",
      });
      const response = await mod.GET(request, {
        params: Promise.resolve({ path: ["api", "data"] }),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch { /* not JSON */ }

      assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
      assert.deepEqual(json, { data: "proxied" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// 6. Admin routes with valid bearer token
// ===========================================================================

test("admin/snapshots: authenticated GET with bearer succeeds", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminSnapshotsRoute();
    const request = buildAuthGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { snapshots: unknown[] };
    assert.ok(Array.isArray(body.snapshots), "Should return snapshots array");
  });
});

// ===========================================================================
// 7. Admin logs route auth enforcement
// ===========================================================================

test("admin/logs: unauthenticated GET returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("admin/logs: authenticated GET with bearer succeeds", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

// ===========================================================================
// 8. Gateway: subpath auth enforcement
// ===========================================================================

test("Gateway: unauthenticated GET on subpath returns 401 (no token leak)", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-subpath-auth";
      m.gatewayToken = "subpath-secret-token";
      m.portUrls = { "3000": "https://sbx-subpath-auth-3000.fake.vercel.run" };
    });

    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway/v1/settings");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: ["v1", "settings"] }),
    });
    const text = await response.text();

    assert.equal(response.status, 401, `Expected 401, got ${response.status}`);
    assert.ok(
      !text.includes("subpath-secret-token"),
      "Gateway token must not leak on subpaths",
    );
  });
});

// ===========================================================================
// 9. GET requests with bearer token don't need CSRF
// ===========================================================================

test("admin/snapshots: GET with bearer succeeds without CSRF headers", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminSnapshotsRoute();
    // GET with bearer but no CSRF headers
    const request = buildGetRequest("/api/admin/snapshots", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

test("admin/logs: GET with bearer succeeds without CSRF headers", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildGetRequest("/api/admin/logs", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

// ===========================================================================
// 10. Corrupted admin cookie without bearer returns 401
// ===========================================================================

test("GET /api/status: corrupted admin cookie returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getStatusRoute();
    const request = buildGetRequest("/api/status", {
      cookie: "openclaw_admin=garbage-not-valid",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401 for corrupted cookie, got ${result.status}`);
  });
});

test("Gateway: corrupted admin cookie returns 401 (not proxied HTML)", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-corrupt-cookie";
      m.gatewayToken = "token-should-not-leak";
    });

    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway/", {
      cookie: "openclaw_admin=not-valid-encrypted-jwt",
    });
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: undefined }),
    });
    const text = await response.text();

    assert.equal(response.status, 401, `Expected 401, got ${response.status}`);
    assert.ok(
      !text.includes("token-should-not-leak"),
      "Token must not leak with corrupted cookie",
    );
  });
});
