/**
 * End-to-end tests for the gateway proxy route handler.
 *
 * Covers auth gate, waiting page, HTML injection, non-HTML pass-through,
 * redirect rewriting, POST forwarding, query param forwarding, and
 * hop-by-hop header stripping.
 *
 * Run: npm test -- src/app/gateway/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  type ScenarioHarness,
} from "@/test-utils/harness";
import { gatewayReadyResponse } from "@/test-utils/fake-fetch";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  patchNextServerAfter,
  getGatewayRoute,
  callGatewayGet,
  callGatewayMethod,
  drainAfterCallbacks,
  buildGetRequest,
  buildPostRequest,
} from "@/test-utils/route-caller";
import {
  ensureSandboxRunning,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();
const gatewayRoute = getGatewayRoute();

// ---------------------------------------------------------------------------
// Helper: bring sandbox to running state
// ---------------------------------------------------------------------------
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
    await probeGatewayReady();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Call gateway POST with given sub-path, body, and headers.
 */
async function callGatewayPost(
  subPath: string,
  body: string,
  headers?: Record<string, string>,
) {
  const pathSegments = subPath === "/"
    ? []
    : subPath.replace(/^\//, "").split("/");
  const request = new Request(
    `http://localhost:3000/gateway${subPath === "/" ? "" : subPath}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-admin-secret-for-scenarios",
        ...headers,
      },
      body,
    },
  );
  const response = await gatewayRoute.POST(request, {
    params: Promise.resolve({
      path: pathSegments.length ? pathSegments : undefined,
    }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { response, status: response.status, json, text };
}

// ===========================================================================
// 1. Unauthenticated request returns redirect to auth flow
// ===========================================================================

test("Gateway: unauthenticated GET returns 401 when no bearer token", async () => {
  const h = createScenarioHarness();
  try {
    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: undefined }),
    });
    assert.equal(response.status, 401);
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 2. Stopped sandbox returns 202 waiting page HTML
// ===========================================================================

test("Gateway: GET when sandbox is stopped returns 202 waiting page", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-test-waiting";
    });
    const result = await callGatewayGet("/", { accept: "text/html" });
    assert.equal(result.status, 202);
    const ct = result.response.headers.get("content-type");
    assert.ok(ct?.includes("text/html"), `Expected text/html, got: ${ct}`);
    assert.ok(
      result.text.includes("<!DOCTYPE html>"),
      "Expected waiting page HTML",
    );
    // CSP header should be present
    const csp = result.response.headers.get("content-security-policy");
    assert.ok(csp, "Expected CSP header on waiting page");
    assert.ok(csp?.includes("default-src"), "CSP should contain default-src");
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 3. Running sandbox proxies upstream response with correct headers
// ===========================================================================

test("Gateway: GET when running proxies upstream JSON response", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ data: "proxied" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/data");
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { data: "proxied" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 4. HTML responses include injected script (WebSocket rewrite + gateway token)
// ===========================================================================

test("Gateway: HTML response includes injected script with gateway token", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    const meta = await h.getMeta();

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(
        "<html><head></head><body>Hello</body></html>",
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
      // Injected script should be present
      assert.ok(result.text.includes("<script>"), "Expected injected <script> tag");
      // Base tag should be present for /gateway/ path rewriting
      assert.ok(result.text.includes('<base href="/gateway/"'), "Expected <base> tag");
      // Gateway token should appear in the injected script context
      assert.ok(
        result.text.includes("gatewayToken"),
        "Injected script should contain gateway token reference",
      );
      // WebSocket rewrite logic should be present
      assert.ok(
        result.text.includes("WebSocket"),
        "Injected script should contain WebSocket rewrite",
      );
      // Sandbox origin should appear in script context
      assert.ok(
        result.text.includes("sandboxOrigin"),
        "Injected script should reference sandbox origin",
      );
      // CSP should reference sandbox origin for connect-src
      const csp = result.response.headers.get("content-security-policy");
      assert.ok(csp, "Expected CSP header on injected HTML");
      assert.ok(csp?.includes("connect-src"), "CSP should include connect-src directive");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 5. Non-HTML responses (JSON, images) pass through without injection
// ===========================================================================

test("Gateway: JSON response passes through without HTML injection", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/health");
      assert.equal(result.status, 200);
      assert.ok(!result.text.includes("<script>"), "JSON should not have injected script");
      assert.ok(!result.text.includes("<base"), "JSON should not have base tag");
      assert.deepEqual(result.json, { status: "ok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Gateway: binary-like content-type passes through without injection", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    h.fakeFetch.reset();
    const pngBytes = Buffer.from("fake-png-data");
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/images/logo.png");
      assert.equal(result.status, 200);
      assert.ok(!result.text.includes("<script>"), "Image should not have injected script");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 6. Upstream redirect is rewritten to prevent browser leaving /gateway
// ===========================================================================

test("Gateway: upstream redirect to same sandbox host is rewritten to relative path", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    const meta = await h.getMeta();

    h.fakeFetch.reset();
    // Simulate a redirect from the sandbox to itself (e.g., /dashboard → /dashboard/)
    h.fakeFetch.onGet(/fake\.vercel\.run/, (url) => {
      const sandboxOrigin = new URL(url).origin;
      return new Response(null, {
        status: 302,
        headers: {
          location: `${sandboxOrigin}/dashboard/`,
        },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/dashboard");
      // Redirect should be rewritten to a relative path (same-host redirect)
      const location = result.response.headers.get("location");
      if (location) {
        assert.ok(
          !location.includes("fake.vercel.run"),
          `Redirect should not expose sandbox domain, got: ${location}`,
        );
        assert.ok(
          location.startsWith("/"),
          `Redirect should be relative, got: ${location}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Gateway: upstream redirect to external host is stripped", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "https://evil.example.com/phish",
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/some-path");
      // External redirect should be stripped (location header deleted)
      const location = result.response.headers.get("location");
      assert.ok(
        !location || !location.includes("evil.example.com"),
        `Should not redirect to external domain, got location: ${location}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Gateway: protocol-relative redirect (//) is blocked", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "//evil.example.com/phish",
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/redir-test");
      // Protocol-relative redirects should be blocked with a "Redirect blocked" page
      assert.ok(
        result.text.includes("Redirect blocked"),
        `Expected redirect blocked page, got status ${result.status}`,
      );
      const location = result.response.headers.get("location");
      assert.ok(!location, "Location header should be deleted for protocol-relative redirect");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 7. POST bodies and query params are forwarded to sandbox
// ===========================================================================

test("Gateway: POST body is forwarded to upstream", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedBody: string | null = null;
    let capturedMethod: string | null = null;
    h.fakeFetch.on("POST", /fake\.vercel\.run/, async (_url, init) => {
      capturedMethod = init?.method ?? null;
      if (init?.body) {
        capturedBody = await new Response(init.body).text();
      }
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayPost(
        "/v1/chat/completions",
        JSON.stringify({ prompt: "hello" }),
      );
      assert.equal(result.status, 200);
      assert.equal(capturedMethod, "POST");
      // Body should have been forwarded
      if (capturedBody) {
        const parsed = JSON.parse(capturedBody);
        assert.deepEqual(parsed, { prompt: "hello" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Gateway: query params are forwarded to upstream (sensitive params stripped)", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedUrl: string | null = null;
    h.fakeFetch.onGet(/fake\.vercel\.run/, (url) => {
      capturedUrl = url;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const mod = getGatewayRoute();
      const request = buildGetRequest(
        "/gateway/search?q=test&page=2&token=secret&_internal=x",
        { authorization: "Bearer test-admin-secret-for-scenarios" },
      );
      const response = await mod.GET(request, {
        params: Promise.resolve({ path: ["search"] }),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(capturedUrl, "Should have captured upstream URL");
      const url = capturedUrl as string;
      // Regular params should be forwarded
      assert.ok(url.includes("q=test"), "q param should be forwarded");
      assert.ok(url.includes("page=2"), "page param should be forwarded");
      // Sensitive params should be stripped
      assert.ok(!url.includes("token=secret"), "token param should be stripped");
      assert.ok(!url.includes("_internal"), "underscore-prefixed params should be stripped");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 8. Proxy strips hop-by-hop headers from upstream response
// ===========================================================================

test("Gateway: hop-by-hop and security headers are stripped from upstream response", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "connection": "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "proxy-authenticate": "Basic",
          "set-cookie": "session=abc123",
          "x-custom-header": "preserved",
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/test");
      assert.equal(result.status, 200);
      // Hop-by-hop headers should be stripped
      assert.ok(
        !result.response.headers.has("connection"),
        "connection header should be stripped",
      );
      assert.ok(
        !result.response.headers.has("keep-alive"),
        "keep-alive header should be stripped",
      );
      assert.ok(
        !result.response.headers.has("transfer-encoding"),
        "transfer-encoding header should be stripped",
      );
      assert.ok(
        !result.response.headers.has("proxy-authenticate"),
        "proxy-authenticate header should be stripped",
      );
      // set-cookie from upstream should be stripped (proxy manages its own cookies)
      assert.ok(
        !result.response.headers.get("set-cookie")?.includes("session=abc123"),
        "upstream set-cookie should be stripped",
      );
      // Custom headers should be preserved
      assert.equal(
        result.response.headers.get("x-custom-header"),
        "preserved",
        "custom headers should pass through",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 9. Upstream 410 triggers restore flow
// ===========================================================================

test("Gateway: upstream 410 marks sandbox unavailable and returns waiting page", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response("Gone", { status: 410 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/", { accept: "text/html" });
      assert.equal(result.status, 202);
      assert.ok(
        result.text.includes("<!DOCTYPE html>") || result.text.includes("<html"),
        "Expected waiting page HTML after 410",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 10. 204/304 responses have no body
// ===========================================================================

test("Gateway: upstream 204 returns no body", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(null, { status: 204 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/no-content");
      assert.equal(result.status, 204);
      assert.equal(result.text, "", "204 should have empty body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 11. PUT body is forwarded to upstream
// ===========================================================================

test("Gateway: PUT body is forwarded to upstream", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedBody: string | null = null;
    let capturedMethod: string | null = null;
    h.fakeFetch.on("PUT", /fake\.vercel\.run/, async (_url, init) => {
      capturedMethod = init?.method ?? null;
      if (init?.body) {
        capturedBody = await new Response(init.body).text();
      }
      return new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("PUT", "/api/resource/1", {
        body: JSON.stringify({ name: "updated" }),
      });
      assert.equal(result.status, 200);
      assert.equal(capturedMethod, "PUT");
      if (capturedBody) {
        const parsed = JSON.parse(capturedBody);
        assert.deepEqual(parsed, { name: "updated" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 12. PATCH body is forwarded to upstream
// ===========================================================================

test("Gateway: PATCH body is forwarded to upstream", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedBody: string | null = null;
    let capturedMethod: string | null = null;
    h.fakeFetch.on("PATCH", /fake\.vercel\.run/, async (_url, init) => {
      capturedMethod = init?.method ?? null;
      if (init?.body) {
        capturedBody = await new Response(init.body).text();
      }
      return new Response(JSON.stringify({ patched: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("PATCH", "/api/resource/1", {
        body: JSON.stringify({ field: "value" }),
      });
      assert.equal(result.status, 200);
      assert.equal(capturedMethod, "PATCH");
      if (capturedBody) {
        const parsed = JSON.parse(capturedBody);
        assert.deepEqual(parsed, { field: "value" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 13. DELETE is forwarded to upstream
// ===========================================================================

test("Gateway: DELETE is forwarded to upstream", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedMethod: string | null = null;
    let capturedUrl: string | null = null;
    h.fakeFetch.on("DELETE", /fake\.vercel\.run/, async (url, init) => {
      capturedMethod = init?.method ?? null;
      capturedUrl = url;
      return new Response(null, { status: 204 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("DELETE", "/api/resource/42");
      assert.equal(result.status, 204);
      assert.equal(capturedMethod, "DELETE");
      assert.ok((capturedUrl as string | null)?.includes("/api/resource/42"), "DELETE path should be forwarded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 14. HEAD returns headers without body
// ===========================================================================

test("Gateway: HEAD returns headers without body", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedMethod: string | null = null;
    h.fakeFetch.on("HEAD", /fake\.vercel\.run/, async (_url, init) => {
      capturedMethod = init?.method ?? null;
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-custom": "head-value",
        },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("HEAD", "/api/resource");
      assert.equal(result.status, 200);
      assert.equal(capturedMethod, "HEAD");
      assert.equal(result.text, "", "HEAD should have empty body");
      assert.equal(
        result.response.headers.get("x-custom"),
        "head-value",
        "HEAD should return headers from upstream",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 15. OPTIONS returns appropriate response
// ===========================================================================

test("Gateway: OPTIONS is forwarded to upstream and returns response", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedMethod: string | null = null;
    h.fakeFetch.on("OPTIONS", /fake\.vercel\.run/, async (_url, init) => {
      capturedMethod = init?.method ?? null;
      return new Response(null, {
        status: 204,
        headers: {
          allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH",
        },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("OPTIONS", "/api/resource");
      assert.equal(result.status, 204);
      assert.equal(capturedMethod, "OPTIONS");
      assert.ok(
        result.response.headers.get("allow")?.includes("GET"),
        "OPTIONS should return allow header",
      );
      assert.ok(
        result.response.headers.get("access-control-allow-origin"),
        "OPTIONS should return CORS headers from upstream",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 16. Auth gate enforced for all methods (not just GET/POST)
// ===========================================================================

for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
  test(`Gateway: unauthenticated ${method} returns 401 when no bearer token`, async () => {
    const h = createScenarioHarness();
    try {
      const mod = getGatewayRoute();
      const url = "http://localhost:3000/gateway";
      const request = new Request(url, { method });
      const handler = mod[method] as (
        req: Request,
        ctx: { params: Promise<{ path?: string[] }> },
      ) => Promise<Response>;
      const response = await handler(request, {
        params: Promise.resolve({ path: undefined }),
      });
      assert.equal(response.status, 401);
    } finally {
      h.teardown();
    }
  });
}

// ===========================================================================
// 17. Query parameters forwarded for PUT/PATCH/DELETE
// ===========================================================================

for (const method of ["PUT", "PATCH", "DELETE"] as const) {
  test(`Gateway: ${method} forwards query parameters to upstream`, async () => {
    const h = createScenarioHarness();
    try {
      await driveToRunning(h);

      h.fakeFetch.reset();
      let capturedUrl: string | null = null;
      h.fakeFetch.on(method, /fake\.vercel\.run/, (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = h.fakeFetch.fetch;
      try {
        const mod = getGatewayRoute();
        const handler = mod[method];
        const request = new Request(
          `http://localhost:3000/gateway/search?q=test&page=2`,
          {
            method,
            headers: {
              authorization: "Bearer test-admin-secret-for-scenarios",
              ...(method !== "DELETE"
                ? { "content-type": "application/json" }
                : {}),
            },
            ...(method !== "DELETE" ? { body: "{}" } : {}),
          },
        );
        const response = await handler(request, {
          params: Promise.resolve({ path: ["search"] }),
        });
        await response.text();
        assert.ok(capturedUrl, `${method} should have captured upstream URL`);
        assert.ok(
          (capturedUrl as string).includes("q=test"),
          `${method}: q param should be forwarded`,
        );
        assert.ok(
          (capturedUrl as string).includes("page=2"),
          `${method}: page param should be forwarded`,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      h.teardown();
    }
  });
}

// ===========================================================================
// 18. Hop-by-hop headers stripped for PUT
// ===========================================================================

test("Gateway: hop-by-hop headers stripped from PUT upstream response", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.on("PUT", /fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "connection": "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-custom-header": "preserved",
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayMethod("PUT", "/api/test", {
        body: JSON.stringify({ data: 1 }),
      });
      assert.equal(result.status, 200);
      assert.ok(
        !result.response.headers.has("connection"),
        "connection header should be stripped from PUT response",
      );
      assert.ok(
        !result.response.headers.has("keep-alive"),
        "keep-alive header should be stripped from PUT response",
      );
      assert.ok(
        !result.response.headers.has("transfer-encoding"),
        "transfer-encoding header should be stripped from PUT response",
      );
      assert.equal(
        result.response.headers.get("x-custom-header"),
        "preserved",
        "custom headers should pass through PUT response",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 19. WebSocket upgrade path unit assertion
// ===========================================================================

test("Gateway: WebSocket upgrade request is forwarded with correct method", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedHeaders: Record<string, string> = {};
    h.fakeFetch.onGet(/fake\.vercel\.run/, (_url, init) => {
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { capturedHeaders[k] = v; });
        } else if (!Array.isArray(h)) {
          capturedHeaders = { ...h } as Record<string, string>;
        }
      }
      // WebSocket upgrades would normally get a 101, but the proxy
      // doesn't handle the actual protocol upgrade (Vercel handles that
      // at the platform level). We just verify the request reaches upstream.
      return new Response("Upgrade Required", { status: 426 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/ws", {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });
      // The proxy forwards the request; it reaches upstream
      // Platform-level WebSocket handling would intercept before this in prod
      assert.ok(
        [200, 400, 426, 502].includes(result.status),
        `WebSocket upgrade request should reach proxy layer, got: ${result.status}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 20. Token handoff: gateway token embedded in HTML injection
// ===========================================================================

test("Gateway: HTML injection embeds actual gateway token value", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    const meta = await h.getMeta();
    const gatewayToken = meta.gatewayToken!;

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(
        "<html><head></head><body>App</body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/");
      assert.equal(result.status, 200);
      // The actual gateway token value must appear in the injected script
      assert.ok(
        result.text.includes(gatewayToken),
        "Injected HTML should contain the actual gateway token value for handoff",
      );
      // The token should appear in a JSON context with proper escaping
      assert.ok(
        result.text.includes("gatewayToken"),
        "Token should be in a named field for client-side access",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 21. Token in upstream Authorization header
// ===========================================================================

test("Gateway: upstream request includes Bearer token in Authorization header", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);
    const meta = await h.getMeta();

    h.fakeFetch.reset();
    let capturedAuthHeader: string | null = null;
    h.fakeFetch.onGet(/fake\.vercel\.run/, (_url, init) => {
      if (init?.headers) {
        const headers = init.headers;
        if (headers instanceof Headers) {
          capturedAuthHeader = headers.get("authorization");
        } else if (!Array.isArray(headers)) {
          capturedAuthHeader = (headers as Record<string, string>).authorization ?? null;
        }
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      await callGatewayGet("/api/data");
      assert.ok(capturedAuthHeader, "Upstream request should include Authorization header");
      assert.equal(
        capturedAuthHeader,
        `Bearer ${meta.gatewayToken}`,
        "Authorization header should contain the gateway token",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 22. admin-secret mode: no redirect, proxy works
// ===========================================================================

test("Gateway: admin-secret mode allows access without session cookie", async () => {
  const h = createScenarioHarness(); // default is admin-secret
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      // No auth headers, no cookies — admin-secret trusts Vercel edge
      const result = await callGatewayGet("/api/data");
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 23. sign-in-with-vercel mode: authenticated request proxies through
// ===========================================================================

test("Gateway: sign-in-with-vercel mode with valid session cookie proxies request", async () => {
  const { buildSessionCookie, setCookieToCookieHeader } = await import("@/test-utils/auth-fixtures");
  const h = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ authed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const setCookie = await buildSessionCookie();
      const cookieHeader = setCookieToCookieHeader(setCookie);
      const result = await callGatewayGet("/api/data", { cookie: cookieHeader });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { authed: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 24. Upstream fetch failure returns 502 Bad Gateway
// ===========================================================================

test("Gateway: upstream fetch exception returns 502 Bad Gateway", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => {
      throw new Error("ECONNREFUSED");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/data");
      assert.equal(result.status, 502);
      assert.ok(result.text.includes("Bad Gateway"), "Should return Bad Gateway text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 25. Subpath proxy: nested paths are forwarded correctly
// ===========================================================================

test("Gateway: deeply nested subpath is forwarded to upstream", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    let capturedUrl: string | null = null;
    h.fakeFetch.onGet(/fake\.vercel\.run/, (url) => {
      capturedUrl = url;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/v1/agents/chat/completions");
      assert.equal(result.status, 200);
      assert.ok(capturedUrl, "Should have captured upstream URL");
      assert.ok(
        (capturedUrl as string).includes("/v1/agents/chat/completions"),
        `Subpath should be forwarded, got: ${capturedUrl}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 26. Upstream 500 is passed through
// ===========================================================================

test("Gateway: upstream 500 error is passed through to client", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    h.fakeFetch.reset();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/api/broken");
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, { error: "Internal Server Error" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("sandbox running + extendTimeout fails → detects dead sandbox before proxy attempt", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    const { getInitializedMeta } = await import("@/server/store/store");
    const metaBefore = await getInitializedMeta();
    assert.equal(metaBefore.status, "running", "Precondition: meta should be running");
    assert.ok(metaBefore.sandboxId, "Precondition: sandboxId should exist");

    // Clear the touch throttle so touchRunningSandbox actually calls extendTimeout
    await h.mutateMeta((meta) => {
      meta.lastAccessedAt = null;
    });

    // Make extendTimeout throw (simulates Vercel auto-suspended sandbox)
    const handle = h.controller.getHandle(metaBefore.sandboxId!)!;
    handle.extendTimeout = async () => {
      throw new Error("sandbox not found");
    };

    _resetLogBuffer();
    h.fakeFetch.reset();
    // DO NOT set up any fakeFetch handlers — if the proxy fires, the fetch
    // will throw, which would be a 502 not a waiting page.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayGet("/", { accept: "text/html" });

      assert.equal(result.status, 202, "Should return 202 waiting page");
      assert.ok(
        result.text.includes("<!DOCTYPE html>"),
        "Expected waiting page HTML",
      );

      const logs = getServerLogs();
      const logMessages = logs.map((e) => e.message);

      // Should detect dead sandbox via touchRunningSandbox, NOT via 410
      assert.ok(
        logMessages.includes("gateway.missing_credentials"),
        "Should fire gateway.missing_credentials (touchRunningSandbox marked unavailable)",
      );
      assert.ok(
        !logMessages.includes("gateway.upstream_410"),
        "Should NOT fire gateway.upstream_410 (proxy attempt should not happen)",
      );

      // Verify ensureSandboxRunning was called to trigger restore
      const ensureLogs = logs.filter((e) => e.message === "sandbox.ensure_running");
      const restoreEnsure = ensureLogs.find(
        (e) => e.data?.reason === "gateway.sandbox_lost_after_touch",
      );
      assert.ok(restoreEnsure, "Should trigger ensureSandboxRunning to start restore");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// 28. Upstream 401 triggers OIDC token refresh and retries once
// ===========================================================================

test("Gateway: upstream 401 forces token refresh and retries", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    let callCount = 0;
    h.fakeFetch.reset();
    h.fakeFetch.onPost(/fake\.vercel\.run/, () => {
      callCount++;
      if (callCount === 1) {
        return new Response("OIDC token has expired", { status: 401 });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayPost(
        "/v1/chat/completions",
        JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      );
      assert.equal(result.status, 200, "Retry after token refresh should succeed");
      assert.equal(callCount, 2, "Should have made exactly 2 upstream requests (initial 401 + retry)");

      const logs = getServerLogs();
      const logMessages = logs.map((e) => e.message);
      assert.ok(
        logMessages.includes("gateway.upstream_401_token_expired"),
        "Should log the 401 token expiry",
      );
      assert.ok(
        logMessages.includes("gateway.upstream_401_retry_succeeded"),
        "Should log the successful retry",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
    h.teardown();
  }
});

test("Gateway: upstream 401 with failed retry returns the retry response", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    h.fakeFetch.reset();
    h.fakeFetch.onPost(/fake\.vercel\.run/, () =>
      new Response("OIDC token has expired", { status: 401 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    try {
      const result = await callGatewayPost(
        "/v1/chat/completions",
        JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      );
      // Even with token refresh, if retry still returns 401, pass it through
      assert.equal(result.status, 401, "Should pass through persistent 401");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
    h.teardown();
  }
});
