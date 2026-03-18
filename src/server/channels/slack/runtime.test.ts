import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import { enqueueChannelJob, type QueuedChannelJob } from "@/server/channels/driver";
import { channelFailedKey, channelQueueKey, channelProcessingKey } from "@/server/channels/keys";
import { drainSlackQueue } from "@/server/channels/slack/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slackEventPayload(text = "hello"): unknown {
  return {
    type: "event_callback",
    event: {
      type: "message",
      text,
      channel: "C-test-channel",
      ts: "1234567890.000001",
      user: "U-test-user",
    },
  };
}

function createSlackJob(
  overrides: Partial<QueuedChannelJob<unknown>> = {},
): QueuedChannelJob<unknown> {
  return {
    payload: slackEventPayload(),
    receivedAt: Date.now(),
    origin: "https://app.test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Drain triggers sandbox restore when stopped
// ---------------------------------------------------------------------------

test("[slack runtime] drain triggers sandbox restore when stopped", async () => {
  await withHarness(async (h) => {
    // Drive to running, then stop
    h.installDefaultGatewayHandlers("Slack reply");
    await h.driveToRunning();
    await h.stopToSnapshot();

    // Configure slack channel
    h.configureAllChannels();

    // Install global fetch for the drain
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", createSlackJob());
      await drainSlackQueue();

      // Sandbox should have been restored (create event for restore)
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(restoreEvents.length >= 1, "Should have triggered a sandbox restore");

      // Reply should have been sent to Slack
      const slackRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api/chat.postMessage"));
      assert.ok(slackRequests.length >= 1, "Should have sent a reply to Slack");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain forwards to chat completions endpoint
// ---------------------------------------------------------------------------

test("[slack runtime] drain forwards message to /v1/chat/completions", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers("Gateway reply for slack");
    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", createSlackJob());
      await drainSlackQueue();

      const completionRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(completionRequests.length >= 1, "Should have forwarded to chat completions");

      const body = JSON.parse(completionRequests[0]!.body!);
      assert.equal(body.model, "default");
      assert.ok(Array.isArray(body.messages));
      assert.ok(
        body.messages.some((m: { role: string; content: string }) => m.content === "hello"),
        "Should include user message text",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles chat completions non-200 gracefully
// ---------------------------------------------------------------------------

test("[slack runtime] drain handles chat completions 500 with failed queue", async () => {
  await withHarness(async (h) => {
    // Override completions to return 500
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", createSlackJob());
      await drainSlackQueue();

      // 500 is a transient 5xx error — retryable, parked in processing queue
      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("slack"));
      assert.ok(processingLen >= 1, "Job should be parked for retry in processing queue");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles chat completions network error gracefully
// ---------------------------------------------------------------------------

test("[slack runtime] drain handles chat completions network error with retry", async () => {
  await withHarness(async (h) => {
    // Override completions to throw a network error
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", createSlackJob());
      await drainSlackQueue();

      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("slack"));
      assert.ok(processingLen >= 1, "Job should be parked for retry after network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles non-retryable gateway failure (e.g. 400)
// ---------------------------------------------------------------------------

test("[slack runtime] drain handles gateway 400 -> failed queue", async () => {
  await withHarness(async (h) => {
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Bad Request", { status: 400 }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("slack", createSlackJob());
      await drainSlackQueue();

      const store = h.getStore();
      // Non-retryable error -> failed queue
      const dlEntry = await store.dequeue(channelFailedKey("slack"));
      assert.ok(dlEntry, "Job should be permanently failed on non-retryable gateway error");
      const parsed = JSON.parse(dlEntry);
      assert.equal(parsed.channel, "slack");
      assert.ok(parsed.error.includes("gateway_failed"), `Error should mention gateway_failed, got: ${parsed.error}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Slack thread history fetch failure is swallowed (per fix 38f1aa1)
// ---------------------------------------------------------------------------

test("[slack runtime] thread history fetch failure is swallowed gracefully", async () => {
  await withHarness(async (h) => {
    // Gateway completions works fine
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "Reply despite history failure" } }],
      }),
    );
    h.fakeFetch.onPost(/slack\.com\/api/, () => Response.json({ ok: true }));
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    // Thread history fetch fails with 500
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      new Response("Internal Server Error", { status: 500 }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Send a message in a thread (thread_ts != ts)
      const threadPayload = {
        type: "event_callback",
        event: {
          type: "message",
          text: "thread message",
          channel: "C-test-channel",
          ts: "1234567890.000002",
          thread_ts: "1234567890.000001",
          user: "U-test-user",
        },
      };
      await enqueueChannelJob("slack", {
        payload: threadPayload,
        receivedAt: Date.now(),
        origin: "https://app.test",
      });
      await drainSlackQueue();

      // Reply should still be sent despite history failure
      const slackReplies = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api/chat.postMessage"));
      assert.ok(slackReplies.length >= 1, "Reply should be sent even when thread history fails");

      // Queue should be empty (processed successfully)
      const store = h.getStore();
      assert.equal(await store.getQueueLength(channelQueueKey("slack")), 0);
      assert.equal(await store.getQueueLength(channelProcessingKey("slack")), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
