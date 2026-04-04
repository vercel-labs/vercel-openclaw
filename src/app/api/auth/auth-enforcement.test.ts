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
  getAuthLoginRoute,
  getAdminChannelSecretsRoute,
  getFirewallRoute,
  getFirewallDiagnosticsRoute,
  getFirewallAllowlistRoute,
  getFirewallPromoteRoute,
  getFirewallLearnedRoute,
  getFirewallReportRoute,
  getAdminSshRoute,
  getAdminSnapshotRoute,
} from "@/test-utils/route-caller";
import { loginWithAdminSecret } from "@/server/auth/admin-auth";
import { _resetRateLimitForTesting } from "@/server/auth/rate-limit";

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
    _resetRateLimitForTesting();
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
// 3. Mutations without auth → 401
// ===========================================================================

test("admin/ensure: POST without auth returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    // POST without bearer and without CSRF headers
    const request = buildPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED", `Expected UNAUTHORIZED, got: ${body.error}`);
  });
});

test("POST /api/status: heartbeat without auth returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
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

    // Unauthenticated POST (no cookie, no bearer) → 401
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

// ===========================================================================
// 11. Login rate limiting
// ===========================================================================

test("auth/login: repeated invalid attempts trigger 429 rate limit", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAuthLoginRoute();

    // Send 11 requests with a deterministic caller key (> default limit of 10)
    for (let i = 0; i < 10; i++) {
      const request = buildPostRequest(
        "/api/auth/login",
        JSON.stringify({ secret: "wrong-secret" }),
        { "x-forwarded-for": "10.0.0.99" },
      );
      const result = await callRoute(route.POST!, request);
      // First 10 should be 401 (wrong secret, but within rate limit)
      assert.equal(
        result.status,
        401,
        `Attempt ${i + 1}: expected 401, got ${result.status}`,
      );
    }

    // 11th attempt should be rate-limited
    const blockedRequest = buildPostRequest(
      "/api/auth/login",
      JSON.stringify({ secret: "wrong-secret" }),
      { "x-forwarded-for": "10.0.0.99" },
    );
    const blockedResult = await callRoute(route.POST!, blockedRequest);
    assert.equal(blockedResult.status, 429, `Expected 429, got ${blockedResult.status}`);
    const body = blockedResult.json as { error: string; retryAfterMs: number };
    assert.equal(body.error, "RATE_LIMITED");
    assert.ok(typeof body.retryAfterMs === "number" && body.retryAfterMs > 0);

    // Verify Retry-After header is set
    const retryAfter = blockedResult.response.headers.get("Retry-After");
    assert.ok(retryAfter, "Retry-After header should be present");
  });
});

test("auth/login: different caller keys have independent rate limits", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAuthLoginRoute();

    // Exhaust rate limit for IP A
    for (let i = 0; i < 10; i++) {
      const request = buildPostRequest(
        "/api/auth/login",
        JSON.stringify({ secret: "wrong" }),
        { "x-forwarded-for": "10.0.0.1" },
      );
      await callRoute(route.POST!, request);
    }

    // IP A should be blocked
    const blockedA = buildPostRequest(
      "/api/auth/login",
      JSON.stringify({ secret: "wrong" }),
      { "x-forwarded-for": "10.0.0.1" },
    );
    const resultA = await callRoute(route.POST!, blockedA);
    assert.equal(resultA.status, 429);

    // IP B should still be allowed
    const requestB = buildPostRequest(
      "/api/auth/login",
      JSON.stringify({ secret: "wrong" }),
      { "x-forwarded-for": "10.0.0.2" },
    );
    const resultB = await callRoute(route.POST!, requestB);
    assert.equal(resultB.status, 401, "Different IP should not be rate limited");
  });
});

test("auth/login: valid login still works within rate limit", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAuthLoginRoute();
    const request = buildPostRequest(
      "/api/auth/login",
      JSON.stringify({ secret: "test-admin-secret-for-scenarios" }),
      { "x-forwarded-for": "10.0.0.50" },
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);

    // Check Set-Cookie header
    const setCookie = result.response.headers.get("Set-Cookie");
    assert.ok(setCookie, "Should set session cookie on successful login");
  });
});

// ===========================================================================
// 12. Admin and firewall route auth-gate sweep
// ===========================================================================

test("route auth sweep: all admin and firewall GET routes reject unauthenticated requests", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    type RouteSpec = {
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRoute: () => any;
      method: "GET";
      path: string;
    };

    const routes: RouteSpec[] = [
      { name: "admin/snapshots", getRoute: getAdminSnapshotsRoute, method: "GET", path: "/api/admin/snapshots" },
      { name: "admin/logs", getRoute: getAdminLogsRoute, method: "GET", path: "/api/admin/logs" },
      { name: "admin/ssh", getRoute: getAdminSshRoute, method: "GET", path: "/api/admin/ssh" },
      { name: "status", getRoute: getStatusRoute, method: "GET", path: "/api/status" },
      { name: "firewall", getRoute: getFirewallRoute, method: "GET", path: "/api/firewall" },
      { name: "firewall/diagnostics", getRoute: getFirewallDiagnosticsRoute, method: "GET", path: "/api/firewall/diagnostics" },
      { name: "firewall/allowlist", getRoute: getFirewallAllowlistRoute, method: "GET", path: "/api/firewall/allowlist" },
      { name: "firewall/learned", getRoute: getFirewallLearnedRoute, method: "GET", path: "/api/firewall/learned" },
      { name: "firewall/report", getRoute: getFirewallReportRoute, method: "GET", path: "/api/firewall/report" },
    ];

    for (const spec of routes) {
      const route = spec.getRoute();
      if (!route[spec.method]) continue;
      const request = buildGetRequest(spec.path);
      const result = await callRoute(route[spec.method]!, request);
      assert.equal(
        result.status,
        401,
        `${spec.name} ${spec.method}: expected 401, got ${result.status}`,
      );
    }
  });
});

// ===========================================================================
// 13. Gateway: cookie-authenticated POST without CSRF is blocked
// ===========================================================================

test("Gateway: cookie-authenticated POST without CSRF headers returns 403", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-cookie-csrf";
      m.gatewayToken = "gw-cookie-csrf";
      m.portUrls = { "3000": "https://sbx-cookie-csrf-3000.fake.vercel.run" };
    });

    const login = await loginWithAdminSecret(
      "test-admin-secret-for-scenarios",
      false,
    );
    assert.ok(login, "expected cookie session");

    const mod = getGatewayRoute();
    const request = new Request(
      "http://localhost:3000/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: {
          cookie: login.setCookieHeader.split(";")[0],
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "hello" }),
      },
    );

    const response = await mod.POST(request, {
      params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
    });

    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "CSRF_HEADER_MISSING");
  });
});

test("Gateway: bearer-authenticated POST passes auth", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-bearer-post";
      m.gatewayToken = "gw-bearer-post";
      m.portUrls = { "3000": "https://sbx-bearer-post-3000.fake.vercel.run" };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("fake.vercel.run")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    try {
      const mod = getGatewayRoute();
      const request = new Request(
        "http://localhost:3000/gateway/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-secret-for-scenarios",
            "content-type": "application/json",
          },
          body: JSON.stringify({ prompt: "hello" }),
        },
      );

      const response = await mod.POST(request, {
        params: Promise.resolve({ path: ["v1", "chat", "completions"] }),
      });

      assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("route auth sweep: all admin mutation routes reject unauthenticated requests", async () => {
  await withAdminAuthEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    type MutationSpec = {
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRoute: () => any;
      method: "POST" | "PUT" | "DELETE";
      path: string;
    };

    const routes: MutationSpec[] = [
      { name: "admin/ensure", getRoute: getAdminEnsureRoute, method: "POST", path: "/api/admin/ensure" },
      { name: "admin/snapshot", getRoute: getAdminSnapshotRoute, method: "POST", path: "/api/admin/snapshot" },
      { name: "admin/channel-secrets PUT", getRoute: getAdminChannelSecretsRoute, method: "PUT", path: "/api/admin/channel-secrets" },
      { name: "admin/channel-secrets POST", getRoute: getAdminChannelSecretsRoute, method: "POST", path: "/api/admin/channel-secrets" },
      { name: "admin/channel-secrets DELETE", getRoute: getAdminChannelSecretsRoute, method: "DELETE", path: "/api/admin/channel-secrets" },
      { name: "firewall/promote", getRoute: getFirewallPromoteRoute, method: "POST", path: "/api/firewall/promote" },
    ];

    for (const spec of routes) {
      const route = spec.getRoute();
      if (!route[spec.method]) continue;

      // Mutation without auth (no cookie, no bearer) → 401
      let request: Request;
      if (spec.method === "PUT") {
        request = new Request(`http://localhost:3000${spec.path}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } else if (spec.method === "DELETE") {
        request = new Request(`http://localhost:3000${spec.path}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } else {
        request = buildPostRequest(spec.path, "{}");
      }

      const result = await callRoute(route[spec.method]!, request);
      assert.equal(
        result.status, 401,
        `${spec.name}: expected 401, got ${result.status}`,
      );
    }
  });
});
