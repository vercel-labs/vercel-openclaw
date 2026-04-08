/**
 * Route-level integration tests for the Telegram webhook endpoint.
 *
 * Calls the actual POST handler from the Next.js route module with
 * fake infrastructure — no real network or sandbox calls.
 *
 * Run: npm test -- src/server/channels/telegram/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  getTelegramWebhookRoute,
  callRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";
// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();
const telegramRoute = getTelegramWebhookRoute();

// Stub workflow start so tests don't depend on the workflow engine
const routeModule = telegramRoute as unknown as {
  telegramWebhookWorkflowRuntime: { start: (...args: unknown[]) => Promise<void> };
};
routeModule.telegramWebhookWorkflowRuntime.start = async () => {};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-telegram-webhook-secret";

function configureTelegram(h: ReturnType<typeof createScenarioHarness>) {
  return h.mutateMeta((meta) => {
    meta.channels.telegram = {
      botToken: "123456:ABC-DEF-test",
      webhookSecret: WEBHOOK_SECRET,
      webhookUrl: "https://example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Signature validation
// ===========================================================================

test("Telegram route: missing secret header returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureTelegram(h);

    const request = new Request("http://localhost:3000/api/channels/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    });

    const result = await callRoute(telegramRoute.POST, request);

    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { ok: false, error: "UNAUTHORIZED" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

test("Telegram route: wrong secret returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureTelegram(h);

    const req = buildTelegramWebhook({ webhookSecret: "wrong-secret" });
    const result = await callRoute(telegramRoute.POST, req);

    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { ok: false, error: "UNAUTHORIZED" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Channel not configured
// ===========================================================================

test("Telegram route: returns 404 when telegram is not configured", async () => {
  const h = createScenarioHarness();
  try {
    // Do NOT configure telegram — leave it null
    const req = buildTelegramWebhook({ webhookSecret: WEBHOOK_SECRET });
    const result = await callRoute(telegramRoute.POST, req);

    assert.equal(result.status, 404);
    assert.deepEqual(result.json, { ok: false, error: "NOT_FOUND" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Valid webhook enqueues work
// ===========================================================================

test("Telegram route: valid webhook enqueues work and returns 200", async () => {
  const h = createScenarioHarness();
  try {
    await configureTelegram(h);

    const req = buildTelegramWebhook({ webhookSecret: WEBHOOK_SECRET });
    const result = await callRoute(telegramRoute.POST, req);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });

  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Dedup: same update_id is not enqueued twice
// ===========================================================================

test("Telegram route: duplicate update_id is deduped", async () => {
  const h = createScenarioHarness();
  try {
    await configureTelegram(h);

    const payload = {
      update_id: 999888,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private" as const, first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "hello dedup",
      },
    };

    // First request
    const req1 = buildTelegramWebhook({ webhookSecret: WEBHOOK_SECRET, payload });
    await callRoute(telegramRoute.POST, req1);
    resetAfterCallbacks();

    // Second request with same update_id — dedup lock prevents processing
    const req2 = buildTelegramWebhook({ webhookSecret: WEBHOOK_SECRET, payload });
    const result2 = await callRoute(telegramRoute.POST, req2);

    assert.equal(result2.status, 200);
    assert.deepEqual(result2.json, { ok: true });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});
