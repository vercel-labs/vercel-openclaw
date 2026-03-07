import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackAdapter,
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";

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
