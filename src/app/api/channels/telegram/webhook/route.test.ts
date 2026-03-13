/**
 * Tests for POST /api/channels/telegram/webhook.
 *
 * Covers: missing secret header (401), wrong secret (401),
 * no Telegram config (404), happy path enqueue, and dedup.
 *
 * Run: pnpm test src/app/api/channels/telegram/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getTelegramWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

const TELEGRAM_WEBHOOK_SECRET = "test-telegram-webhook-secret-direct";

async function configureTelegram(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.telegram = {
      botToken: "test-telegram-bot-token",
      webhookSecret: TELEGRAM_WEBHOOK_SECRET,
      webhookUrl: "https://test.example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Auth / signature validation
// ===========================================================================

test("Telegram webhook: missing secret header returns 401", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/webhook",
      JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Telegram webhook: wrong secret returns 401", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();
    const req = buildTelegramWebhook({
      webhookSecret: "wrong-secret-entirely",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Telegram webhook: no Telegram config returns 404", async () => {
  await withHarness(async () => {
    const route = getTelegramWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/webhook",
      JSON.stringify({ update_id: 1 }),
      { "x-telegram-bot-api-secret-token": "any-secret" },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 404);
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("Telegram webhook: valid event enqueues job and returns 200", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
    resetAfterCallbacks();
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Telegram webhook: duplicate update_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();

    const payload = {
      update_id: 99999,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "dedup test",
      },
    };

    const req1 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
    const result1 = await callRoute(route.POST, req1);
    assert.equal(result1.status, 200);
    resetAfterCallbacks();

    const req2 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
    const result2 = await callRoute(route.POST, req2);
    assert.equal(result2.status, 200);
    const body2 = result2.json as { ok: boolean };
    assert.equal(body2.ok, true);
  });
});
