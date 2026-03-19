/**
 * Lifecycle restore integration with drain.
 *
 * Tests that the drain path correctly handles sandbox state transitions:
 * - stopped + snapshotId → restore from snapshot → running → gateway call
 * - uninitialized → fresh create → running → gateway call
 * - already running → no restore/create, gateway called immediately
 * - concurrent drains on different channels → only one restore triggered
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  dumpDiagnostics,
} from "@/test-utils/harness";
import { assertQueuesDrained } from "@/test-utils/assertions";
import { buildSlackWebhook, buildTelegramWebhook } from "@/test-utils/webhook-builders";
import { enqueueChannelJob, drainChannelQueue } from "@/server/channels/driver";
import { createSlackAdapter } from "@/server/channels/slack/adapter";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import {
  channelProcessingKey,
  channelFailedKey,
} from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlackPayload(signingSecret: string) {
  // Use buildSlackWebhook to validate the builder, then return raw payload
  void buildSlackWebhook({
    signingSecret,
    payload: {
      type: "event_callback",
      event_id: `Ev${Date.now()}`,
      event: {
        type: "message",
        text: "lifecycle drain test",
        channel: "C-LIFECYCLE-TEST",
        ts: "1234567890.000001",
        thread_ts: "1234567890.000000",
        user: "U-LIFECYCLE-TEST",
      },
    },
  });

  return {
    type: "event_callback",
    event_id: `Ev${Date.now()}`,
    event: {
      type: "message",
      text: "lifecycle drain test",
      channel: "C-LIFECYCLE-TEST",
      ts: "1234567890.000001",
      thread_ts: "1234567890.000000",
      user: "U-LIFECYCLE-TEST",
    },
  };
}

function makeTelegramPayload(webhookSecret: string) {
  void buildTelegramWebhook({
    webhookSecret,
    payload: {
      update_id: 200,
      message: {
        message_id: 2,
        from: { id: 88888, first_name: "LifecycleTester", is_bot: false },
        chat: { id: 88888, type: "private", first_name: "LifecycleTester" },
        date: Math.floor(Date.now() / 1000),
        text: "lifecycle telegram test",
      },
    },
  });

  return {
    update_id: 200,
    message: {
      message_id: 2,
      from: { id: 88888, first_name: "LifecycleTester", is_bot: false },
      chat: { id: 88888, type: "private", first_name: "LifecycleTester" },
      date: Math.floor(Date.now() / 1000),
      text: "lifecycle telegram test",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Drain lifecycle: stopped sandbox with snapshotId → restore from snapshot → status transitions restoring→booting→running → gateway called", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret } = h.configureAllChannels();

    // Drive to running, then stop (creates a snapshot)
    await h.driveToRunning();
    const snapshotId = await h.stopToSnapshot();

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", {
        payload: makeSlackPayload(slackSigningSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      // Drain triggers restore + gateway call
      await drainSlackQueue();

      // Verify sandbox was restored from snapshot (not fresh-created)
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(
        restoreEvents.length >= 1,
        "Should have at least one restore event",
      );
      assert.equal(
        (restoreEvents[0]!.detail as { snapshotId: string }).snapshotId,
        snapshotId,
        "Restore should use the snapshotId from the stopped state",
      );

      // Verify final status is running
      const finalMeta = await h.getMeta();
      assert.equal(finalMeta.status, "running");
      assert.ok(finalMeta.sandboxId, "Should have a sandboxId after restore");

      // Verify gateway was called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called");

      // Verify queues are empty
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

test("Drain lifecycle: uninitialized sandbox → fresh create → status transitions creating→setup→booting→running → gateway called", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret } = h.configureAllChannels();

    // Verify sandbox starts uninitialized (no driveToRunning + stop)
    const initialMeta = await h.getMeta();
    assert.equal(initialMeta.status, "uninitialized");
    assert.equal(initialMeta.snapshotId, null);
    assert.equal(initialMeta.sandboxId, null);

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", {
        payload: makeSlackPayload(slackSigningSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      // Drain triggers fresh create + gateway call
      await drainSlackQueue();

      // Verify sandbox was created fresh (not restored)
      const createEvents = h.controller.eventsOfKind("create");
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(
        createEvents.length >= 1,
        "Should have at least one create event",
      );
      assert.equal(
        restoreEvents.length,
        0,
        "Should NOT have any restore events (fresh create, not restore)",
      );

      // Verify final status is running
      const finalMeta = await h.getMeta();
      assert.equal(finalMeta.status, "running");
      assert.ok(finalMeta.sandboxId, "Should have a sandboxId after create");

      // Verify gateway was called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called");

      // Verify queues are empty
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

test("Drain lifecycle: already running sandbox → no restore/create triggered → gateway called immediately", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret } = h.configureAllChannels();

    // Drive to running but do NOT stop
    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    assert.equal(runningMeta.status, "running");

    // Record the number of create/restore events before drain
    const createsBefore = h.controller.eventsOfKind("create").length;
    const restoresBefore = h.controller.eventsOfKind("restore").length;

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", {
        payload: makeSlackPayload(slackSigningSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      await drainSlackQueue();

      // No additional create or restore should have happened
      const createsAfter = h.controller.eventsOfKind("create").length;
      const restoresAfter = h.controller.eventsOfKind("restore").length;
      assert.equal(
        createsAfter,
        createsBefore,
        "No new create events should occur when sandbox is already running",
      );
      assert.equal(
        restoresAfter,
        restoresBefore,
        "No new restore events should occur when sandbox is already running",
      );

      // Verify gateway was called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(gatewayRequests.length >= 1, "Gateway should have been called");

      // Verify queues are empty
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

test("Drain lifecycle: concurrent drains on different channels with stopped sandbox → only one restore triggered", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret, telegramWebhookSecret } = h.configureAllChannels();

    // Drive to running, then stop
    await h.driveToRunning();
    await h.stopToSnapshot();

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Enqueue jobs on two different channels
      await enqueueChannelJob("slack", {
        payload: makeSlackPayload(slackSigningSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      await enqueueChannelJob("telegram", {
        payload: makeTelegramPayload(telegramWebhookSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);
      assert.equal(await store.getQueueLength("openclaw-single:channels:telegram:queue"), 1);

      // Run both drains concurrently
      await Promise.all([drainSlackQueue(), drainTelegramQueue()]);

      // Only one restore should have been triggered (lifecycle lock prevents double-restore)
      const restoreEvents = h.controller.eventsOfKind("restore");
      const createEvents = h.controller.eventsOfKind("create");

      assert.equal(
        restoreEvents.length,
        1,
        `Should have exactly one restore event, got ${restoreEvents.length}. ` +
          `Total lifecycle ops (creates: ${createEvents.length}, restores: ${restoreEvents.length})`,
      );

      // Verify sandbox is running
      const finalMeta = await h.getMeta();
      assert.equal(finalMeta.status, "running");

      // Verify both gateways were called (both channels processed)
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(
        gatewayRequests.length >= 2,
        `Both channels should have made gateway calls, got ${gatewayRequests.length}`,
      );

      // Verify both channel queues are empty
      await assertQueuesDrained(store, "slack");
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

test("Drain lifecycle: sandbox create failure → job retried (not permanently failed)", async (t) => {
  const h = createScenarioHarness();
  try {
    const { slackSigningSecret } = h.configureAllChannels();

    // Start from uninitialized — no sandbox exists
    const initialMeta = await h.getMeta();
    assert.equal(initialMeta.status, "uninitialized");

    // Make the sandbox controller throw on every create attempt
    // so ensureSandboxReady times out quickly.
    h.controller.setCreateFailure(new Error("sandbox_create_quota_exceeded"));

    // Install gateway handler that returns not-ready (ensures timeout)
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response("not ready", { status: 503 }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", {
        payload: makeSlackPayload(slackSigningSecret),
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      // Drain with a very short sandbox readiness timeout (3s) so the test
      // doesn't block for 5 minutes. The sandbox can't come up because
      // create fails, so ensureSandboxReady will throw after the timeout.
      await drainChannelQueue({
        channel: "slack",
        getConfig: (meta) => meta.channels.slack,
        createAdapter: (config) => createSlackAdapter(config),
        sandboxReadyTimeoutMs: 3_000,
      });

      // Job should NOT be permanently failed — sandbox lifecycle errors are retryable
      assert.equal(
        await store.getQueueLength(channelFailedKey("slack")),
        0,
        "Sandbox create failure should be retryable, not permanently failed",
      );

      // Job should be parked in processing queue for retry
      assert.equal(
        await store.getQueueLength(channelProcessingKey("slack")),
        1,
        "Job should be parked in processing queue for retry after sandbox failure",
      );

      // Verify the retry metadata mentions sandbox_not_ready
      const processingEntry = await store.dequeue(channelProcessingKey("slack"));
      assert.ok(processingEntry);
      const envelope = JSON.parse(processingEntry);
      const retryJob = JSON.parse(envelope.job);
      assert.equal(retryJob.retryCount, 1);
      assert.ok(
        retryJob.lastError?.includes("sandbox_not_ready") ||
        retryJob.lastError?.includes("gateway_retryable"),
        `lastError should mention sandbox_not_ready or gateway_retryable, got: ${retryJob.lastError}`,
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
