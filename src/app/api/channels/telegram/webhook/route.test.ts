/**
 * Tests for POST /api/channels/telegram/webhook.
 *
 * Covers: missing secret header (401), wrong secret (401),
 * no Telegram config (404), happy path enqueue, and dedup.
 *
 * Run: npm test src/app/api/channels/telegram/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { channelDedupKey } from "@/server/channels/keys";
import { getStore } from "@/server/store/store";
import { FakeSandboxHandle } from "@/test-utils/fake-sandbox-controller";
import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getTelegramWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { telegramWebhookWorkflowRuntime } from "@/app/api/channels/telegram/webhook/route";

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
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: passes receivedAtMs to drainChannelWorkflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const beforeMs = Date.now();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);

      // drainChannelWorkflow args: [channel, payload, origin, requestId, bootMessageId, receivedAtMs]
      const args = startMock.mock.calls[0].arguments[1] as unknown[];
      const receivedAtMs = args[5] as number;
      assert.equal(typeof receivedAtMs, "number", "receivedAtMs should be a number");
      assert.ok(receivedAtMs >= beforeMs, "receivedAtMs should be at or after test start");
      assert.ok(receivedAtMs <= Date.now(), "receivedAtMs should be at or before now");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Stale running status — fast path failure triggers wake
// ===========================================================================

test("Telegram webhook: fast path connection failure reconciles status and starts workflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // Simulate stale "running" status — sandbox is actually dead
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-dead";
      meta.snapshotId = "snap-123";
    });
    // Pre-create the sandbox handle with "stopped" status so reconciliation
    // correctly transitions meta.status to "stopped"
    const handle = await h.controller.get({ sandboxId: "sbx-stale-dead" });
    (handle as FakeSandboxHandle).setStatus("stopped");
    // Fast path fetch will throw (no handler registered for the sandbox domain)
    // Boot message succeeds
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      // Workflow should have been started (wake path), not silently dropped
      assert.equal(startMock.mock.callCount(), 1, "workflow start should be called to wake the sandbox");
      // Boot message should be sent after stale-running reconciliation
      const telegramApiCalls = h.fakeFetch
        .requests()
        .filter((entry) => entry.url.includes("api.telegram.org"));
      assert.equal(
        telegramApiCalls.length,
        1,
        "boot message should be sent after stale-running reconciliation",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path non-ok response returns 200 without falling through to workflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-non-ok";
      meta.snapshotId = "snap-telegram-non-ok";
      meta.portUrls = {
        "3000": "https://sbx-telegram-non-ok-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-non-ok-8787.fake.vercel.run",
      };
    });

    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      new Response("bad gateway", { status: 502 }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must NOT start when native handler returned an HTTP response (even non-2xx) to avoid duplicate delivery",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Telegram webhook: duplicate update_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

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

    try {
      const req1 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result1 = await callRoute(route.POST, req1);
      assert.equal(result1.status, 200);
      resetAfterCallbacks();

      const req2 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result2 = await callRoute(route.POST, req2);
      assert.equal(result2.status, 200);
      const body2 = result2.json as { ok: boolean };
      assert.equal(body2.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: unexpected enqueue failure returns 500", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();
    const store = getStore();
    const acquireMock = mock.method(store, "acquireLock", async () => {
      throw new Error("store unavailable");
    });

    try {
      const req = buildTelegramWebhook({
        webhookSecret: TELEGRAM_WEBHOOK_SECRET,
        payload: {
          update_id: 123456,
          message: {
            message_id: 1,
            from: { id: 123, first_name: "Test", is_bot: false },
            chat: { id: 123, type: "private", first_name: "Test" },
            date: Math.floor(Date.now() / 1000),
            text: "hello",
          },
        },
      });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });
    } finally {
      acquireMock.mock.restore();
    }
  });
});

test("Telegram webhook: releases dedup lock and returns 500 when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    const route = getTelegramWebhookRoute();
    const payload = {
      update_id: 99998,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "start fail",
      },
    };
    const dedupKey = channelDedupKey("telegram", String(payload.update_id));
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken, "dedup lock should be released when workflow start fails");
      await getStore().releaseLock(dedupKey, reacquiredToken!);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});
