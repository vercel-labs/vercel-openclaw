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

import { computeGatewayConfigHash } from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetSandboxSleepConfigCacheForTesting,
  estimateSandboxTimeoutRemainingMs,
} from "@/server/sandbox/timeout";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { setupProgressKey } from "@/server/store/keyspace";
import type { RestoreTargetAttestation } from "@/shared/launch-verification";
import type { RestoreOracleState } from "@/shared/types";
import {
  callRoute,
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
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

// ===========================================================================
// GET /api/status
// ===========================================================================

test("estimateSandboxTimeoutRemainingMs: returns null without last access and clamps at zero", () => {
  assert.equal(estimateSandboxTimeoutRemainingMs(null, 300_000, 1_000), null);
  assert.equal(estimateSandboxTimeoutRemainingMs(1_000, 300_000, 61_000), 240_000);
  assert.equal(estimateSandboxTimeoutRemainingMs(1_000, 300_000, 401_000), 0);
});

test("GET /api/status: returns uninitialized status by default", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      status: string;
      storeBackend: string;
      timeoutSource: string;
      gatewayStatus: string;
      gatewayCheckedAt: number | null;
      lastKeepaliveAt: number | null;
    };
    assert.equal(body.status, "uninitialized");
    assert.equal(body.storeBackend, "memory");
    assert.equal(body.timeoutSource, "estimated");
    assert.equal(body.gatewayStatus, "unknown");
    assert.equal(body.gatewayCheckedAt, null);
    assert.equal(body.lastKeepaliveAt, null);
  });
});

test("GET /api/status: returns running status when sandbox is running", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-test-run";
      meta.lastAccessedAt = Date.now();
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      status: string;
      sandboxId: string;
      gatewayReady: boolean;
      gatewayStatus: string;
      timeoutSource: string;
    };
    assert.equal(body.status, "running");
    assert.equal(body.sandboxId, "sbx-test-run");
    assert.equal(body.gatewayReady, false);
    assert.equal(body.gatewayStatus, "unknown");
    assert.equal(body.timeoutSource, "estimated");
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

test("GET /api/status: includes setup progress for matching lifecycle attempt", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.lifecycleAttemptId = "attempt-setup-1";
    });
    await getStore().setValue(setupProgressKey("openclaw-single"), {
      attemptId: "attempt-setup-1",
      active: true,
      phase: "installing-openclaw",
      phaseLabel: "Installing OpenClaw",
      startedAt: 100,
      updatedAt: 200,
      preview: "npm notice added 1 package",
      lines: [
        { ts: 150, stream: "stdout", text: "npm notice added 1 package" },
      ],
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      setupProgress: {
        attemptId: string;
        phase: string;
        preview: string | null;
        lines: Array<{ text: string }>;
      } | null;
    };
    assert.ok(body.setupProgress);
    assert.equal(body.setupProgress?.attemptId, "attempt-setup-1");
    assert.equal(body.setupProgress?.phase, "installing-openclaw");
    assert.equal(body.setupProgress?.preview, "npm notice added 1 package");
    assert.equal(body.setupProgress?.lines[0]?.text, "npm notice added 1 package");
  });
});

test("GET /api/status: omits setup progress for running status", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.lifecycleAttemptId = "attempt-running-1";
    });
    await getStore().setValue(setupProgressKey("openclaw-single"), {
      attemptId: "attempt-running-1",
      active: true,
      phase: "starting-gateway",
      phaseLabel: "Starting gateway",
      startedAt: 100,
      updatedAt: 200,
      preview: "Starting gateway",
      lines: [],
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { setupProgress: unknown };
    assert.equal(body.setupProgress, null);
  });
});

// ===========================================================================
// POST /api/status (heartbeat)
// ===========================================================================

test("POST /api/status: heartbeat without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED", `Expected UNAUTHORIZED, got: ${body.error}`);
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

test("GET /api/status: passive returns estimated timeout without live sandbox calls", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const original = process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    try {
      process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
      _resetSandboxSleepConfigCacheForTesting();

      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push(url);
        return originalFetch(input as RequestInfo | URL, init);
      };

      const now = Date.now();
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-status-timeout";
        meta.lastAccessedAt = now - 180_000;
      });

      controller.handlesByIds.set(
        "sbx-status-timeout",
        new FakeSandboxHandle("sbx-status-timeout", controller.events, 120_000),
      );

      const route = getStatusRoute();
      const request = buildAuthGetRequest("/api/status");
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        sleepAfterMs: number;
        heartbeatIntervalMs: number;
        timeoutRemainingMs: number | null;
        timeoutSource: string;
        gatewayStatus: string;
        gatewayReady: boolean;
        gatewayCheckedAt: number | null;
        lastKeepaliveAt: number | null;
      };

      assert.equal(body.sleepAfterMs, 300_000);
      assert.equal(body.heartbeatIntervalMs, 150_000);
      assert.ok(body.timeoutRemainingMs !== null);
      assert.ok(
        body.timeoutRemainingMs >= 119_000 && body.timeoutRemainingMs <= 120_000,
        `expected estimated timeout near 120000ms, got ${body.timeoutRemainingMs}`,
      );
      assert.equal(body.timeoutSource, "estimated");
      assert.equal(body.gatewayStatus, "unknown");
      assert.equal(body.gatewayReady, false);
      assert.equal(body.gatewayCheckedAt, null);
      assert.equal(body.lastKeepaliveAt, now - 180_000);
      assert.deepEqual(controller.retrieved, []);
      assert.equal(controller.eventsOfKind("extend_timeout").length, 0);
      assert.equal(
        fetchCalls.filter((url) => url.includes(".fake.vercel.run")).length,
        0,
      );
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

test("GET /api/status: live health returns live timeout and gateway data", async () => {
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
        timeoutSource: string;
        gatewayStatus: string;
        gatewayReady: boolean;
        gatewayCheckedAt: number | null;
        lastKeepaliveAt: number | null;
      };

      assert.equal(body.sleepAfterMs, 300_000);
      assert.equal(body.heartbeatIntervalMs, 150_000);
      assert.equal(body.timeoutRemainingMs, 120_000);
      assert.equal(body.timeoutSource, "live");
      assert.equal(body.gatewayStatus, "ready");
      assert.equal(body.gatewayReady, true);
      assert.ok(typeof body.gatewayCheckedAt === "number");
      assert.equal(body.lastKeepaliveAt, null);
      assert.deepEqual(controller.retrieved, ["sbx-status-timeout", "sbx-status-timeout"]);

      const meta = await getInitializedMeta();
      assert.equal(meta.lastGatewayProbeReady, true);
      assert.equal(meta.lastGatewayProbeSandboxId, "sbx-status-timeout");
      assert.equal(meta.lastGatewayProbeAt, body.gatewayCheckedAt);
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

test("GET /api/status: passive returns unknown gateway status when no prior probe exists", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-gateway-unknown";
      meta.lastAccessedAt = Date.now();
      meta.lastGatewayProbeAt = null;
      meta.lastGatewayProbeReady = null;
      meta.lastGatewayProbeSandboxId = null;
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      gatewayStatus: string;
      gatewayReady: boolean;
      gatewayCheckedAt: number | null;
    };

    assert.equal(body.gatewayStatus, "unknown");
    assert.equal(body.gatewayReady, false);
    assert.equal(body.gatewayCheckedAt, null);
  });
});

test("GET /api/status: passive returns cached gateway status after live probe", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(".fake.vercel.run")) {
          return new Response('<div id="openclaw-app">ready</div>', { status: 200 });
        }
        return originalFetch(input as RequestInfo | URL, init);
      };

      const now = Date.now();
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-cache-probe";
        meta.lastAccessedAt = now - 30_000;
      });

      controller.handlesByIds.set(
        "sbx-cache-probe",
        new FakeSandboxHandle("sbx-cache-probe", controller.events, 240_000),
      );

      const route = getStatusRoute();
      const liveResult = await callRoute(
        route.GET!,
        buildAuthGetRequest("/api/status?health=1"),
      );

      assert.equal(liveResult.status, 200);
      const liveBody = liveResult.json as {
        gatewayCheckedAt: number | null;
      };
      assert.ok(typeof liveBody.gatewayCheckedAt === "number");

      controller.retrieved.length = 0;
      controller.events.length = 0;

      const passiveResult = await callRoute(route.GET!, buildAuthGetRequest("/api/status"));

      assert.equal(passiveResult.status, 200);
      const passiveBody = passiveResult.json as {
        gatewayStatus: string;
        gatewayReady: boolean;
        gatewayCheckedAt: number | null;
        timeoutSource: string;
      };

      assert.equal(passiveBody.gatewayStatus, "ready");
      assert.equal(passiveBody.gatewayReady, true);
      assert.equal(passiveBody.gatewayCheckedAt, liveBody.gatewayCheckedAt);
      assert.equal(passiveBody.timeoutSource, "estimated");
      assert.deepEqual(controller.retrieved, []);
      assert.equal(controller.events.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// GET /api/status — restore target attestation
// ===========================================================================

test("GET /api/status: restoreTarget.attestation present with correct shape for default meta", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      restoreTarget: {
        restorePreparedStatus: string;
        attestation: RestoreTargetAttestation;
      };
    };

    assert.ok(body.restoreTarget, "should include restoreTarget");
    assert.ok(body.restoreTarget.attestation, "should include restoreTarget.attestation");

    const att = body.restoreTarget.attestation;
    assert.equal(typeof att.desiredDynamicConfigHash, "string");
    assert.equal(typeof att.desiredAssetSha256, "string");
    assert.equal(typeof att.reusable, "boolean");
    assert.equal(typeof att.needsPrepare, "boolean");
    assert.ok(Array.isArray(att.reasons));
  });
});

test("GET /api/status: restoreTarget.attestation for dirty restore target (runtime-fresh, snapshot-stale)", async () => {
  await withTestEnv(async () => {
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await mutateMeta((meta) => {
      meta.snapshotId = "snap-stale";
      meta.runtimeDynamicConfigHash = desiredConfigHash;
      meta.snapshotDynamicConfigHash = "stale-snapshot-hash";
      meta.runtimeAssetSha256 = desiredAssetSha256;
      meta.snapshotAssetSha256 = desiredAssetSha256;
      meta.restorePreparedStatus = "dirty";
      meta.restorePreparedReason = "dynamic-config-changed";
      meta.restorePreparedAt = 123;
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      restoreTarget: {
        restorePreparedStatus: string;
        restorePreparedReason: string;
        restorePreparedAt: number;
        snapshotDynamicConfigHash: string;
        runtimeDynamicConfigHash: string;
        snapshotAssetSha256: string;
        runtimeAssetSha256: string;
        attestation: RestoreTargetAttestation;
      };
    };

    // Raw fields remain alongside attestation
    assert.equal(body.restoreTarget.restorePreparedStatus, "dirty");
    assert.equal(body.restoreTarget.restorePreparedReason, "dynamic-config-changed");
    assert.equal(body.restoreTarget.restorePreparedAt, 123);
    assert.equal(body.restoreTarget.snapshotDynamicConfigHash, "stale-snapshot-hash");
    assert.equal(body.restoreTarget.runtimeDynamicConfigHash, desiredConfigHash);

    // Attestation freshness
    const att = body.restoreTarget.attestation;
    assert.equal(att.desiredDynamicConfigHash, desiredConfigHash);
    assert.equal(att.desiredAssetSha256, desiredAssetSha256);
    assert.equal(att.runtimeConfigFresh, true);
    assert.equal(att.snapshotConfigFresh, false);
    assert.equal(att.runtimeAssetsFresh, true);
    assert.equal(att.snapshotAssetsFresh, true);
    assert.equal(att.reusable, false);
    assert.equal(att.needsPrepare, true);
    assert.deepEqual(att.reasons, [
      "snapshot-config-stale",
      "restore-target-dirty",
    ]);
    assert.equal(att.restorePreparedStatus, "dirty");
    assert.equal(att.restorePreparedReason, "dynamic-config-changed");
    assert.equal(att.restorePreparedAt, 123);
  });
});

// ===========================================================================
// GET /api/status — restore oracle state
// ===========================================================================

test("GET /api/status: restoreTarget.oracle present with default idle state", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      restoreTarget: {
        oracle: RestoreOracleState;
      };
    };

    assert.ok(body.restoreTarget.oracle, "should include restoreTarget.oracle");
    const oracle = body.restoreTarget.oracle;
    assert.equal(oracle.status, "idle");
    assert.equal(oracle.pendingReason, null);
    assert.equal(oracle.lastEvaluatedAt, null);
    assert.equal(oracle.lastStartedAt, null);
    assert.equal(oracle.lastCompletedAt, null);
    assert.equal(oracle.lastBlockedReason, null);
    assert.equal(oracle.lastError, null);
    assert.equal(oracle.consecutiveFailures, 0);
    assert.equal(oracle.lastResult, null);
  });
});

test("GET /api/status: restoreTarget.oracle reflects persisted oracle state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.restoreOracle.status = "blocked";
      meta.restoreOracle.pendingReason = "dynamic-config-changed";
      meta.restoreOracle.lastEvaluatedAt = 1000;
      meta.restoreOracle.lastBlockedReason = "Sandbox was active 42000ms ago; need at least 300000ms of idle time.";
      meta.restoreOracle.lastResult = "blocked";
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      restoreTarget: {
        oracle: RestoreOracleState;
      };
    };

    const oracle = body.restoreTarget.oracle;
    assert.equal(oracle.status, "blocked");
    assert.equal(oracle.pendingReason, "dynamic-config-changed");
    assert.equal(oracle.lastEvaluatedAt, 1000);
    assert.ok(oracle.lastBlockedReason?.includes("42000ms ago"));
    assert.equal(oracle.lastResult, "blocked");
  });
});
