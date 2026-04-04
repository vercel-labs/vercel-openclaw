/**
 * Smoke tests for GET/PUT /api/firewall.
 *
 * Covers CSRF rejection, firewall state retrieval, and mode transitions.
 *
 * Run: npm test src/app/api/firewall/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  buildAuthPutRequest,
  buildAuthDeleteRequest,
  buildDeleteRequest,
  buildPutRequest,
  getFirewallRoute,
  getFirewallLearnedRoute,
  getFirewallReportRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

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
  }
}

// ===========================================================================
// GET /api/firewall
// ===========================================================================

test("GET /api/firewall: returns current firewall state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        {
          domain: "cdn.vercel.com",
          firstSeenAt: 1000,
          lastSeenAt: 2000,
          hitCount: 5,
        },
      ];
    });

    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      mode: string;
      allowlist: string[];
      learned: Array<{ domain: string }>;
    };
    assert.equal(body.mode, "learning");
    assert.deepEqual(body.allowlist, ["api.openai.com"]);
    assert.equal(body.learned.length, 1);
    assert.equal(body.learned[0].domain, "cdn.vercel.com");
  });
});

test("GET /api/firewall: returns default disabled mode", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { mode: string; wouldBlock: string[] };
    assert.equal(body.mode, "disabled");
    assert.deepEqual(body.wouldBlock, []);
  });
});

test("GET /api/firewall: includes wouldBlock for learning mode", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 3 },
        { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      ];
    });

    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { wouldBlock: string[] };
    assert.deepEqual(body.wouldBlock, ["cdn.vercel.com", "registry.npmjs.org"]);
  });
});

// ===========================================================================
// PUT /api/firewall
// ===========================================================================

test("PUT /api/firewall: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 401);
  });
});

test("PUT /api/firewall: transitions firewall mode with CSRF", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { mode: string } };
    assert.equal(body.firewall.mode, "learning");
  });
});

test("PUT /api/firewall: syncs sandbox policy exactly once for a mode change", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sandbox-123";
    });

    const route = getFirewallRoute();
    const before = h.controller.eventsOfKind("update_network_policy").length;
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { mode: string } };
    assert.equal(body.firewall.mode, "learning");
    assert.equal(
      h.controller.eventsOfKind("update_network_policy").length - before,
      1,
      "expected exactly one sandbox policy update for a mode change",
    );
  });
});

test("PUT /api/firewall: rejects invalid mode with 400", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "invalid" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_MODE");
  });
});

test("PUT /api/firewall: same-mode transition is idempotent (no mutation)", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sandbox-123";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 5000;
      meta.firewall.commandsObserved = 10;
    });

    const route = getFirewallRoute();
    const before = h.controller.eventsOfKind("update_network_policy").length;
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { mode: string; learningStartedAt: number; commandsObserved: number } };
    assert.equal(body.firewall.mode, "learning");
    // learningStartedAt and commandsObserved should be preserved, not reset
    assert.equal(body.firewall.learningStartedAt, 5000);
    assert.equal(body.firewall.commandsObserved, 10);
    assert.equal(
      h.controller.eventsOfKind("update_network_policy").length - before,
      0,
      "expected no sandbox policy update for a same-mode transition",
    );
  });
});

// ===========================================================================
// DELETE /api/firewall/learned
// ===========================================================================

test("DELETE /api/firewall/learned: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getFirewallLearnedRoute();
    const request = buildDeleteRequest(
      "/api/firewall/learned",
      JSON.stringify({ domains: ["cdn.vercel.com"] }),
    );
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 401);
  });
});

test("DELETE /api/firewall/learned: dismisses learned domains", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.learned = [
        {
          domain: "cdn.vercel.com",
          firstSeenAt: 1000,
          lastSeenAt: 2000,
          hitCount: 5,
        },
        {
          domain: "api.openai.com",
          firstSeenAt: 1000,
          lastSeenAt: 2000,
          hitCount: 3,
        },
      ];
    });

    const route = getFirewallLearnedRoute();
    const request = buildAuthDeleteRequest(
      "/api/firewall/learned",
      JSON.stringify({ domains: ["cdn.vercel.com"] }),
    );
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { learned: Array<{ domain: string }> };
    };
    assert.equal(body.firewall.learned.length, 1);
    assert.equal(body.firewall.learned[0].domain, "api.openai.com");
  });
});

test("DELETE /api/firewall/learned: rejects invalid domains with 400", async () => {
  await withTestEnv(async () => {
    const route = getFirewallLearnedRoute();
    const request = buildAuthDeleteRequest(
      "/api/firewall/learned",
      JSON.stringify({ domains: ["not-valid"] }),
    );
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 400);
  });
});

test("DELETE /api/firewall/learned: empty domains array is a no-op", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.learned = [
        {
          domain: "cdn.vercel.com",
          firstSeenAt: 1000,
          lastSeenAt: 2000,
          hitCount: 1,
        },
      ];
    });

    const route = getFirewallLearnedRoute();
    const request = buildAuthDeleteRequest(
      "/api/firewall/learned",
      JSON.stringify({ domains: [] }),
    );
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { learned: Array<{ domain: string }> };
    };
    assert.equal(body.firewall.learned.length, 1);
  });
});

// ===========================================================================
// GET /api/firewall — pure read (no ingest side effect)
// ===========================================================================

test("GET /api/firewall: does not trigger ingest (lastIngestedAt stays null)", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.status = "running";
      meta.sandboxId = "sbx_test";
    });

    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { lastIngestedAt: number | null };
    assert.equal(body.lastIngestedAt, null, "GET /api/firewall should not trigger ingest");
  });
});

// ===========================================================================
// GET /api/firewall/report
// ===========================================================================

test("GET /api/firewall/report: returns full FirewallReport shape", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 1000;
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        { domain: "cdn.vercel.com", firstSeenAt: 1000, lastSeenAt: 2000, hitCount: 5 },
        { domain: "registry.npmjs.org", firstSeenAt: 1000, lastSeenAt: 2000, hitCount: 3 },
      ];
    });

    const route = getFirewallReportRoute();
    const request = buildAuthGetRequest("/api/firewall/report");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      schemaVersion: number;
      generatedAt: number;
      state: { mode: string; allowlist: string[]; learned: Array<{ domain: string }> };
      diagnostics: { mode: string; learningHealth: object; syncStatus: object; ingestionStatus: object; wouldBlockCount: number };
      groupedLearned: Array<{ registrableDomain: string; domains: Array<{ domain: string }> }>;
      wouldBlock: string[];
      lastIngest: object | null;
      lastSync: object | null;
      limitations: string[];
      policyHash: string;
    };

    assert.equal(body.schemaVersion, 1);
    assert.equal(typeof body.generatedAt, "number");
    assert.equal(body.state.mode, "learning");
    assert.deepEqual(body.state.allowlist, ["api.openai.com"]);
    assert.equal(body.state.learned.length, 2);

    // diagnostics
    assert.equal(body.diagnostics.mode, "learning");
    assert.equal(body.diagnostics.wouldBlockCount, 2);

    // wouldBlock
    assert.deepEqual(body.wouldBlock, ["cdn.vercel.com", "registry.npmjs.org"]);

    // groupedLearned has entries
    assert.ok(body.groupedLearned.length > 0);

    // limitations array is non-empty and includes shell observation caveat
    assert.ok(body.limitations.length >= 1);
    assert.ok(
      body.limitations.some((l: string) => l.includes("shell command")),
      "limitations should mention shell command observation",
    );

    // policyHash is a hex string
    assert.match(body.policyHash, /^[a-f0-9]{64}$/);

    // lastIngest and lastSync are null (no operations performed)
    assert.equal(body.lastIngest, null);
    assert.equal(body.lastSync, null);
  });
});

test("GET /api/firewall/report: returns stable policyHash for same state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["b.com", "a.com"];
    });

    const route = getFirewallReportRoute();
    const r1 = await callRoute(route.GET!, buildAuthGetRequest("/api/firewall/report"));
    const r2 = await callRoute(route.GET!, buildAuthGetRequest("/api/firewall/report"));

    const hash1 = (r1.json as { policyHash: string }).policyHash;
    const hash2 = (r2.json as { policyHash: string }).policyHash;
    assert.equal(hash1, hash2, "policyHash should be deterministic for the same state");
  });
});
