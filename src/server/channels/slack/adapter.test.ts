import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import {
  createSlackAdapter,
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
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
