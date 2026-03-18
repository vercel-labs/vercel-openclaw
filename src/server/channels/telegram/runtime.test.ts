import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import { enqueueChannelJob, type QueuedChannelJob } from "@/server/channels/driver";
import { channelFailedKey, channelProcessingKey, channelQueueKey } from "@/server/channels/keys";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function telegramUpdatePayload(text = "hello"): unknown {
  return {
    message: {
      text,
      chat: { id: 12345 },
    },
  };
}

function createTelegramJob(
  overrides: Partial<QueuedChannelJob<unknown>> = {},
): QueuedChannelJob<unknown> {
  return {
    payload: telegramUpdatePayload(),
    receivedAt: Date.now(),
    origin: "https://app.test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Drain triggers sandbox restore when stopped
// ---------------------------------------------------------------------------

test("[telegram runtime] drain triggers sandbox restore when stopped", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers("Telegram reply");
    await h.driveToRunning();
    await h.stopToSnapshot();

    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(restoreEvents.length >= 1, "Should have triggered a sandbox restore");

      const telegramRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("api.telegram.org"));
      // Should have typing indicator + reply
      assert.ok(telegramRequests.length >= 1, "Should have sent requests to Telegram API");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain forwards to chat completions endpoint
// ---------------------------------------------------------------------------

test("[telegram runtime] drain forwards message to /v1/chat/completions", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers("Gateway reply for telegram");
    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const completionRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(completionRequests.length >= 1, "Should have forwarded to chat completions");

      const body = JSON.parse(completionRequests[0]!.body!);
      assert.equal(body.model, "default");
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
// Drain handles chat completions 500 with retry
// ---------------------------------------------------------------------------

test("[telegram runtime] drain handles chat completions 500 with failed queue", async () => {
  await withHarness(async (h) => {
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: true }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      // 500 is a transient 5xx error — retryable, parked in processing queue
      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("telegram"));
      assert.ok(processingLen >= 1, "Job should be parked for retry in processing queue");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles chat completions network error with retry
// ---------------------------------------------------------------------------

test("[telegram runtime] drain handles chat completions network error with retry", async () => {
  await withHarness(async (h) => {
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: true }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("telegram"));
      assert.ok(processingLen >= 1, "Job should be parked for retry after network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles non-retryable gateway failure -> failed queue
// ---------------------------------------------------------------------------

test("[telegram runtime] drain handles gateway 400 -> failed queue", async () => {
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
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: true }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const store = h.getStore();
      const dlEntry = await store.dequeue(channelFailedKey("telegram"));
      assert.ok(dlEntry, "Job should be permanently failed on non-retryable gateway error");
      const parsed = JSON.parse(dlEntry);
      assert.equal(parsed.channel, "telegram");
      assert.ok(parsed.error.includes("gateway_failed"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles sandbox gone (410) with retry
// ---------------------------------------------------------------------------

test("[telegram runtime] drain handles gateway 410 sandbox_gone with retry", async () => {
  await withHarness(async (h) => {
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Gone", { status: 410 }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: true }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("telegram"));
      assert.ok(processingLen >= 1, "Job should be parked for retry on 410 sandbox_gone");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Telegram channel not configured -> failed queue
// ---------------------------------------------------------------------------

test("[telegram runtime] not configured -> failed queue", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers();
    await h.driveToRunning();
    // Do NOT configure channels — telegram config is null

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("telegram", createTelegramJob());
      await drainTelegramQueue();

      const store = h.getStore();
      const dlEntry = await store.dequeue(channelFailedKey("telegram"));
      assert.ok(dlEntry, "Job should be permanently failed when channel not configured");
      const parsed = JSON.parse(dlEntry);
      assert.ok(parsed.error.includes("not_configured"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
