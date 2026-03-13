/**
 * Tests for GET /api/firewall/diagnostics.
 *
 * Run: pnpm test src/app/api/firewall/diagnostics/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  getFirewallDiagnosticsRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import type { FirewallDiagnostics } from "@/server/firewall/state";

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
  }
}

// ===========================================================================
// GET /api/firewall/diagnostics
// ===========================================================================

test("GET /api/firewall/diagnostics: returns all diagnostic fields for default state", async () => {
  await withTestEnv(async () => {
    const route = getFirewallDiagnosticsRoute();
    const request = buildAuthGetRequest("/api/firewall/diagnostics");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as FirewallDiagnostics;

    assert.equal(body.mode, "disabled");

    // learningHealth defaults
    assert.equal(body.learningHealth.durationMs, null);
    assert.equal(body.learningHealth.commandsObserved, 0);
    assert.equal(body.learningHealth.uniqueDomains, 0);
    assert.equal(body.learningHealth.lastIngestedAt, null);
    assert.equal(body.learningHealth.stalenessMs, null);

    // syncStatus defaults
    assert.equal(body.syncStatus.lastAppliedAt, null);
    assert.equal(body.syncStatus.lastFailedAt, null);
    assert.equal(body.syncStatus.lastReason, null);

    // ingestionStatus defaults
    assert.equal(body.ingestionStatus.lastSkipReason, null);
    assert.equal(body.ingestionStatus.consecutiveSkips, 0);

    assert.equal(body.wouldBlockCount, 0);
  });
});

test("GET /api/firewall/diagnostics: learningHealth populated in learning mode", async () => {
  await withTestEnv(async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = now - 60_000;
      meta.firewall.commandsObserved = 42;
      meta.firewall.lastIngestedAt = now - 5_000;
      meta.firewall.learned = [
        { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 3 },
      ];
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const route = getFirewallDiagnosticsRoute();
    const request = buildAuthGetRequest("/api/firewall/diagnostics");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as FirewallDiagnostics;

    assert.equal(body.mode, "learning");
    assert.ok(body.learningHealth.durationMs! >= 59_000);
    assert.equal(body.learningHealth.commandsObserved, 42);
    assert.equal(body.learningHealth.uniqueDomains, 2);
    assert.equal(body.learningHealth.lastIngestedAt, now - 5_000);
    assert.ok(body.learningHealth.stalenessMs! >= 4_000);
    // cdn.vercel.com is learned but not in allowlist
    assert.equal(body.wouldBlockCount, 1);
  });
});

test("GET /api/firewall/diagnostics: stalenessMs is null when not learning", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.lastIngestedAt = Date.now() - 10_000;
    });

    const route = getFirewallDiagnosticsRoute();
    const request = buildAuthGetRequest("/api/firewall/diagnostics");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as FirewallDiagnostics;
    assert.equal(body.learningHealth.stalenessMs, null);
    assert.equal(body.learningHealth.durationMs, null);
  });
});

test("GET /api/firewall/diagnostics: syncStatus populated from metadata", async () => {
  await withTestEnv(async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.firewall.lastSyncAppliedAt = now - 30_000;
      meta.firewall.lastSyncFailedAt = now - 60_000;
      meta.firewall.lastSyncReason = "policy-applied";
    });

    const route = getFirewallDiagnosticsRoute();
    const request = buildAuthGetRequest("/api/firewall/diagnostics");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as FirewallDiagnostics;
    assert.equal(body.syncStatus.lastAppliedAt, now - 30_000);
    assert.equal(body.syncStatus.lastFailedAt, now - 60_000);
    assert.equal(body.syncStatus.lastReason, "policy-applied");
  });
});

test("GET /api/firewall/diagnostics: ingestionStatus populated from metadata", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.lastIngestionSkipReason = "throttled";
      meta.firewall.ingestionSkipCount = 5;
    });

    const route = getFirewallDiagnosticsRoute();
    const request = buildAuthGetRequest("/api/firewall/diagnostics");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as FirewallDiagnostics;
    assert.equal(body.ingestionStatus.lastSkipReason, "throttled");
    assert.equal(body.ingestionStatus.consecutiveSkips, 5);
  });
});
