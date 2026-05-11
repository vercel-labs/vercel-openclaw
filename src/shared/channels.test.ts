import assert from "node:assert/strict";
import test from "node:test";

import {
  createUnknownUserVisibleReply,
  isChannelUserVisibleReply,
  normalizeChannelLastForward,
  type ChannelLastForwardInput,
} from "@/shared/channels";

function lastForward(overrides: Partial<ChannelLastForwardInput> = {}): ChannelLastForwardInput {
  return {
    ok: true,
    status: 200,
    classification: "accepted",
    attempts: 1,
    totalMs: 25,
    transport: "public",
    sandboxUrl: "https://sandbox.example.com",
    sandboxId: "sbx-test",
    finalReasonHead: null,
    startedAt: 1000,
    completedAt: 1200,
    deliveryId: "delivery-1",
    ...overrides,
  };
}

test("normalizeChannelLastForward hydrates legacy forwards with unknown user-visible reply", () => {
  const normalized = normalizeChannelLastForward(lastForward());

  assert.ok(normalized);
  assert.equal(normalized.userVisibleReply.status, "unknown");
  assert.equal(normalized.userVisibleReply.source, "not-attempted");
  assert.equal(normalized.userVisibleReply.reason, "native-forward-only");
  assert.equal(normalized.userVisibleReply.checkedAt, 1200);
  assert.equal(normalized.userVisibleReply.observedAt, null);
  assert.equal(normalized.userVisibleReply.timeoutMs, null);
});

test("normalizeChannelLastForward preserves explicit observed user-visible reply", () => {
  const observed = {
    status: "observed" as const,
    checkedAt: 1500,
    observedAt: 1500,
    timeoutMs: null,
    source: "platform-api" as const,
    reason: "reply-found",
    evidence: { messageIdHash: "abc" },
  };

  const normalized = normalizeChannelLastForward(
    lastForward({ userVisibleReply: observed }),
  );

  assert.ok(normalized);
  assert.deepEqual(normalized.userVisibleReply, observed);
});

test("normalizeChannelLastForward strips unknown fields and unsafe reply evidence", () => {
  const normalized = normalizeChannelLastForward({
    ...lastForward({
      userVisibleReply: {
        status: "observed",
        checkedAt: 1500,
        observedAt: 1500,
        timeoutMs: null,
        source: "platform-api",
        reason: "reply-found",
        evidence: {
          messageIdHash: "safe-hash",
          rawPayload: { token: "secret" },
          authorization: "Bearer secret",
          botToken: "xoxb-secret",
        },
      },
    }),
    rawPayload: { token: "secret" },
    headers: { authorization: "Bearer secret" },
  });

  assert.ok(normalized);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "rawPayload"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "headers"), false);
  assert.deepEqual(normalized.userVisibleReply.evidence, { messageIdHash: "safe-hash" });
});

test("isChannelUserVisibleReply validates status-specific fields", () => {
  assert.equal(isChannelUserVisibleReply(createUnknownUserVisibleReply(1)), true);
  assert.equal(
    isChannelUserVisibleReply({
      status: "observed",
      checkedAt: 2,
      observedAt: 2,
      timeoutMs: null,
      source: "manual",
      reason: "operator-confirmed",
    }),
    true,
  );
  assert.equal(
    isChannelUserVisibleReply({
      status: "observed",
      checkedAt: 2,
      observedAt: null,
      timeoutMs: null,
      source: "manual",
      reason: "missing-observed-at",
    }),
    false,
  );
  assert.equal(
    isChannelUserVisibleReply({
      status: "timed-out",
      checkedAt: 3,
      observedAt: null,
      timeoutMs: 30_000,
      source: "synthetic-canary",
      reason: "deadline-expired",
    }),
    true,
  );
  assert.equal(
    isChannelUserVisibleReply({
      status: "timed-out",
      checkedAt: 3,
      observedAt: null,
      timeoutMs: null,
      source: "synthetic-canary",
      reason: "missing-timeout",
    }),
    false,
  );
});
