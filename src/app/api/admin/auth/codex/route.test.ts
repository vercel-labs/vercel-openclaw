/**
 * Route-level tests for `/api/admin/auth/codex`.
 *
 * Covers:
 * - PUT returns 401 for unauthenticated calls
 * - PUT accepts an `auth-profiles.json` map, persists creds, and returns a
 *   redacted ack (no access/refresh tokens)
 * - PUT accepts a `~/.codex/auth.json` payload and normalises fields
 * - PUT returns 400 on malformed bodies
 * - PUT respects `LOCAL_READ_ONLY=1` with a 403
 * - GET returns `{ connected: false }` when no creds are stored
 * - GET returns redacted status (no access/refresh) when configured
 * - DELETE clears creds (204) and is idempotent
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting, getInitializedMeta } from "@/server/store/store";
import {
  buildAuthDeleteRequest,
  buildAuthGetRequest,
  buildAuthPutRequest,
  buildPutRequest,
  callRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before the route module is required
// ---------------------------------------------------------------------------

patchNextServerAfter();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/admin/auth/codex/route") as {
  PUT: (request: Request) => Promise<Response>;
  GET: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
};

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const ENV_KEYS: string[] = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "SESSION_SECRET",
  "ADMIN_SECRET",
  "REDIS_URL",
  "KV_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "LOCAL_READ_ONLY",
];

function withAdminAuthEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.LOCAL_READ_ONLY;

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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SECRET_ACCESS = "jwt.access.token-FAKE-ABCDEFGHIJK";
const SECRET_REFRESH = "rt_refresh-token-FAKE-LMNOPQRSTUVWX";

function authProfilesMap(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: SECRET_ACCESS,
      refresh: SECRET_REFRESH,
      expires: 1_900_000_000_000,
      accountId: "acct_12345",
      ...overrides,
    },
  });
}

function codexAuthJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tokens: {
      access_token: SECRET_ACCESS,
      refresh_token: SECRET_REFRESH,
      account_id: "acct_67890",
    },
    last_refresh: "2026-04-22T12:00:00.000Z",
    ...extra,
  });
}

function assertNoRawSecretsIn(body: string): void {
  assert.ok(
    !body.includes(SECRET_ACCESS),
    "Response must not contain the raw access token",
  );
  assert.ok(
    !body.includes(SECRET_REFRESH),
    "Response must not contain the raw refresh token",
  );
  assert.ok(
    !body.includes('"access"'),
    "Response must not include an `access` field",
  );
  assert.ok(
    !body.includes('"refresh"'),
    "Response must not include a `refresh` field",
  );
}

// ===========================================================================
// Auth boundary
// ===========================================================================

test("codex auth: unauthenticated PUT returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const request = buildPutRequest(
      "/api/admin/auth/codex",
      authProfilesMap(),
    );
    const result = await callRoute(route.PUT, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("codex auth: LOCAL_READ_ONLY=1 blocks PUT with 403", async () => {
  await withAdminAuthEnv(async () => {
    process.env.LOCAL_READ_ONLY = "1";
    const request = buildAuthPutRequest(
      "/api/admin/auth/codex",
      authProfilesMap(),
    );
    const result = await callRoute(route.PUT, request);
    assert.equal(result.status, 403, `Expected 403, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "LOCAL_READ_ONLY");
  });
});

// ===========================================================================
// PUT — parses and persists
// ===========================================================================

test("codex auth: PUT accepts auth-profiles.json map and redacts", async () => {
  await withAdminAuthEnv(async () => {
    const before = Date.now();
    const request = buildAuthPutRequest(
      "/api/admin/auth/codex",
      authProfilesMap(),
    );
    const result = await callRoute(route.PUT, request);
    const after = Date.now();

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    assertNoRawSecretsIn(result.text);

    const body = result.json as {
      connected: boolean;
      expires: number;
      accountId: string | null;
      updatedAt: number;
    };
    assert.equal(body.connected, true);
    assert.equal(body.expires, 1_900_000_000_000);
    assert.equal(body.accountId, "acct_12345");
    assert.ok(
      body.updatedAt >= before && body.updatedAt <= after,
      `updatedAt ${body.updatedAt} not in [${before}, ${after}]`,
    );

    // Store side-effect: credentials were persisted with both secrets.
    const meta = await getInitializedMeta();
    assert.ok(meta.codexCredentials, "Credentials should be stored");
    assert.equal(meta.codexCredentials?.access, SECRET_ACCESS);
    assert.equal(meta.codexCredentials?.refresh, SECRET_REFRESH);
    assert.equal(meta.codexCredentials?.expires, 1_900_000_000_000);
    assert.equal(meta.codexCredentials?.accountId, "acct_12345");
  });
});

test("codex auth: PUT normalises ~/.codex/auth.json shape", async () => {
  await withAdminAuthEnv(async () => {
    const request = buildAuthPutRequest(
      "/api/admin/auth/codex",
      codexAuthJson(),
    );
    const result = await callRoute(route.PUT, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    assertNoRawSecretsIn(result.text);

    const body = result.json as {
      connected: boolean;
      expires: number;
      accountId: string | null;
    };
    assert.equal(body.connected, true);
    assert.equal(body.accountId, "acct_67890");

    // last_refresh (2026-04-22T12:00:00Z) + 1h
    const expected = Date.parse("2026-04-22T12:00:00.000Z") + 60 * 60 * 1000;
    assert.equal(body.expires, expected);

    const meta = await getInitializedMeta();
    assert.equal(meta.codexCredentials?.access, SECRET_ACCESS);
    assert.equal(meta.codexCredentials?.refresh, SECRET_REFRESH);
    assert.equal(meta.codexCredentials?.expires, expected);
  });
});

test("codex auth: PUT rejects malformed body with 400", async () => {
  await withAdminAuthEnv(async () => {
    const badRequests = [
      JSON.stringify("just a string"),
      JSON.stringify({ foo: "bar" }),
      JSON.stringify({
        "openai-codex:default": { provider: "openai-codex" },
      }),
    ];
    for (const body of badRequests) {
      const request = buildAuthPutRequest("/api/admin/auth/codex", body);
      const result = await callRoute(route.PUT, request);
      assert.equal(
        result.status,
        400,
        `Expected 400 for body ${body}, got ${result.status}`,
      );
      assertNoRawSecretsIn(result.text);
    }
  });
});

test("codex auth: PUT rejects non-JSON body with 400 INVALID_JSON", async () => {
  await withAdminAuthEnv(async () => {
    const request = buildAuthPutRequest(
      "/api/admin/auth/codex",
      "not json at all",
    );
    const result = await callRoute(route.PUT, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

// ===========================================================================
// GET — redacted status
// ===========================================================================

test("codex auth: GET returns { connected: false } when unconfigured", async () => {
  await withAdminAuthEnv(async () => {
    const request = buildAuthGetRequest("/api/admin/auth/codex");
    const result = await callRoute(route.GET, request);
    assert.equal(result.status, 200);
    const body = result.json as { connected: boolean };
    assert.equal(body.connected, false);
  });
});

test("codex auth: GET redacts access and refresh tokens", async () => {
  await withAdminAuthEnv(async () => {
    // Populate first.
    await callRoute(
      route.PUT,
      buildAuthPutRequest("/api/admin/auth/codex", authProfilesMap()),
    );

    const request = buildAuthGetRequest("/api/admin/auth/codex");
    const result = await callRoute(route.GET, request);
    assert.equal(result.status, 200);
    assertNoRawSecretsIn(result.text);

    const body = result.json as {
      connected: boolean;
      expires: number;
      accountId: string | null;
      updatedAt: number;
      expiresIn: number;
    };
    assert.equal(body.connected, true);
    assert.equal(body.expires, 1_900_000_000_000);
    assert.equal(body.accountId, "acct_12345");
    assert.ok(typeof body.updatedAt === "number");
    assert.ok(typeof body.expiresIn === "number");
  });
});

// ===========================================================================
// DELETE — idempotent clear
// ===========================================================================

test("codex auth: DELETE clears creds and returns 204", async () => {
  await withAdminAuthEnv(async () => {
    // Populate first.
    await callRoute(
      route.PUT,
      buildAuthPutRequest("/api/admin/auth/codex", authProfilesMap()),
    );

    const deleteResult = await callRoute(
      route.DELETE,
      buildAuthDeleteRequest("/api/admin/auth/codex", ""),
    );
    assert.equal(deleteResult.status, 204);
    assert.equal(deleteResult.text, "");

    // Subsequent GET shows disconnected.
    const getResult = await callRoute(
      route.GET,
      buildAuthGetRequest("/api/admin/auth/codex"),
    );
    assert.equal(getResult.status, 200);
    const body = getResult.json as { connected: boolean };
    assert.equal(body.connected, false);

    const meta = await getInitializedMeta();
    assert.equal(
      meta.codexCredentials,
      null,
      "Store should have nulled codexCredentials",
    );
  });
});

test("codex auth: DELETE is idempotent when no creds present", async () => {
  await withAdminAuthEnv(async () => {
    const result = await callRoute(
      route.DELETE,
      buildAuthDeleteRequest("/api/admin/auth/codex", ""),
    );
    assert.equal(result.status, 204);
  });
});
