/**
 * Tests for GET /api/channels/slack/manifest.
 *
 * Covers: auth enforcement in sign-in-with-vercel mode (401 without session),
 * happy path with host header, and happy path with NEXT_PUBLIC_BASE_DOMAIN env.
 *
 * Run: npm test src/app/api/channels/slack/manifest/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildGetRequest,
  buildAuthGetRequest,
  getSlackManifestRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement (sign-in-with-vercel mode)
// ===========================================================================

test("Slack manifest: GET without session in sign-in-with-vercel mode returns 401", async () => {
  await withHarness(async () => {
    const route = getSlackManifestRoute();
    const req = buildGetRequest("/api/channels/slack/manifest");
    const result = await callRoute(route.GET!, req);
    assert.equal(result.status, 401);
  }, { authMode: "sign-in-with-vercel" });
});

// ===========================================================================
// Happy path (admin-secret mode — no auth needed)
// ===========================================================================

test("Slack manifest: GET returns manifest and createAppUrl", async () => {
  await withHarness(async () => {
    const route = getSlackManifestRoute();
    const req = buildAuthGetRequest("/api/channels/slack/manifest");
    const result = await callRoute(route.GET!, req);

    assert.equal(result.status, 200);
    const body = result.json as {
      manifest: {
        display_information: { name: string };
        oauth_config: { scopes: { bot: string[] } };
        settings: { event_subscriptions: { request_url: string; bot_events: string[] } };
      };
      createAppUrl: string;
    };

    assert.equal(body.manifest.display_information.name, "OpenClaw Gateway");
    assert.ok(body.manifest.oauth_config.scopes.bot.includes("chat:write"));
    assert.ok(body.manifest.settings.event_subscriptions.bot_events.includes("message.im"));
    assert.ok(body.manifest.settings.event_subscriptions.request_url.endsWith("/api/channels/slack/webhook"));
    assert.ok(body.createAppUrl.startsWith("https://api.slack.com/apps"));
  });
});

test("Slack manifest: uses NEXT_PUBLIC_BASE_DOMAIN when set", async () => {
  await withHarness(async () => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "custom.example.com";
    try {
      const route = getSlackManifestRoute();
      const req = buildAuthGetRequest("/api/channels/slack/manifest");
      const result = await callRoute(route.GET!, req);

      assert.equal(result.status, 200);
      const body = result.json as {
        manifest: { settings: { event_subscriptions: { request_url: string } } };
      };
      assert.ok(
        body.manifest.settings.event_subscriptions.request_url.includes("custom.example.com"),
      );
    } finally {
      delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
    }
  });
});
