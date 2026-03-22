/**
 * Smoke tests for GET/POST /api/status.
 *
 * Covers:
 * - GET returns status for both running and uninitialized sandbox states
 * - POST heartbeat with CSRF verification
 *
 * Run: npm test src/app/api/status/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import { _resetSandboxSleepConfigCacheForTesting } from "@/server/sandbox/timeout";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildGetRequest,
  buildPostRequest,
  buildAuthGetRequest,
  buildAuthPostRequest,
  getStatusRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { FakeSandboxController, FakeSandboxHandle } from "@/test-utils/harness";

// Patch before loading routes
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_BASE_DOMAIN",
    "BASE_DOMAIN",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

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
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  }
}

// ===========================================================================
// GET /api/status
// ===========================================================================

test("GET /api/status: returns uninitialized status by default", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { status: string; storeBackend: string };
    assert.equal(body.status, "uninitialized");
    assert.equal(body.storeBackend, "memory");
  });
});

test("GET /api/status: returns running status when sandbox is running", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-test-run";
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      status: string;
      sandboxId: string;
      gatewayReady: boolean;
    };
    assert.equal(body.status, "running");
    assert.equal(body.sandboxId, "sbx-test-run");
    assert.equal(body.gatewayReady, true);
  });
});

test("GET /api/status: includes firewall and channel state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { mode: string };
      channels: unknown;
    };
    assert.equal(body.firewall.mode, "learning");
    assert.ok("channels" in body, "should include channels");
  });
});

// ===========================================================================
// POST /api/status (heartbeat)
// ===========================================================================

test("POST /api/status: heartbeat without CSRF returns 403", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

test("POST /api/status: heartbeat with CSRF returns ok when sandbox is running", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-heartbeat";
    });

    const route = getStatusRoute();
    const request = buildAuthPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");
  });
});

// ===========================================================================
// GET /api/status — configured sleep-after values
// ===========================================================================

// ===========================================================================
// GET /api/status — lifecycle metadata
// ===========================================================================

test("GET /api/status: includes lifecycle metadata with restore metrics and token state", async () => {
  await withTestEnv(async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-lifecycle-test";
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 100,
        tokenWriteMs: 50,
        assetSyncMs: 200,
        startupScriptMs: 300,
        forcePairMs: 150,
        firewallSyncMs: 80,
        localReadyMs: 500,
        publicReadyMs: 600,
        totalMs: 1980,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: false,
        dynamicConfigHash: "abc456def",
        dynamicConfigReason: "hash-miss",
        assetSha256: "abc123",
        vcpus: 2,
        recordedAt: now,
      };
      meta.restoreHistory = [
        {
          sandboxCreateMs: 100,
          tokenWriteMs: 50,
          assetSyncMs: 200,
          startupScriptMs: 300,
          forcePairMs: 150,
          firewallSyncMs: 80,
          localReadyMs: 500,
          publicReadyMs: 600,
          totalMs: 1980,
          skippedStaticAssetSync: false,
          assetSha256: "abc123",
          vcpus: 2,
          recordedAt: now,
        },
      ];
      meta.lastTokenRefreshAt = now - 60_000;
      meta.lastTokenSource = "oidc";
      meta.lastTokenExpiresAt = now + 300_000;
      meta.lastTokenRefreshError = null;
      meta.consecutiveTokenRefreshFailures = 0;
      meta.breakerOpenUntil = null;
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      lifecycle: {
        lastRestoreMetrics: {
          totalMs: number;
          vcpus: number;
          skippedDynamicConfigSync: boolean;
          dynamicConfigHash: string | null;
          dynamicConfigReason: string;
        };
        restoreHistory: Array<{ totalMs: number }>;
        lastTokenRefreshAt: number;
        lastTokenSource: string | null;
        lastTokenExpiresAt: number | null;
        lastTokenRefreshError: string | null;
        consecutiveTokenRefreshFailures: number;
        breakerOpenUntil: number | null;
      };
    };

    assert.ok(body.lifecycle, "should include lifecycle block");
    assert.equal(body.lifecycle.lastRestoreMetrics.totalMs, 1980);
    assert.equal(body.lifecycle.lastRestoreMetrics.vcpus, 2);
    assert.equal(body.lifecycle.lastRestoreMetrics.skippedDynamicConfigSync, false);
    assert.equal(body.lifecycle.lastRestoreMetrics.dynamicConfigHash, "abc456def");
    assert.equal(body.lifecycle.lastRestoreMetrics.dynamicConfigReason, "hash-miss");
    assert.equal(body.lifecycle.restoreHistory.length, 1);
    assert.equal(body.lifecycle.lastTokenSource, "oidc");
    assert.equal(body.lifecycle.lastTokenRefreshError, null);
    assert.equal(body.lifecycle.consecutiveTokenRefreshFailures, 0);
    assert.equal(body.lifecycle.breakerOpenUntil, null);
  });
});

test("GET /api/status: lifecycle block defaults to null/zero when no restore history exists", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      lifecycle: {
        lastRestoreMetrics: unknown;
        restoreHistory: unknown[];
        lastTokenRefreshAt: number | null;
        lastTokenSource: string | null;
        lastTokenExpiresAt: number | null;
        lastTokenRefreshError: string | null;
        consecutiveTokenRefreshFailures: number;
        breakerOpenUntil: number | null;
      };
    };

    assert.ok(body.lifecycle, "should include lifecycle block");
    assert.equal(body.lifecycle.lastRestoreMetrics, null);
    assert.deepEqual(body.lifecycle.restoreHistory, []);
    assert.equal(body.lifecycle.lastTokenRefreshAt, null);
    assert.equal(body.lifecycle.lastTokenSource, null);
    assert.equal(body.lifecycle.consecutiveTokenRefreshFailures, 0);
    assert.equal(body.lifecycle.breakerOpenUntil, null);
  });
});

test("GET /api/status: lifecycle.restoreHistory is capped at 5 entries", async () => {
  await withTestEnv(async () => {
    const base = {
      sandboxCreateMs: 100,
      tokenWriteMs: 50,
      assetSyncMs: 200,
      startupScriptMs: 300,
      forcePairMs: 150,
      firewallSyncMs: 80,
      localReadyMs: 500,
      publicReadyMs: 600,
      totalMs: 1980,
      skippedStaticAssetSync: false,
      assetSha256: "abc",
      vcpus: 1,
      recordedAt: Date.now(),
    };
    await mutateMeta((meta) => {
      meta.restoreHistory = Array.from({ length: 10 }, (_, i) => ({
        ...base,
        totalMs: 1000 + i * 100,
      }));
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      lifecycle: { restoreHistory: Array<{ totalMs: number }> };
    };
    assert.equal(body.lifecycle.restoreHistory.length, 5);
    assert.equal(body.lifecycle.restoreHistory[0]?.totalMs, 1000);
  });
});

// ===========================================================================
// GET /api/status — configured sleep-after values
// ===========================================================================

test("GET /api/status: returns configured sleep settings and timeout remaining", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const original = process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
    const originalFetch = globalThis.fetch;
    try {
      process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
      _resetSandboxSleepConfigCacheForTesting();

      // Stub fetch for the gateway readiness probe triggered by ?health=1
      globalThis.fetch = async () =>
        new Response('<div id="openclaw-app">ready</div>', { status: 200 });

      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-status-timeout";
        meta.lastAccessedAt = null;
      });

      controller.handlesByIds.set(
        "sbx-status-timeout",
        new FakeSandboxHandle("sbx-status-timeout", controller.events, 120_000),
      );

      const route = getStatusRoute();
      const request = buildAuthGetRequest("/api/status?health=1");
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        sleepAfterMs: number;
        heartbeatIntervalMs: number;
        timeoutRemainingMs: number | null;
      };

      assert.equal(body.sleepAfterMs, 300_000);
      assert.equal(body.heartbeatIntervalMs, 150_000);
      assert.equal(body.timeoutRemainingMs, 120_000);
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) {
        delete process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
      } else {
        process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = original;
      }
      _resetSandboxSleepConfigCacheForTesting();
    }
  });
});
