/**
 * Smoke tests for GET /api/health.
 *
 * The health endpoint is unauthenticated and returns basic system info.
 *
 * Run: npm test src/app/api/health/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting } from "@/server/store/store";
import {
  callRoute,
  buildGetRequest,
  getHealthRoute,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "REDIS_URL",
    "KV_URL",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
  }
}

// ===========================================================================
// GET /api/health
// ===========================================================================

test("GET /api/health: returns 200 with ok true", async () => {
  await withTestEnv(async () => {
    const route = getHealthRoute();
    const request = buildGetRequest("/api/health");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; status: string; storeBackend: string };
    assert.equal(body.ok, true);
    assert.ok(body.status, "should include status field");
    assert.ok(body.storeBackend, "should include storeBackend field");
  });
});

test("GET /api/health: returns memory store in test mode", async () => {
  await withTestEnv(async () => {
    const route = getHealthRoute();
    const request = buildGetRequest("/api/health");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { storeBackend: string };
    assert.equal(body.storeBackend, "memory");
  });
});

test("GET /api/health: returns uninitialized status by default", async () => {
  await withTestEnv(async () => {
    const route = getHealthRoute();
    const request = buildGetRequest("/api/health");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { status: string; hasSnapshot: boolean };
    assert.equal(body.status, "uninitialized");
    assert.equal(body.hasSnapshot, false);
  });
});
