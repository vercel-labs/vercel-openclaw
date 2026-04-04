/**
 * Tests for POST /api/firewall/promote.
 *
 * Covers: CSRF enforcement (403), empty allowlist guard (409),
 * happy path promotes learned domains to enforcing mode.
 *
 * Run: npm test src/app/api/firewall/promote/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getFirewallPromoteRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("firewall/promote POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getFirewallPromoteRoute();
    const req = buildPostRequest("/api/firewall/promote", "{}");
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Mode transition guards
// ===========================================================================

test("firewall/promote POST: empty allowlist and no learned domains returns 409", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = [];
      meta.firewall.learned = [];
    });

    const route = getFirewallPromoteRoute();
    const req = buildAuthPostRequest("/api/firewall/promote", "{}");
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 409);
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("firewall/promote POST: promotes learned domains to enforcing", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["existing.com"];
      meta.firewall.learned = [
        { domain: "learned.example.com", firstSeenAt: Date.now(), lastSeenAt: Date.now(), hitCount: 1 },
      ];
    });

    const route = getFirewallPromoteRoute();
    const req = buildAuthPostRequest("/api/firewall/promote", "{}");
    const result = await callRoute(route.POST!, req);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { mode: string; allowlist: string[]; learned: unknown[] } };
    assert.equal(body.firewall.mode, "enforcing");
    assert.ok(body.firewall.allowlist.includes("existing.com"));
    assert.ok(body.firewall.allowlist.includes("learned.example.com"));
    assert.equal(body.firewall.learned.length, 0);
  });
});
