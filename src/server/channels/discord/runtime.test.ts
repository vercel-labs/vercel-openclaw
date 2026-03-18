import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import { enqueueChannelJob, type QueuedChannelJob } from "@/server/channels/driver";
import { channelFailedKey, channelProcessingKey, channelQueueKey } from "@/server/channels/keys";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function discordInteractionPayload(text = "hello"): unknown {
  return {
    id: "interaction-1",
    type: 2, // APPLICATION_COMMAND
    token: "interaction-token-abc",
    channel_id: "discord-channel-1",
    application_id: "shared-test-discord-app-id",
    data: {
      name: "ask",
      options: [{ name: "text", value: text, type: 3 }],
    },
    member: { user: { id: "discord-user-1" } },
  };
}

function createDiscordJob(
  overrides: Partial<QueuedChannelJob<unknown>> = {},
): QueuedChannelJob<unknown> {
  return {
    payload: discordInteractionPayload(),
    receivedAt: Date.now(),
    origin: "https://app.test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Drain triggers sandbox restore when stopped
// ---------------------------------------------------------------------------

test("[discord runtime] drain triggers sandbox restore when stopped", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers("Discord reply");
    await h.driveToRunning();
    await h.stopToSnapshot();

    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(restoreEvents.length >= 1, "Should have triggered a sandbox restore");

      const discordRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("discord.com"));
      assert.ok(discordRequests.length >= 1, "Should have sent requests to Discord API");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain forwards to chat completions endpoint
// ---------------------------------------------------------------------------

test("[discord runtime] drain forwards message to /v1/chat/completions", async () => {
  await withHarness(async (h) => {
    h.installDefaultGatewayHandlers("Gateway reply for discord");
    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

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

test("[discord runtime] drain handles chat completions 500 with failed queue", async () => {
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
    h.fakeFetch.onPatch(/discord\.com/, () => new Response(null, { status: 204 }));
    h.fakeFetch.onPost(/discord\.com/, () => new Response(null, { status: 204 }));

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      // 500 is a transient 5xx error — retryable, parked in processing queue
      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("discord"));
      assert.ok(processingLen >= 1, "Job should be parked for retry in processing queue");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles chat completions network error with retry
// ---------------------------------------------------------------------------

test("[discord runtime] drain handles chat completions network error with retry", async () => {
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
    h.fakeFetch.onPatch(/discord\.com/, () => new Response(null, { status: 204 }));
    h.fakeFetch.onPost(/discord\.com/, () => new Response(null, { status: 204 }));

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      const store = h.getStore();
      const processingLen = await store.getQueueLength(channelProcessingKey("discord"));
      assert.ok(processingLen >= 1, "Job should be parked for retry after network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Drain handles non-retryable gateway failure -> failed queue
// ---------------------------------------------------------------------------

test("[discord runtime] drain handles gateway 400 -> failed queue", async () => {
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
    h.fakeFetch.onPatch(/discord\.com/, () => new Response(null, { status: 204 }));
    h.fakeFetch.onPost(/discord\.com/, () => new Response(null, { status: 204 }));

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      const store = h.getStore();
      const dlEntry = await store.dequeue(channelFailedKey("discord"));
      assert.ok(dlEntry, "Job should be permanently failed on non-retryable gateway error");
      const parsed = JSON.parse(dlEntry);
      assert.equal(parsed.channel, "discord");
      assert.ok(parsed.error.includes("gateway_failed"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Discord chunked reply splitting for messages >2000 chars
// ---------------------------------------------------------------------------

test("[discord runtime] long reply is split into multiple Discord messages", async () => {
  await withHarness(async (h) => {
    // Generate a reply longer than 2000 chars
    const longReply = "A".repeat(3500);
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      Response.json({
        choices: [{ message: { role: "assistant", content: longReply } }],
      }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    // PATCH for initial edit, POST for followup chunks
    h.fakeFetch.onPatch(/discord\.com/, () => new Response(null, { status: 200 }));
    h.fakeFetch.onPost(/discord\.com/, () => new Response(null, { status: 200 }));

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      // Should have: PATCH for initial message + POST for followup
      const patchRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.method === "PATCH" &&
            r.url.includes("discord.com") &&
            r.url.includes("messages/@original"),
        );
      const followupRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.method === "POST" &&
            r.url.includes("discord.com") &&
            r.url.includes("webhooks/") &&
            !r.url.includes("messages/@original") &&
            !r.url.includes("/typing"),
        );

      assert.ok(patchRequests.length >= 1, "Should have PATCHed the original message");
      assert.ok(followupRequests.length >= 1, "Should have sent followup chunks for long reply");

      // Verify all content chunks fit within 2000 chars
      for (const req of patchRequests) {
        if (req.body) {
          const body = JSON.parse(req.body);
          assert.ok(
            body.content.length <= 2000,
            `PATCH content should be ≤2000 chars, got ${body.content.length}`,
          );
        }
      }
      for (const req of followupRequests) {
        if (req.body) {
          const body = JSON.parse(req.body);
          assert.ok(
            body.content.length <= 2000,
            `Followup content should be ≤2000 chars, got ${body.content.length}`,
          );
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Discord interaction webhook expired -> fallback to channel message
// ---------------------------------------------------------------------------

test("[discord runtime] expired interaction webhook falls back to channel message", async () => {
  await withHarness(async (h) => {
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "Delayed reply" } }],
      }),
    );
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<html><body><div id="openclaw-app">ready</div></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    // PATCH returns 404 (expired interaction token)
    h.fakeFetch.onPatch(/discord\.com/, () =>
      new Response("Not Found", { status: 404 }),
    );
    // Fallback channel message POST succeeds
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/channels\//, () =>
      Response.json({ id: "fallback-msg-1" }),
    );
    // Typing indicator POST also to discord.com
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/channels\/.*\/typing/, () =>
      new Response(null, { status: 204 }),
    );

    await h.driveToRunning();
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueChannelJob("discord", createDiscordJob());
      await drainDiscordQueue();

      // Should have used channel message fallback
      const channelMsgRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.method === "POST" &&
            r.url.includes("discord.com/api/v10/channels/") &&
            r.url.includes("/messages"),
        );
      assert.ok(
        channelMsgRequests.length >= 1,
        "Should have fallen back to channel message when interaction expired",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
