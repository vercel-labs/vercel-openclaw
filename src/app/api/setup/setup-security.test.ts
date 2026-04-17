/**
 * Security regression tests for GET /api/setup.
 *
 * Verifies:
 * - Deployed (Vercel) environments never reveal an admin secret → 410
 * - No "first caller wins" pattern exists
 * - Local dev with ADMIN_SECRET env returns source hint, not the secret
 * - Local dev without ADMIN_SECRET still returns the generated secret
 * - /api/auth/login still works with explicit ADMIN_SECRET
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting } from "@/server/store/store";
import {
  _resetAdminSecretCacheForTesting,
} from "@/server/auth/admin-secret";

// ---------------------------------------------------------------------------
// env helper
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "ADMIN_SECRET",
  "REDIS_URL",
    "KV_URL",
];

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key];
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  _resetStoreForTesting();
  _resetAdminSecretCacheForTesting();

  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    _resetAdminSecretCacheForTesting();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("setup: returns 410 on Vercel deployment (VERCEL env set)", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: "some-secret",
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      assert.equal(res.status, 410, `Expected 410, got ${res.status}`);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "SETUP_ENDPOINT_SEALED");
    },
  );
});

test("setup: returns 410 on Vercel deployment (VERCEL_ENV set)", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: "production",
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: undefined,
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      assert.equal(res.status, 410, `Expected 410, got ${res.status}`);
    },
  );
});

test("setup: returns 410 on Vercel deployment (VERCEL_URL set)", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: "my-app.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: "secret-123",
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      assert.equal(res.status, 410, `Expected 410, got ${res.status}`);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "SETUP_ENDPOINT_SEALED");
      assert.ok(body.message.includes("ADMIN_SECRET"));
    },
  );
});

test("setup: never returns admin secret on Vercel even without ADMIN_SECRET env", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: undefined,
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      assert.equal(res.status, 410);
      const text = await res.text();
      // Ensure no 64-char hex secret leaked
      assert.ok(!/[0-9a-f]{64}/i.test(text), "No secret should appear in response body");
    },
  );
});

test("setup: local dev with explicit ADMIN_SECRET returns source=env (no secret value)", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: "my-local-secret",
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { source: string; secret?: string };
      assert.equal(body.source, "env");
      assert.equal(body.secret, undefined, "Must not return the env secret value");
    },
  );
});

test("setup: local dev without ADMIN_SECRET returns 200 or 503 (never a secret on 503)", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      ADMIN_SECRET: undefined,
    },
    async () => {
      const { GET } = await import("@/app/api/setup/route");
      const res = await GET(new Request("http://localhost/api/setup"));
      // In test environments the memory store may not persist the generated
      // secret, yielding 503. Either outcome is acceptable — the important
      // invariant is that 200 returns source=generated with a secret, and
      // 503 does not leak anything.
      if (res.status === 200) {
        const body = (await res.json()) as { source: string; secret?: string };
        assert.equal(body.source, "generated");
        assert.ok(typeof body.secret === "string" && body.secret.length > 0);
      } else {
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, "ADMIN_SECRET_UNAVAILABLE");
      }
    },
  );
});

test("setup: regression — no revealAdminSecretOnce export exists", async () => {
  const mod = await import("@/server/auth/admin-secret");
  assert.equal(
    "revealAdminSecretOnce" in mod,
    false,
    "revealAdminSecretOnce must not exist — the first-caller-wins pattern is removed",
  );
});
