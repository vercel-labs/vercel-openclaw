/**
 * Tests for POST /api/channels/slack/test.
 *
 * Covers: auth enforcement (403 without CSRF), missing botToken (400),
 * happy path with mocked Slack API, and Slack API error handling.
 *
 * Run: npm test src/app/api/channels/slack/test/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getSlackTestRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("Slack test: POST without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getSlackTestRoute();
    const req = buildPostRequest(
      "/api/channels/slack/test",
      JSON.stringify({ botToken: "xoxb-test" }),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

test("Slack test: missing botToken returns 400", async () => {
  await withHarness(async () => {
    const route = getSlackTestRoute();
    const req = buildAuthPostRequest(
      "/api/channels/slack/test",
      JSON.stringify({}),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 400);
  });
});

test("Slack test: empty botToken returns 400", async () => {
  await withHarness(async () => {
    const route = getSlackTestRoute();
    const req = buildAuthPostRequest(
      "/api/channels/slack/test",
      JSON.stringify({ botToken: "  " }),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 400);
  });
});

// ===========================================================================
// Happy path (mocked fetch)
// ===========================================================================

test("Slack test: valid botToken returns bot metadata", async () => {
  await withHarness(async (h) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/slack\.com\/api\/auth\.test/, () =>
      Response.json({
        ok: true,
        team: "Test Team",
        user: "test-bot",
        bot_id: "B123456",
      }),
    );

    try {
      const route = getSlackTestRoute();
      const req = buildAuthPostRequest(
        "/api/channels/slack/test",
        JSON.stringify({ botToken: "xoxb-valid-token" }),
      );
      const result = await callRoute(route.POST!, req);

      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean; team: string; user: string; botId: string };
      assert.equal(body.ok, true);
      assert.equal(body.team, "Test Team");
      assert.equal(body.user, "test-bot");
      assert.equal(body.botId, "B123456");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// Slack API error
// ===========================================================================

test("Slack test: Slack API error returns 400", async () => {
  await withHarness(async (h) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/slack\.com\/api\/auth\.test/, () =>
      Response.json({ ok: false, error: "invalid_auth" }),
    );

    try {
      const route = getSlackTestRoute();
      const req = buildAuthPostRequest(
        "/api/channels/slack/test",
        JSON.stringify({ botToken: "xoxb-bad-token" }),
      );
      const result = await callRoute(route.POST!, req);
      assert.equal(result.status, 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
