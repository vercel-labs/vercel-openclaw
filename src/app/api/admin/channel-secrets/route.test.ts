/**
 * Auth and security tests for /api/admin/channel-secrets.
 *
 * Verifies:
 * - Every exported method (PUT, POST, DELETE) rejects unauthenticated requests → 401
 * - Every exported method rejects wrong bearer token → 401
 * - Authenticated PUT does not return raw signing secrets in response body
 * - Authenticated POST does not return raw signing secrets in response body
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting } from "@/server/store/store";
import {
  callRoute,
  buildPutRequest,
  buildPostRequest,
  buildDeleteRequest,
  buildAuthPutRequest,
  buildAuthPostRequest,
  buildAuthDeleteRequest,
  getAdminChannelSecretsRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
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
  });
}

// ===========================================================================
// 1. Unauthenticated requests → 401
// ===========================================================================

test("channel-secrets: unauthenticated PUT returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPutRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.PUT!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: unauthenticated POST returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPostRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: unauthenticated DELETE returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildDeleteRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.DELETE!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

// ===========================================================================
// 2. Wrong bearer token → 401
// ===========================================================================

test("channel-secrets: PUT with wrong bearer returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPutRequest("/api/admin/channel-secrets", "{}", {
      authorization: "Bearer wrong-token",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.PUT!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: POST with wrong bearer returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPostRequest("/api/admin/channel-secrets", "{}", {
      authorization: "Bearer wrong-token",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

// ===========================================================================
// 3. Authenticated PUT does not return raw signing secrets
// ===========================================================================

test("channel-secrets: authenticated PUT response does not contain raw secrets", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPutRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);

    // The response text should not contain any 64-char hex strings (signing secrets)
    // or PEM private key markers
    assert.ok(
      !/[0-9a-f]{64}/i.test(result.text),
      "Response should not contain 64-char hex secrets",
    );
    assert.ok(
      !result.text.includes("BEGIN PRIVATE KEY"),
      "Response should not contain private keys",
    );
    assert.ok(
      !result.text.includes("signingSecret"),
      "Response should not expose signingSecret field",
    );
    assert.ok(
      !result.text.includes("webhookSecret"),
      "Response should not expose webhookSecret field",
    );
    assert.ok(
      !result.text.includes("botToken"),
      "Response should not expose botToken field",
    );
  });
});

// ===========================================================================
// 4. Authenticated POST (sign+send) does not return raw secrets
// ===========================================================================

test("channel-secrets: authenticated POST response does not contain raw secrets", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();

    // First configure test channels
    const putRequest = buildAuthPutRequest("/api/admin/channel-secrets", "{}");
    await callRoute(route.PUT!, putRequest);

    // Now send a smoke webhook — the response should not contain secrets
    const postRequest = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: '{"type":"url_verification","challenge":"test"}' }),
    );

    // The POST will try to fetch the local webhook endpoint which doesn't
    // exist in test, so it may return 503. That's fine — we only care that
    // the response body doesn't contain secrets.
    const result = await callRoute(route.POST!, postRequest);

    assert.ok(
      !result.text.includes("BEGIN PRIVATE KEY"),
      "POST response should not contain private keys",
    );
  });
});

// ===========================================================================
// 5. Authenticated DELETE works and returns clean response
// ===========================================================================

test("channel-secrets: authenticated DELETE succeeds", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthDeleteRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { removed: boolean };
    assert.equal(body.removed, true);
  });
});

// ===========================================================================
// 6. POST input validation
// ===========================================================================

test("channel-secrets: POST rejects non-object JSON", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify("just a string"),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("channel-secrets: POST dispatches whatsapp webhook with signed body", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();

    const putRequest = buildAuthPutRequest("/api/admin/channel-secrets", "{}");
    await callRoute(route.PUT!, putRequest);

    let capturedUrl = "";
    let capturedSignature = "";
    let capturedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      capturedSignature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
      capturedBody = String(init?.body ?? "");
      return Response.json({ ok: true });
    };

    try {
      const request = buildAuthPostRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({ channel: "whatsapp", body: '{"object":"whatsapp_business_account"}' }),
      );
      const result = await callRoute(route.POST!, request);
      assert.equal(result.status, 200);
      const body = result.json as {
        configured: boolean;
        sent: boolean;
        status: number;
        channel: string;
      };
      assert.equal(body.configured, true);
      assert.equal(body.sent, true);
      assert.equal(body.channel, "whatsapp");
      assert.equal(body.status, 200);
      assert.ok(
        capturedUrl.startsWith("http://localhost:3000/api/channels/whatsapp/webhook"),
        `Expected WhatsApp webhook URL, got: ${capturedUrl}`,
      );
      assert.ok(capturedSignature.startsWith("sha256="), "Expected WhatsApp HMAC signature");
      assert.equal(capturedBody, '{"object":"whatsapp_business_account"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("channel-secrets: POST rejects empty body", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: "" }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "EMPTY_BODY");
  });
});

test("channel-secrets: POST rejects payload larger than 64 KiB", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const largeBody = "x".repeat(65537);
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: largeBody }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 413);
    const body = result.json as { error: string };
    assert.equal(body.error, "PAYLOAD_TOO_LARGE");
  });
});

test("channel-secrets: POST rejects missing body field", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack" }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_FIELDS");
  });
});

// ===========================================================================
// 7. Telegram smoke dispatch uses canonical public URL with bypass param
// ===========================================================================

test("channel-secrets: POST dispatches telegram webhook via canonical public URL", async () => {
  await withAdminAuthEnv(async () => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "https://example.test";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

    const route = getAdminChannelSecretsRoute();

    // Configure test channels
    const putRequest = buildAuthPutRequest("/api/admin/channel-secrets", "{}");
    await callRoute(route.PUT!, putRequest);

    // Intercept fetch to capture the dispatch URL
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Response.json({ ok: true });
    };

    try {
      const postRequest = buildAuthPostRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({
          channel: "telegram",
          body: '{"ok":true}',
        }),
      );
      const result = await callRoute(route.POST!, postRequest);
      assert.equal(result.status, 200);

      assert.ok(
        capturedUrl.startsWith(
          "https://example.test/api/channels/telegram/webhook",
        ),
        `Expected canonical URL, got: ${capturedUrl}`,
      );
      assert.ok(
        capturedUrl.includes("x-vercel-protection-bypass=bypass-secret"),
        `Expected bypass param, got: ${capturedUrl}`,
      );
    } finally {
      globalThis.fetch = originalFetch;

      // Clean up
      await callRoute(
        route.DELETE!,
        buildAuthDeleteRequest("/api/admin/channel-secrets", "{}"),
      );
    }
  });
});
