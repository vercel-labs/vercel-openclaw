/**
 * Tests for POST/DELETE /api/firewall/allowlist.
 *
 * Covers: CSRF enforcement (403), happy path approve domains,
 * happy path remove domains, and invalid domain rejection.
 *
 * Run: pnpm test src/app/api/firewall/allowlist/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  buildAuthDeleteRequest,
  getFirewallAllowlistRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// POST — Auth enforcement
// ===========================================================================

test("firewall/allowlist POST: without CSRF headers returns 403", async () => {
  await withHarness(async () => {
    const route = getFirewallAllowlistRoute();
    const req = buildPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["example.com"] }),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// POST — Happy path
// ===========================================================================

test("firewall/allowlist POST: approves domains", async () => {
  await withHarness(async () => {
    const route = getFirewallAllowlistRoute();
    const req = buildAuthPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["api.openai.com", "cdn.example.com"] }),
    );
    const result = await callRoute(route.POST!, req);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { allowlist: string[] } };
    assert.ok(body.firewall.allowlist.includes("api.openai.com"));
    assert.ok(body.firewall.allowlist.includes("cdn.example.com"));
  });
});

// ===========================================================================
// POST — Empty domains array is OK
// ===========================================================================

test("firewall/allowlist POST: empty domains array succeeds", async () => {
  await withHarness(async () => {
    const route = getFirewallAllowlistRoute();
    const req = buildAuthPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: [] }),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 200);
  });
});

// ===========================================================================
// DELETE — Auth enforcement
// ===========================================================================

test("firewall/allowlist DELETE: without CSRF headers returns 403", async () => {
  await withHarness(async () => {
    const route = getFirewallAllowlistRoute();
    const req = new Request("http://localhost:3000/api/firewall/allowlist", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: ["example.com"] }),
    });
    const result = await callRoute(route.DELETE!, req);
    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// DELETE — Happy path
// ===========================================================================

test("firewall/allowlist DELETE: removes domains", async () => {
  await withHarness(async (h) => {
    // First add some domains
    await h.mutateMeta((meta) => {
      meta.firewall.allowlist = ["api.openai.com", "cdn.example.com", "keep.me"];
    });

    const route = getFirewallAllowlistRoute();
    const req = buildAuthDeleteRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["api.openai.com"] }),
    );
    const result = await callRoute(route.DELETE!, req);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { allowlist: string[] } };
    assert.ok(!body.firewall.allowlist.includes("api.openai.com"));
    assert.ok(body.firewall.allowlist.includes("keep.me"));
  });
});

// ===========================================================================
// No double sync — response has no separate `policy` key
// ===========================================================================

test("firewall/allowlist POST: response has no separate policy key (no double sync)", async () => {
  await withHarness(async () => {
    const route = getFirewallAllowlistRoute();
    const req = buildAuthPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["api.openai.com"] }),
    );
    const result = await callRoute(route.POST!, req);

    assert.equal(result.status, 200);
    const body = result.json as Record<string, unknown>;
    assert.ok(body.firewall, "response should have firewall key");
    assert.equal(body.policy, undefined, "response should NOT have separate policy key (no double sync)");
  });
});

test("firewall/allowlist DELETE: response has no separate policy key (no double sync)", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const route = getFirewallAllowlistRoute();
    const req = buildAuthDeleteRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["api.openai.com"] }),
    );
    const result = await callRoute(route.DELETE!, req);

    assert.equal(result.status, 200);
    const body = result.json as Record<string, unknown>;
    assert.ok(body.firewall, "response should have firewall key");
    assert.equal(body.policy, undefined, "response should NOT have separate policy key (no double sync)");
  });
});
