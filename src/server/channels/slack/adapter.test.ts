import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import {
  createSlackAdapter,
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import type { SlackExtractedMessage } from "@/server/channels/slack/adapter";
import {
  _resetLogBuffer,
  getFilteredServerLogs,
} from "@/server/log";

test("isValidSlackSignature validates a correctly signed request", () => {
  const signingSecret = "secret";
  const rawBody = JSON.stringify({ type: "event_callback" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");

  assert.equal(
    isValidSlackSignature({
      signingSecret,
      rawBody,
      signatureHeader: `v0=${digest}`,
      timestampHeader: timestamp,
    }),
    true,
  );

  assert.equal(
    isValidSlackSignature({
      signingSecret,
      rawBody,
      signatureHeader: "v0=bad",
      timestampHeader: timestamp,
    }),
    false,
  );
});

test("getSlackUrlVerificationChallenge returns the challenge string", () => {
  assert.equal(
    getSlackUrlVerificationChallenge({
      type: "url_verification",
      challenge: "abc123",
    }),
    "abc123",
  );
});

test("createSlackAdapter extracts a basic threadable message", async () => {
  const adapter = createSlackAdapter({
    signingSecret: "secret",
    botToken: "xoxb-token",
  });

  const result = await adapter.extractMessage({
    type: "event_callback",
    event: {
      type: "message",
      text: "hello from slack",
      channel: "C123",
      ts: "123.45",
      user: "U123",
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello from slack");
  assert.equal(result.message.channel, "C123");
  assert.equal(result.message.threadTs, "123.45");
});

test("createSlackAdapter sendReply throws RetryableSendError when Slack rate limits", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: {
            "retry-after": "7",
          },
        }),
    },
  );

  await assert.rejects(
    adapter.sendReply(
      {
        text: "hello from slack",
        channel: "C123",
        threadTs: "123.45",
        ts: "123.45",
      },
      "reply text",
    ),
    (error) => {
      assert.ok(error instanceof RetryableSendError);
      assert.equal(error.retryAfterSeconds, 7);
      return true;
    },
  );
});

test("createSlackAdapter startProcessingIndicator posts and deletes a thinking placeholder", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.01" }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello from slack",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);

  assert.equal(message.processingPlaceholderTs, "999.01");
  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0].input).includes("chat.postMessage"));

  const postBody = JSON.parse(fetchCalls[0].init?.body as string);
  assert.equal(postBody.text, "_Thinking..._");
  assert.equal(postBody.channel, "C123");
  assert.equal(postBody.thread_ts, "123.45");

  await indicator?.stop();

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 2);
  assert.ok(String(fetchCalls[1].input).includes("chat.delete"));

  const deleteBody = JSON.parse(fetchCalls[1].init?.body as string);
  assert.equal(deleteBody.channel, "C123");
  assert.equal(deleteBody.ts, "999.01");
});

test("createSlackAdapter startProcessingIndicator stop() tolerates message_not_found", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.02" }), {
            status: 200,
          });
        }

        return new Response(
          JSON.stringify({ ok: false, error: "message_not_found" }),
          { status: 200 },
        );
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);
  // Should not throw despite message_not_found
  await indicator?.stop();
  assert.equal(message.processingPlaceholderTs, undefined);
});

test("createSlackAdapter startProcessingIndicator stop() is idempotent", async () => {
  let deleteCalls = 0;

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.03" }), {
            status: 200,
          });
        }
        if (String(input).includes("chat.delete")) {
          deleteCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);
  await indicator?.stop();
  await indicator?.stop();
  // Second stop() should be a no-op since processingPlaceholderTs was cleared
  assert.equal(deleteCalls, 1);
});

test("createSlackAdapter extractMessage returns empty history and logs when thread fetch fails", async () => {
  _resetLogBuffer();

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async () => {
        throw new Error("network down");
      },
    },
  );

  try {
    const result = await adapter.extractMessage({
      type: "event_callback",
      event: {
        type: "message",
        text: "thread reply",
        channel: "C123",
        ts: "124.56",
        thread_ts: "123.45",
        user: "U123",
      },
    });

    assert.equal(result.kind, "message");
    if (result.kind !== "message") {
      return;
    }

    assert.deepEqual(result.message.history, []);

    const [entry] = getFilteredServerLogs({
      search: "channels.slack_history_fetch_failed",
    });
    assert.ok(entry);
    assert.equal(entry.message, "channels.slack_history_fetch_failed");
    assert.deepEqual(entry.data, {
      channel: "C123",
      threadTs: "123.45",
      reason: "request_failed",
      error: "network down",
    });
  } finally {
    _resetLogBuffer();
  }
});

test("createSlackAdapter extractMessage omits the processing placeholder from thread history", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        assert.ok(String(input).includes("conversations.replies"));
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { text: "hello", ts: "123.45", user: "U123" },
              {
                text: "_Thinking..._",
                ts: "123.46",
                bot_id: "B123",
                subtype: "bot_message",
              },
              {
                text: "real answer",
                ts: "123.47",
                bot_id: "B123",
                subtype: "bot_message",
              },
              { text: "follow-up", ts: "123.48", user: "U123" },
            ],
          }),
          { status: 200 },
        );
      },
    },
  );

  const result = await adapter.extractMessage({
    type: "event_callback",
    event: {
      type: "message",
      text: "follow-up",
      channel: "C123",
      ts: "123.48",
      thread_ts: "123.45",
      user: "U123",
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.deepEqual(result.message.history, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "real answer" },
  ]);
});

test("createSlackAdapter sendReply updates an existing processing placeholder in place", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ ok: true, ts: "999.01" }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.update"));
  assert.deepEqual(JSON.parse(fetchCalls[0]?.init?.body as string), {
    channel: "C123",
    ts: "999.01",
    text: "reply text",
  });
});

test("createSlackAdapter sendReply falls back to post plus delete when placeholder update cannot be applied", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.update")) {
          return new Response(
            JSON.stringify({ ok: false, error: "message_not_found" }),
            { status: 200 },
          );
        }

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), {
            status: 200,
          });
        }

        if (String(input).includes("chat.delete")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
          });
        }

        throw new Error(`unexpected Slack URL: ${String(input)}`);
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 3);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.update"));
  assert.ok(String(fetchCalls[1]?.input).includes("chat.postMessage"));
  assert.ok(String(fetchCalls[2]?.input).includes("chat.delete"));
});

test("createSlackAdapter sendReply propagates non-retryable chat.update errors without fallback", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.update")) {
          return new Response(
            JSON.stringify({ ok: false, error: "channel_not_found" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await assert.rejects(
    adapter.sendReply(message, "reply text"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("error=channel_not_found"));
      return true;
    },
  );
});

test("createSlackAdapter sendReply without placeholder posts normally", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        fetchCalls.push({ input });
        return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.postMessage"));
});
