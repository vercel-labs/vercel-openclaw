import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getTelegramSyncCommandsRoute,
} from "@/test-utils/route-caller";

test("Telegram sync-commands: POST without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getTelegramSyncCommandsRoute();
    const req = buildPostRequest("/api/channels/telegram/sync-commands", "{}");
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 401);
  });
});

test("Telegram sync-commands: no Telegram config returns 409", async () => {
  await withHarness(async () => {
    const route = getTelegramSyncCommandsRoute();
    const req = buildAuthPostRequest("/api/channels/telegram/sync-commands", "{}");
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 409);
    assert.equal((result.json as { error: string }).error, "TELEGRAM_NOT_CONFIGURED");
  });
});

test("Telegram sync-commands: syncs commands and stores success state", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "123456:ABC-DEF-test",
        webhookSecret: "test-secret",
        webhookUrl: "https://example.com/api/channels/telegram/webhook",
        botUsername: "openclaw_bot",
        configuredAt: 1_000,
        commandSyncStatus: "unsynced",
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bot.*\/setMyCommands/, () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      const route = getTelegramSyncCommandsRoute();
      const req = buildAuthPostRequest("/api/channels/telegram/sync-commands", "{}");
      const result = await callRoute(route.POST!, req);

      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true, commandCount: 8 });

      const meta = await h.getMeta();
      assert.equal(meta.channels.telegram?.commandSyncStatus, "synced");
      assert.equal(meta.channels.telegram?.commandSyncError, undefined);
      assert.equal(typeof meta.channels.telegram?.commandsRegisteredAt, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Telegram sync-commands: stores error state when Telegram API fails", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "123456:ABC-DEF-test",
        webhookSecret: "test-secret",
        webhookUrl: "https://example.com/api/channels/telegram/webhook",
        botUsername: "openclaw_bot",
        configuredAt: 1_000,
        commandSyncStatus: "unsynced",
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bot.*\/setMyCommands/, () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 500,
          description: "sync failed",
        }),
        { status: 500 },
      ),
    );

    try {
      const route = getTelegramSyncCommandsRoute();
      const req = buildAuthPostRequest("/api/channels/telegram/sync-commands", "{}");
      const result = await callRoute(route.POST!, req);

      assert.ok(result.status >= 400);

      const meta = await h.getMeta();
      assert.equal(meta.channels.telegram?.commandSyncStatus, "error");
      assert.match(meta.channels.telegram?.commandSyncError ?? "", /sync failed/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
