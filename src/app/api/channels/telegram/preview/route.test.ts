/**
 * Tests for POST /api/channels/telegram/preview.
 *
 * Covers: auth enforcement (403 without CSRF), missing botToken (400),
 * happy path with mocked Telegram API, and Telegram API error handling.
 *
 * Run: npm test src/app/api/channels/telegram/preview/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getTelegramPreviewRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("Telegram preview: POST without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getTelegramPreviewRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/preview",
      JSON.stringify({ botToken: "123:ABC" }),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

test("Telegram preview: missing botToken returns 400", async () => {
  await withHarness(async () => {
    const route = getTelegramPreviewRoute();
    const req = buildAuthPostRequest(
      "/api/channels/telegram/preview",
      JSON.stringify({}),
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 400);
  });
});

// ===========================================================================
// Happy path (mocked fetch)
// ===========================================================================

test("Telegram preview: valid botToken returns bot info", async () => {
  await withHarness(async (h) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/api\.telegram\.org\/bot.*\/getMe/, () =>
      Response.json({
        ok: true,
        result: {
          id: 987654,
          first_name: "TestBot",
          username: "test_bot",
          is_bot: true,
        },
      }),
    );

    try {
      const route = getTelegramPreviewRoute();
      const req = buildAuthPostRequest(
        "/api/channels/telegram/preview",
        JSON.stringify({ botToken: "123456:ABC-DEF" }),
      );
      const result = await callRoute(route.POST!, req);

      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean; bot: { id: number; first_name: string; username: string } };
      assert.equal(body.ok, true);
      assert.equal(body.bot.id, 987654);
      assert.equal(body.bot.first_name, "TestBot");
      assert.equal(body.bot.username, "test_bot");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// Telegram API error
// ===========================================================================

test("Telegram preview: Telegram API error returns error", async () => {
  await withHarness(async (h) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/api\.telegram\.org\/bot.*\/getMe/, () =>
      Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }),
    );

    try {
      const route = getTelegramPreviewRoute();
      const req = buildAuthPostRequest(
        "/api/channels/telegram/preview",
        JSON.stringify({ botToken: "bad-token" }),
      );
      const result = await callRoute(route.POST!, req);
      assert.ok(result.status >= 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
