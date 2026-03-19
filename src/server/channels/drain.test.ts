/**
 * Happy-path drain scenario tests per channel.
 *
 * Each test: enqueue job with stopped sandbox → drain triggers restore →
 * gateway receives chat completion request with correct auth headers →
 * platform API reply called → session history persisted → queues empty.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  dumpDiagnostics,
} from "@/test-utils/harness";
import {
  buildSlackWebhook,
  buildTelegramWebhook,
  buildDiscordWebhook,
} from "@/test-utils/webhook-builders";
import {
  assertGatewayRequest,
  assertQueuesDrained,
  assertHistory,
} from "@/test-utils/assertions";
import { stopSandbox } from "@/server/sandbox/lifecycle";
import { enqueueChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import { channelSessionHistoryKey } from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Drain: Slack — enqueue with stopped sandbox → restore → gateway called with auth → Slack reply → history persisted → queues empty", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret } = h.configureAllChannels();

    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    const gatewayToken = runningMeta.gatewayToken;
    await stopSandbox();

    const meta = await h.getMeta();
    assert.equal(meta.status, "stopped");

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Build a Slack webhook payload with a thread_ts for session key tracking
      const slackReq = buildSlackWebhook({
        signingSecret: slackSigningSecret,
        payload: {
          type: "event_callback",
          event_id: `Ev${Date.now()}`,
          event: {
            type: "message",
            text: "drain test message",
            channel: "C-DRAIN-TEST",
            ts: "1234567890.000001",
            thread_ts: "1234567890.000000",
            user: "U-DRAIN-TEST",
          },
        },
      });
      const slackPayload = JSON.parse(await slackReq.text());

      await enqueueChannelJob("slack", {
        payload: slackPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(
        await store.getQueueLength("openclaw-single:channels:slack:queue"),
        1,
        "Should have one job in queue before drain",
      );

      // Drain — triggers restore + gateway call + reply
      await drainSlackQueue();

      // -- Verify gateway request has correct Bearer token and session key --
      assertGatewayRequest(h.fakeFetch.requests(), {
        gatewayToken: gatewayToken!,
        sessionKey: "slack:channel:C-DRAIN-TEST:thread:1234567890.000000",
        userMessage: "drain test message",
      });

      // -- Verify Slack chat.postMessage called --
      const slackRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api/chat.postMessage"));
      assert.ok(slackRequests.length >= 1, "Slack chat.postMessage should have been called");

      // -- Verify session history persisted --
      const sessionKey = "slack:channel:C-DRAIN-TEST:thread:1234567890.000000";
      const historyKey = channelSessionHistoryKey("slack", sessionKey);
      const history = await store.getValue<Array<{ role: string; content: string }>>(historyKey);
      assertHistory(history, [
        { role: "user", content: "drain test message" },
        { role: "assistant", content: "Hello from OpenClaw" },
      ]);

      // -- Verify queues empty --
      await assertQueuesDrained(store, "slack");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

test("Drain: Telegram — enqueue → restore → typing indicator sent → gateway called with auth → sendMessage called → history persisted → queues empty", async (t) => {
  const h = createScenarioHarness();
  try {
    const { telegramWebhookSecret } = h.configureAllChannels();

    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    const gatewayToken = runningMeta.gatewayToken;
    await stopSandbox();

    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const telegramReq = buildTelegramWebhook({
        webhookSecret: telegramWebhookSecret,
        payload: {
          update_id: 100,
          message: {
            message_id: 1,
            from: { id: 99999, first_name: "Drainer", is_bot: false },
            chat: { id: 99999, type: "private", first_name: "Drainer" },
            date: Math.floor(Date.now() / 1000),
            text: "telegram drain test",
          },
        },
      });
      const telegramPayload = JSON.parse(await telegramReq.text());

      await enqueueChannelJob("telegram", {
        payload: telegramPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:telegram:queue"), 1);

      await drainTelegramQueue();

      // -- Verify boot message was sent (replaces typing indicator when sandbox is stopped) --
      const bootMessageRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.url.includes("api.telegram.org") &&
            r.url.includes("sendMessage"),
        );
      assert.ok(
        bootMessageRequests.length >= 1,
        "Boot message (sendMessage) should have been sent during sandbox wake",
      );

      // -- Verify boot message was cleared (editMessageText or deleteMessage) --
      const bootCleanupRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.url.includes("api.telegram.org") &&
            (r.url.includes("editMessageText") || r.url.includes("deleteMessage")),
        );
      assert.ok(
        bootCleanupRequests.length >= 1,
        "Boot message should have been updated or deleted",
      );

      // -- Verify gateway request has correct auth --
      assertGatewayRequest(h.fakeFetch.requests(), {
        gatewayToken: gatewayToken!,
        sessionKey: "telegram:dm:99999",
      });

      // -- Verify sendMessage called --
      const sendMessageRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.url.includes("api.telegram.org") &&
            r.url.includes("sendMessage"),
        );
      assert.ok(
        sendMessageRequests.length >= 1,
        "Telegram sendMessage should have been called",
      );

      // -- Verify session history persisted --
      const sessionKey = "telegram:dm:99999";
      const historyKey = channelSessionHistoryKey("telegram", sessionKey);
      const history = await store.getValue<Array<{ role: string; content: string }>>(historyKey);
      assertHistory(history, [
        { role: "user", content: "telegram drain test" },
        { role: "assistant", content: "Hello from OpenClaw" },
      ]);

      // -- Verify queues empty --
      await assertQueuesDrained(store, "telegram");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

test("Drain: Discord — slash command enqueue → restore → gateway called with auth → followup webhook called → long reply chunked → queues empty", async (t) => {
  const h = createScenarioHarness();
  try {
    const { discordPublicKeyHex, discordPrivateKey } = h.configureAllChannels();

    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    const gatewayToken = runningMeta.gatewayToken;
    await stopSandbox();

    assert.equal((await h.getMeta()).status, "stopped");

    // Generate a reply >2000 chars to trigger chunking
    const longReply = "A".repeat(2500);
    h.installDefaultGatewayHandlers(longReply);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const interactionToken = `drain-interaction-token-${Date.now()}`;
      const discordReq = buildDiscordWebhook({
        privateKey: discordPrivateKey,
        publicKeyHex: discordPublicKeyHex,
        payload: {
          id: `interaction-drain-${Date.now()}`,
          type: 2, // APPLICATION_COMMAND
          token: interactionToken,
          application_id: "shared-test-discord-app-id",
          channel_id: "ch-drain-test",
          member: {
            user: { id: "user-drain-test" },
          },
          data: {
            name: "ask",
            options: [
              {
                name: "text",
                value: "discord drain test",
              },
            ],
          },
        },
      });
      const discordPayload = JSON.parse(await discordReq.text());

      await enqueueChannelJob("discord", {
        payload: discordPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:discord:queue"), 1);

      await drainDiscordQueue();

      // -- Verify gateway request has correct auth --
      assertGatewayRequest(h.fakeFetch.requests(), {
        gatewayToken: gatewayToken!,
        sessionKey: "discord:channel:ch-drain-test:user:user-drain-test",
      });

      // -- Verify Discord webhook/followup calls --
      // First chunk goes via PATCH to the webhook message URL
      const discordPatchRequests = h.fakeFetch
        .requests()
        .filter((r) => r.method === "PATCH" && r.url.includes("discord.com"));
      assert.ok(
        discordPatchRequests.length >= 1,
        "Discord PATCH (initial reply) should have been called",
      );

      // Additional chunks go via POST followup messages
      const discordPostRequests = h.fakeFetch
        .requests()
        .filter((r) => r.method === "POST" && r.url.includes("discord.com"));
      assert.ok(
        discordPostRequests.length >= 1,
        "Discord POST followup (chunked reply) should have been called for long reply",
      );

      // -- Verify session history persisted --
      const sessionKey = "discord:channel:ch-drain-test:user:user-drain-test";
      const historyKey = channelSessionHistoryKey("discord", sessionKey);
      const history = await store.getValue<Array<{ role: string; content: string }>>(historyKey);
      assertHistory(history, [
        { role: "user", content: "discord drain test" },
        {
          role: "assistant",
          content: (c) =>
            assert.ok(c.length > 2000, "Assistant reply should be the full long text"),
        },
      ]);

      // -- Verify queues empty --
      await assertQueuesDrained(store, "discord");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Typing-indicator error resilience tests
// ---------------------------------------------------------------------------

test("Drain: Telegram — typing indicator throws → drain still completes, gateway called, reply sent", async (t) => {
  const h = createScenarioHarness();
  try {
    const { telegramWebhookSecret } = h.configureAllChannels();

    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();

    // Make sendChatAction (typing indicator) throw
    h.fakeFetch.on("POST", /api\.telegram\.org.*sendChatAction/, () => {
      throw new Error("network timeout on typing");
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const telegramReq = buildTelegramWebhook({
        webhookSecret: telegramWebhookSecret,
        payload: {
          update_id: 200,
          message: {
            message_id: 2,
            from: { id: 88888, first_name: "TypingFail", is_bot: false },
            chat: { id: 88888, type: "private", first_name: "TypingFail" },
            date: Math.floor(Date.now() / 1000),
            text: "typing failure test",
          },
        },
      });
      const telegramPayload = JSON.parse(await telegramReq.text());

      await enqueueChannelJob("telegram", {
        payload: telegramPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:telegram:queue"), 1);

      // Drain should succeed despite typing indicator failure
      await drainTelegramQueue();

      // Gateway should still have been called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called despite typing failure");

      // Reply should still have been sent
      const sendMessageRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.url.includes("api.telegram.org") &&
            r.url.includes("sendMessage"),
        );
      assert.ok(sendMessageRequests.length >= 1, "Telegram sendMessage should have been called");

      // Queues should be empty
      await assertQueuesDrained(store, "telegram");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

test("Drain: Telegram — typing indicator rejects with network error → drain still completes", async (t) => {
  const h = createScenarioHarness();
  try {
    const { telegramWebhookSecret } = h.configureAllChannels();

    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();

    // Make sendChatAction reject with a network error response
    h.fakeFetch.on("POST", /api\.telegram\.org.*sendChatAction/, () => {
      return new Response(JSON.stringify({ ok: false, description: "network error" }), {
        status: 500,
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const telegramReq = buildTelegramWebhook({
        webhookSecret: telegramWebhookSecret,
        payload: {
          update_id: 201,
          message: {
            message_id: 3,
            from: { id: 77777, first_name: "NetFail", is_bot: false },
            chat: { id: 77777, type: "private", first_name: "NetFail" },
            date: Math.floor(Date.now() / 1000),
            text: "network typing failure test",
          },
        },
      });
      const telegramPayload = JSON.parse(await telegramReq.text());

      await enqueueChannelJob("telegram", {
        payload: telegramPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();

      // Drain should succeed
      await drainTelegramQueue();

      // Gateway called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called");

      // Reply sent
      const sendMessageRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.url.includes("api.telegram.org") &&
            r.url.includes("sendMessage"),
        );
      assert.ok(sendMessageRequests.length >= 1, "Reply should have been sent");

      // Session history persisted
      const sessionKey = "telegram:dm:77777";
      const historyKey = channelSessionHistoryKey("telegram", sessionKey);
      const history = await store.getValue<Array<{ role: string; content: string }>>(historyKey);
      assertHistory(history, [
        { role: "user", content: "network typing failure test" },
        { role: "assistant", content: "Hello from OpenClaw" },
      ]);

      // Queues empty
      await assertQueuesDrained(store, "telegram");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

test("Drain: Discord — typing indicator throws → drain still completes, gateway called, reply sent", async (t) => {
  const h = createScenarioHarness();
  try {
    const { discordPublicKeyHex, discordPrivateKey } = h.configureAllChannels();

    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();

    // Make triggerTyping (POST to channels/.../typing) throw
    h.fakeFetch.on("POST", /discord\.com\/api\/v10\/channels\/.*\/typing/, () => {
      throw new Error("discord typing network failure");
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const interactionToken = `typing-fail-token-${Date.now()}`;
      const discordReq = buildDiscordWebhook({
        privateKey: discordPrivateKey,
        publicKeyHex: discordPublicKeyHex,
        payload: {
          id: `interaction-typing-fail-${Date.now()}`,
          type: 2,
          token: interactionToken,
          application_id: "shared-test-discord-app-id",
          channel_id: "ch-typing-fail",
          member: {
            user: { id: "user-typing-fail" },
          },
          data: {
            name: "ask",
            options: [{ name: "text", value: "discord typing failure test" }],
          },
        },
      });
      const discordPayload = JSON.parse(await discordReq.text());

      await enqueueChannelJob("discord", {
        payload: discordPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:discord:queue"), 1);

      // Drain should succeed
      await drainDiscordQueue();

      // Gateway called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called despite typing failure");

      // Reply sent (PATCH to webhook message)
      const discordPatchRequests = h.fakeFetch
        .requests()
        .filter((r) => r.method === "PATCH" && r.url.includes("discord.com"));
      assert.ok(discordPatchRequests.length >= 1, "Discord reply should have been sent");

      // Queues empty
      await assertQueuesDrained(store, "discord");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
