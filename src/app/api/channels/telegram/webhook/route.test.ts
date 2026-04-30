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
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";

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

      // drainChannelWorkflow v1 envelope carries receivedAtMs as a field.
      const args = startMock.mock.calls[0].arguments[1] as unknown[];
      assert.equal(args.length, 1, "workflow expects a single v1 envelope");
      const envelope = args[0] as { version?: number; receivedAtMs?: number };
      assert.equal(envelope.version, 1, "envelope must be v1");
      const receivedAtMs = envelope.receivedAtMs as number;
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
      // Fast-path requires telegramListenerReady=true to fire.  The test
      // exercises the network-failure reconcile path, which only runs inside
      // the fast-path's catch branch, so the gate must be satisfied here.
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
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

// ===========================================================================
// Fast-path gate: requires lastRestoreMetrics.telegramListenerReady === true
// ===========================================================================

test("Telegram webhook: fast path does NOT fire when telegramListenerReady is missing", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // status=running + sandbox + portUrls present but lastRestoreMetrics is missing.
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-missing";
      meta.snapshotId = "snap-telegram-gate-missing";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-missing-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-missing-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = null;
    });

    let fastPathForwardCount = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      fastPathForwardCount += 1;
      return new Response("ok", { status: 200 });
    });
    // Boot message responder for the workflow fallthrough path.
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardCount,
        0,
        "fast-path must NOT forward when lastRestoreMetrics is missing",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "request must fall through to workflow path when listener readiness is unproven",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path does NOT fire when telegramListenerReady !== true", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // status=running but listener readiness was NOT proven during restore.
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-false";
      meta.snapshotId = "snap-telegram-gate-false";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-false-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-false-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: false,
      };
    });

    let fastPathForwardCount = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      fastPathForwardCount += 1;
      return new Response("ok", { status: 200 });
    });
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardCount,
        0,
        "fast-path must NOT forward when telegramListenerReady !== true",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "request must fall through to workflow path when listener readiness is not true",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path fires when status=running AND telegramListenerReady=true", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-ready";
      meta.snapshotId = "snap-telegram-gate-ready";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-ready-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-ready-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    let capturedForwardUrl: string | null = null;
    h.fakeFetch.onPost(/telegram-webhook$/, (url) => {
      capturedForwardUrl = url;
      return new Response("ok", { status: 200 });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      const forwardUrl = capturedForwardUrl as string | null;
      if (typeof forwardUrl !== "string") {
        assert.fail(
          "fast-path should forward to the native handler on port 8787",
        );
      }
      assert.ok(
        forwardUrl.includes("8787"),
        `forward should hit the 8787 surface (got ${forwardUrl})`,
      );
      assert.ok(
        forwardUrl.endsWith("/telegram-webhook"),
        `forward should end with /telegram-webhook (got ${forwardUrl})`,
      );
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must NOT start when fast-path succeeds",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path refreshes AI Gateway token before native forward", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _resetLogBuffer();
    _setAiGatewayTokenOverrideForTesting("fresh-telegram-fast-path-token");
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-token-refresh";
      meta.snapshotId = "snap-telegram-token-refresh";
      meta.portUrls = {
        "3000": "https://sbx-telegram-token-refresh-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-token-refresh-8787.fake.vercel.run",
      };
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 60;
      meta.lastTokenSource = "oidc";
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });
    await h.controller.get({ sandboxId: "sbx-telegram-token-refresh" });

    let networkPolicyCountAtForward = -1;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      networkPolicyCountAtForward =
        h.controller.getHandle("sbx-telegram-token-refresh")?.networkPolicies.length ?? -1;
      return new Response("ok", { status: 200 });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(
        networkPolicyCountAtForward,
        1,
        "AI Gateway network policy must be refreshed before native Telegram forward",
      );
      assert.ok(
        getServerLogs().some((entry) => entry.message === "channels.fast_path_token_refresh"),
        "token refresh outcome should be logged for fast-path triage",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("Telegram webhook: fast path non-ok response falls through to workflow wake path", async () => {
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
      // Fast-path requires telegramListenerReady=true to fire.
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
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
        1,
        "workflow MUST start when native handler returned non-2xx so the update is not silently dropped",
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

test("Telegram webhook: deletes boot message and releases dedup lock when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const bootMessageId = 77;
    const sendCalls: string[] = [];
    const deleteCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendCalls.push(url);
      return Response.json({ ok: true, result: { message_id: bootMessageId } });
    });
    h.fakeFetch.onPost(/api\.telegram\.org.*\/deleteMessage$/, (url) => {
      deleteCalls.push(url);
      return Response.json({ ok: true, result: true });
    });
    const route = getTelegramWebhookRoute();
    const payload = {
      update_id: 99997,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "boot cleanup",
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

      assert.equal(sendCalls.length, 1, "boot message should be sent once");
      assert.equal(deleteCalls.length, 1, "boot message should be deleted once on workflow start failure");

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken, "dedup lock should still be released when workflow start fails");
      await getStore().releaseLock(dedupKey, reacquiredToken!);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
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
