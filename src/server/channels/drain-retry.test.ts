/**
 * Retry and failed drain scenarios.
 *
 * Validates that transient gateway/send failures are retried with correct
 * backoff, that 410 triggers retry (sandbox gone → restore on next drain),
 * and that exhausted retries land in the failed queue.
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
  chatCompletionsResponse,
  gatewayReadyResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
} from "@/test-utils/fake-fetch";
import {
  assertQueuesDrained,
} from "@/test-utils/assertions";
import {
  buildSlackWebhook,
  buildTelegramWebhook,
  buildDiscordWebhook,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";
import { stopSandbox } from "@/server/sandbox/lifecycle";
import { enqueueChannelJob, type QueuedChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
} from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configureSlack(h: { mutateMeta: typeof import("@/server/store/store").mutateMeta }): string {
  const signingSecret = "test-slack-signing-secret-retry";

  h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret,
      botToken: "xoxb-retry-test-bot-token",
      configuredAt: Date.now(),
    };
  });

  return signingSecret;
}

function makeSlackJob(signingSecret: string): QueuedChannelJob<unknown> {
  const slackReq = buildSlackWebhook({
    signingSecret,
    payload: {
      type: "event_callback",
      event_id: `Ev${Date.now()}`,
      event: {
        type: "message",
        text: "retry test message",
        channel: "C-RETRY-TEST",
        ts: "1700000000.000001",
        thread_ts: "1700000000.000000",
        user: "U-RETRY-TEST",
      },
    },
  });

  // Suppress lint for the unused variable (we built the request just
  // to ensure the builder doesn't throw, but we need the raw payload).
  void slackReq;

  const payload = {
    type: "event_callback",
    event_id: `Ev${Date.now()}`,
    event: {
      type: "message",
      text: "retry test message",
      channel: "C-RETRY-TEST",
      ts: "1700000000.000001",
      thread_ts: "1700000000.000000",
      user: "U-RETRY-TEST",
    },
  };

  return {
    payload,
    receivedAt: Date.now(),
    origin: "https://test.example.com",
  };
}

type FailedEntry = {
  failedAt: number;
  error: string;
  channel: string;
  job: QueuedChannelJob<unknown>;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Drain retry: gateway 5xx with Retry-After → job re-parked in processing queue, not permanently failed", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway returns 503 with Retry-After: 30
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Service Unavailable", {
        status: 503,
        headers: { "Retry-After": "30" },
      }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const job = makeSlackJob(signingSecret);
      await enqueueChannelJob("slack", job);

      const store = h.getStore();
      assert.equal(await store.getQueueLength(channelQueueKey("slack")), 1);

      // First drain — gateway 503 → job should be re-parked with retry metadata
      await drainSlackQueue();

      // Queue should be empty (job moved to processing on lease)
      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        0,
        "Main queue should be empty (job is parked in processing)",
      );

      // Job should still be in processing (parked with nextAttemptAt in future)
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "Job should be parked in processing queue",
      );

      // Failed should be empty — this is a retryable failure
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        0,
        "No failed should be written for retryable failure",
      );

      // Verify the parked entry contains correct retry metadata
      const processingQueue = await store.dequeue(channelProcessingKey("slack"));
      assert.ok(processingQueue, "Should have a parked processing entry");

      const envelope = JSON.parse(processingQueue);
      assert.ok(typeof envelope.job === "string", "Envelope should contain job string");
      assert.ok(
        typeof envelope.visibilityTimeoutAt === "number",
        "Envelope should have visibilityTimeoutAt",
      );

      const retryJob = JSON.parse(envelope.job) as QueuedChannelJob<unknown>;
      assert.equal(retryJob.retryCount, 1, "retryCount should be 1 after first failure");
      assert.ok(
        typeof retryJob.nextAttemptAt === "number" && retryJob.nextAttemptAt > Date.now() - 5000,
        "nextAttemptAt should be set to a future timestamp",
      );
      assert.ok(
        retryJob.lastError?.includes("gateway_retryable_503"),
        "lastError should mention 503",
      );
      assert.ok(
        typeof retryJob.lastRetryAt === "number",
        "lastRetryAt should be set",
      );

      // The retry delay should respect Retry-After: 30 (= 30_000ms)
      const expectedMinDelay = 30_000;
      const actualDelay = retryJob.nextAttemptAt! - retryJob.lastRetryAt!;
      assert.ok(
        actualDelay >= expectedMinDelay - 100,
        `Retry delay (${actualDelay}ms) should respect Retry-After header (>= ${expectedMinDelay}ms)`,
      );
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

test("Drain retry: gateway 410 → job retried (sandbox treated as gone)", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway returns 410 Gone
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Gone", { status: 410 }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const job = makeSlackJob(signingSecret);
      await enqueueChannelJob("slack", job);

      const store = h.getStore();

      // First drain — gateway 410 → retryable, job re-parked
      await drainSlackQueue();

      // Should NOT be permanently failed
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        0,
        "410 should be retryable, not permanently failed",
      );

      // Should be parked in processing
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "Job should be parked in processing queue for retry",
      );

      // Verify the parked job has sandbox_gone error
      const processingEntry = await store.dequeue(channelProcessingKey("slack"));
      assert.ok(processingEntry);
      const envelope = JSON.parse(processingEntry);
      const retryJob = JSON.parse(envelope.job) as QueuedChannelJob<unknown>;
      assert.equal(retryJob.retryCount, 1);
      assert.ok(
        retryJob.lastError?.includes("410"),
        `lastError should mention 410, got: ${retryJob.lastError}`,
      );
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

test("Drain retry: outbound send failure (RetryableSendError) → job re-parked with backoff", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway succeeds but Slack sendReply returns 429 (rate limited)
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      chatCompletionsResponse("reply text"),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );
    // Slack chat.postMessage returns 429 → triggers RetryableSendError in adapter
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage/, () =>
      new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
        status: 429,
        headers: { "Retry-After": "10" },
      }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const job = makeSlackJob(signingSecret);
      await enqueueChannelJob("slack", job);

      const store = h.getStore();

      await drainSlackQueue();

      // Should NOT be permanently failed — RetryableSendError is retryable
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        0,
        "RetryableSendError should not failed",
      );

      // Should be parked in processing
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "Job should be parked in processing for retry",
      );

      // Verify retry metadata
      const processingEntry = await store.dequeue(channelProcessingKey("slack"));
      assert.ok(processingEntry);
      const envelope = JSON.parse(processingEntry);
      const retryJob = JSON.parse(envelope.job) as QueuedChannelJob<unknown>;
      assert.equal(retryJob.retryCount, 1);
      assert.ok(
        retryJob.lastError?.includes("slack_send_retryable"),
        `lastError should mention slack_send_retryable, got: ${retryJob.lastError}`,
      );
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

test("Drain retry: retries exhausted (retryCount >= 8) → job moved to failed with error details", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway always fails with 500
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const store = h.getStore();

      // Enqueue a job that has already been retried 8 times (MAX_RETRY_COUNT = 8)
      const exhaustedJob: QueuedChannelJob<unknown> = {
        payload: {
          type: "event_callback",
          event_id: `Ev${Date.now()}`,
          event: {
            type: "message",
            text: "exhausted retry test",
            channel: "C-RETRY-TEST",
            ts: "1700000000.000001",
            thread_ts: "1700000000.000000",
            user: "U-RETRY-TEST",
          },
        },
        receivedAt: Date.now(),
        origin: "https://test.example.com",
        retryCount: 8,
        lastError: "gateway_retryable_500",
        lastRetryAt: Date.now() - 60_000,
        nextAttemptAt: Date.now() - 1000,
      };

      await enqueueChannelJob("slack", exhaustedJob);
      assert.equal(await store.getQueueLength(channelQueueKey("slack")), 1);

      await drainSlackQueue();

      // Queue should be empty
      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        0,
        "Main queue should be empty",
      );

      // Processing should be empty (ACKed after faileding)
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        0,
        "Processing queue should be empty after faileding",
      );

      // Failed should have exactly one entry
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        1,
        "Failed queue should have one entry",
      );

      // Verify failed entry contents
      const dlRaw = await store.dequeue(channelFailedKey("slack"));
      assert.ok(dlRaw, "Failed entry should exist");

      const dl = JSON.parse(dlRaw) as FailedEntry;
      assert.equal(dl.channel, "slack", "Failed should contain channel name");
      assert.ok(
        typeof dl.failedAt === "number" && dl.failedAt > 0,
        "Failed should have failedAt timestamp",
      );
      assert.ok(
        dl.error.includes("gateway_retryable_500"),
        `Failed error should describe the failure, got: ${dl.error}`,
      );
      assert.ok(dl.job, "Failed should contain original job payload");
      assert.equal(
        (dl.job.payload as { type: string }).type,
        "event_callback",
        "Failed job should preserve original payload",
      );
      assert.equal(
        dl.job.retryCount,
        8,
        "Failed job should preserve retryCount from last attempt",
      );
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

test("Drain retry: Telegram RetryableSendError (sendMessage 429) → job re-parked with backoff", async (t) => {
  const h = createScenarioHarness();
  try {
    // Configure Telegram channel
    const telegramWebhookSecret = "test-telegram-webhook-secret-retry";
    h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "retry-test-telegram-bot-token",
        webhookSecret: telegramWebhookSecret,
        webhookUrl: "https://test.example.com/api/channels/telegram/webhook",
        botUsername: "retry_test_bot",
        configuredAt: Date.now(),
      };
    });

    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway succeeds but Telegram sendMessage returns 429
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      chatCompletionsResponse("telegram retry reply"),
    );
    h.fakeFetch.onPost(/api\.telegram\.org.*sendChatAction/, () =>
      telegramOkResponse(),
    );
    h.fakeFetch.onPost(/api\.telegram\.org.*sendMessage/, () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 15",
          parameters: { retry_after: 15 },
        }),
        { status: 429, headers: { "Retry-After": "15" } },
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const telegramReq = buildTelegramWebhook({
        webhookSecret: telegramWebhookSecret,
        payload: {
          update_id: 500,
          message: {
            message_id: 50,
            from: { id: 55555, first_name: "RetryTester", is_bot: false },
            chat: { id: 55555, type: "private", first_name: "RetryTester" },
            date: Math.floor(Date.now() / 1000),
            text: "telegram retry test",
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
      assert.equal(await store.getQueueLength(channelQueueKey("telegram")), 1);

      await drainTelegramQueue();

      // Should NOT be permanently failed — RetryableSendError is retryable
      assert.equal(
        await store.getQueueLength(channelFailedKey("telegram")),
        0,
        "Telegram RetryableSendError should not failed",
      );

      // Should be parked in processing
      assert.equal(
        await store.getQueueLength(channelProcessingKey("telegram")),
        1,
        "Job should be parked in processing for retry",
      );

      // Verify retry metadata
      const processingEntry = await store.dequeue(channelProcessingKey("telegram"));
      assert.ok(processingEntry);
      const envelope = JSON.parse(processingEntry);
      const retryJob = JSON.parse(envelope.job) as QueuedChannelJob<unknown>;
      assert.equal(retryJob.retryCount, 1);
      assert.ok(
        retryJob.lastError?.includes("telegram_send_retryable"),
        `lastError should mention telegram_send_retryable, got: ${retryJob.lastError}`,
      );
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

test("Drain retry: Discord RetryableSendError (webhook PATCH 429) → job re-parked with backoff", async (t) => {
  const h = createScenarioHarness();
  try {
    // Configure Discord channel
    const discordKeys = generateDiscordKeyPair();
    h.mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: discordKeys.publicKeyHex,
        applicationId: "retry-test-discord-app-id",
        botToken: "retry-test-discord-bot-token",
        configuredAt: Date.now(),
      };
    });

    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway succeeds but Discord PATCH returns 429
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      chatCompletionsResponse("discord retry reply"),
    );
    // Discord typing (POST to channels/.../typing) succeeds
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/channels\/.*\/typing/, () =>
      discordOkResponse(),
    );
    // Discord webhook PATCH returns 429
    h.fakeFetch.onPatch(/discord\.com/, () =>
      new Response(
        JSON.stringify({ message: "You are being rate limited.", retry_after: 10 }),
        { status: 429, headers: { "Retry-After": "10" } },
      ),
    );
    // Discord POST (followup) also returns 429 (fallback path)
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/webhooks/, () =>
      new Response(
        JSON.stringify({ message: "You are being rate limited.", retry_after: 10 }),
        { status: 429, headers: { "Retry-After": "10" } },
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const interactionToken = `retry-interaction-token-${Date.now()}`;
      const discordReq = buildDiscordWebhook({
        privateKey: discordKeys.privateKey,
        publicKeyHex: discordKeys.publicKeyHex,
        payload: {
          id: `interaction-retry-${Date.now()}`,
          type: 2, // APPLICATION_COMMAND
          token: interactionToken,
          application_id: "retry-test-discord-app-id",
          channel_id: "ch-retry-test",
          member: {
            user: { id: "user-retry-test" },
          },
          data: {
            name: "ask",
            options: [{ name: "text", value: "discord retry test" }],
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
      assert.equal(await store.getQueueLength(channelQueueKey("discord")), 1);

      await drainDiscordQueue();

      // Should NOT be permanently failed — RetryableSendError is retryable
      assert.equal(
        await store.getQueueLength(channelFailedKey("discord")),
        0,
        "Discord RetryableSendError should not failed",
      );

      // Should be parked in processing
      assert.equal(
        await store.getQueueLength(channelProcessingKey("discord")),
        1,
        "Job should be parked in processing for retry",
      );

      // Verify retry metadata
      const processingEntry = await store.dequeue(channelProcessingKey("discord"));
      assert.ok(processingEntry);
      const envelope = JSON.parse(processingEntry);
      const retryJob = JSON.parse(envelope.job) as QueuedChannelJob<unknown>;
      assert.equal(retryJob.retryCount, 1);
      assert.ok(
        retryJob.lastError?.includes("discord") && retryJob.lastError?.includes("retryable"),
        `lastError should mention discord retryable, got: ${retryJob.lastError}`,
      );
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

test("Drain retry: stale processing entry (expired visibility timeout) recovered and re-processed", async (t) => {
  const h = createScenarioHarness();
  try {
    configureSlack(h);
    await h.driveToRunning();

    h.installDefaultGatewayHandlers();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const store = h.getStore();

      // Manually craft a stale processing entry with expired visibility timeout
      const staleJob: QueuedChannelJob<unknown> = {
        payload: {
          type: "event_callback",
          event_id: `Ev-stale-${Date.now()}`,
          event: {
            type: "message",
            text: "stale entry test",
            channel: "C-STALE-TEST",
            ts: "1700000000.000003",
            thread_ts: "1700000000.000002",
            user: "U-STALE-TEST",
          },
        },
        receivedAt: Date.now() - 25 * 60 * 1000,
        origin: "https://test.example.com",
      };

      const staleLease = JSON.stringify({
        job: JSON.stringify(staleJob),
        leasedAt: Date.now() - 25 * 60 * 1000,
        visibilityTimeoutAt: Date.now() - 5 * 60 * 1000, // expired 5 min ago
      });

      // Insert into processing queue (simulating a stuck/leaked entry)
      await store.enqueue(channelProcessingKey("slack"), staleLease);

      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "Should have one stale entry in processing",
      );
      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        0,
        "Main queue should be empty before drain",
      );

      // Drain should recover the stale entry and process it
      await drainSlackQueue();

      // All queues should be empty after successful recovery + processing
      await assertQueuesDrained(store, "slack");

      // Verify the gateway was actually called (proving the entry was processed)
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(
        gatewayRequests.length >= 1,
        "Gateway should have been called after recovering stale entry",
      );
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

test("Drain retry: adapter send timeout on first job does not block processing of second job", async (t) => {
  const h = createScenarioHarness();
  try {
    configureSlack(h);
    await h.driveToRunning();

    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      chatCompletionsResponse("reply text"),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    // First Slack postMessage call times out, subsequent calls succeed
    let postMessageCallCount = 0;
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage/, () => {
      postMessageCallCount++;
      if (postMessageCallCount === 1) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return slackOkResponse();
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const store = h.getStore();

      // Enqueue two distinct jobs
      const job1: QueuedChannelJob<unknown> = {
        payload: {
          type: "event_callback",
          event_id: `Ev-timeout-1-${Date.now()}`,
          event: {
            type: "message",
            text: "first job (will timeout)",
            channel: "C-TIMEOUT-1",
            ts: "1700000000.000010",
            thread_ts: "1700000000.000009",
            user: "U-TIMEOUT-1",
          },
        },
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      };

      const job2: QueuedChannelJob<unknown> = {
        payload: {
          type: "event_callback",
          event_id: `Ev-timeout-2-${Date.now()}`,
          event: {
            type: "message",
            text: "second job (should succeed)",
            channel: "C-TIMEOUT-2",
            ts: "1700000000.000020",
            thread_ts: "1700000000.000019",
            user: "U-TIMEOUT-2",
          },
        },
        receivedAt: Date.now() + 1,
        origin: "https://test.example.com",
      };

      await enqueueChannelJob("slack", job1);
      await enqueueChannelJob("slack", job2);
      assert.equal(await store.getQueueLength(channelQueueKey("slack")), 2);

      await drainSlackQueue();

      // Main queue should be empty (both jobs were leased)
      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        0,
        "Main queue should be empty",
      );

      // First job should be re-parked in processing (timeout → retryable)
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "First job should be parked in processing (timeout is retryable)",
      );

      // No faileds — timeout is retryable
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        0,
        "No faileds — timeout is retryable",
      );

      // Second job should have been sent successfully
      assert.ok(
        postMessageCallCount >= 2,
        `Second job should have been processed (postMessage called ${postMessageCallCount} times)`,
      );

      // Verify both jobs reached the gateway
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.equal(
        gatewayRequests.length,
        2,
        "Both jobs should have reached the gateway",
      );
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

test("Drain retry: failed entry contains channel, payload, error, and timestamp", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    // Gateway returns a non-retryable error (400 Bad Request — not auth, not 5xx)
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Bad Request", { status: 400 }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const store = h.getStore();

      const job = makeSlackJob(signingSecret);
      await enqueueChannelJob("slack", job);

      const beforeDrain = Date.now();
      await drainSlackQueue();

      // Non-retryable error → immediate failed
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        1,
        "Non-retryable error should immediately failed",
      );

      // Verify all required fields in failed entry
      const dlRaw = await store.dequeue(channelFailedKey("slack"));
      assert.ok(dlRaw);

      const dl = JSON.parse(dlRaw) as FailedEntry;

      // channel name
      assert.equal(dl.channel, "slack", "Must contain channel name");

      // timestamp
      assert.ok(
        dl.failedAt >= beforeDrain,
        "failedAt must be a recent timestamp",
      );

      // error message
      assert.ok(
        dl.error.length > 0,
        "error must be a non-empty string",
      );
      assert.ok(
        dl.error.includes("gateway_failed") && dl.error.includes("400"),
        `error should describe the 400 failure, got: ${dl.error}`,
      );

      // original job payload
      assert.ok(dl.job, "Must contain original job");
      assert.ok(dl.job.payload, "Must contain original payload");
      assert.ok(
        typeof dl.job.receivedAt === "number",
        "Must preserve receivedAt",
      );
      assert.equal(
        dl.job.origin,
        "https://test.example.com",
        "Must preserve origin",
      );
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
