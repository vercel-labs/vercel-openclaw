import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_DELIVERY_STATES,
  CHANNEL_DELIVERY_TERMINAL_STATES,
  CHANNEL_DELIVERY_TRANSITIONS,
  CHANNEL_NOTICE_STATES,
  assertChannelDeliveryTransitionHistory,
  channelDeliveryFromLastForward,
  applyUserVisibleReplyToChannelDelivery,
  createInitialChannelDeliverySnapshot,
  renderChannelDeliveryMermaid,
  transitionChannelDelivery,
  type ChannelDeliveryState,
} from "@/shared/channel-delivery";
import type { ChannelLastForwardInput } from "@/shared/channels";
import { normalizeChannelLastForward } from "@/shared/channels";

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

test("channel delivery model lists unique states and notice states", () => {
  assert.equal(new Set(CHANNEL_DELIVERY_STATES).size, CHANNEL_DELIVERY_STATES.length);
  assert.equal(new Set(CHANNEL_NOTICE_STATES).size, CHANNEL_NOTICE_STATES.length);
});

test("terminal delivery states are part of the full state set", () => {
  const states = new Set<ChannelDeliveryState>(CHANNEL_DELIVERY_STATES);
  for (const terminal of CHANNEL_DELIVERY_TERMINAL_STATES) {
    assert.equal(states.has(terminal), true, `${terminal} must be a known state`);
  }
});

test("all delivery states are reachable through the transition table or explicitly terminal", () => {
  const reached = new Set<ChannelDeliveryState>(
    CHANNEL_DELIVERY_TRANSITIONS.map((transition) => transition.to),
  );
  const terminal = new Set<ChannelDeliveryState>(CHANNEL_DELIVERY_TERMINAL_STATES as readonly ChannelDeliveryState[]);

  for (const state of CHANNEL_DELIVERY_STATES) {
    assert.equal(
      reached.has(state) || terminal.has(state),
      true,
      `${state} must be reachable or terminal`,
    );
  }
});

test("terminal delivery states do not have outgoing transitions except visibility reconciliation", () => {
  for (const state of CHANNEL_DELIVERY_TERMINAL_STATES) {
    const outgoing = CHANNEL_DELIVERY_TRANSITIONS.filter((transition) => transition.from === state);
    if (state === "visibility-unknown") {
      assert.deepEqual(
        outgoing.map((transition) => transition.event).sort(),
        ["reply-observation-started", "reply-observed"],
      );
      continue;
    }
    assert.deepEqual(outgoing, [], `${state} should not have outgoing transitions`);
  }
});

test("transitionChannelDelivery rejects illegal transitions", () => {
  const snapshot = createInitialChannelDeliverySnapshot({
    channel: "slack",
    deliveryId: "delivery-1",
    now: 100,
  });

  assert.throws(
    () => transitionChannelDelivery(snapshot, "native-forward-started"),
    /Illegal channel delivery transition/,
  );
});

test("visibility-unknown can be revised to reply-observed", () => {
  const snapshot = channelDeliveryFromLastForward({
    channel: "slack",
    lastForward: normalizeChannelLastForward(lastForward(), 1200)!,
    now: 1200,
  });

  assert.equal(snapshot.state, "visibility-unknown");
  const revised = transitionChannelDelivery(snapshot, "reply-observed", {
    updatedAt: 1400,
    reason: "platform-api-observed",
  });

  assert.equal(revised.state, "reply-observed");
  assert.equal(revised.finality, "terminal");
});

test("channelDeliveryFromLastForward maps accepted native forward to visibility-unknown", () => {
  const snapshot = channelDeliveryFromLastForward({
    channel: "telegram",
    lastForward: normalizeChannelLastForward(lastForward(), 1200)!,
    now: 1300,
  });

  assert.equal(snapshot.state, "visibility-unknown");
  assert.equal(snapshot.finality, "terminal-revisable");
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.native?.classification, "accepted");
  assert.equal(snapshot.reply?.status, "unknown");
});

test("channelDeliveryFromLastForward maps observed replies to reply-observed", () => {
  const snapshot = channelDeliveryFromLastForward({
    channel: "discord",
    lastForward: normalizeChannelLastForward(
      lastForward({
        userVisibleReply: {
          status: "observed",
          checkedAt: 1500,
          observedAt: 1500,
          timeoutMs: null,
          source: "platform-api",
          reason: "reply-found",
          evidence: null,
        },
      }),
      1500,
    )!,
    now: 1500,
  });

  assert.equal(snapshot.state, "reply-observed");
  assert.equal(snapshot.finality, "terminal");
  assert.equal(snapshot.reply?.status, "observed");
});

test("channelDeliveryFromLastForward maps failed forwards to non-terminal native-forward-failed", () => {
  const snapshot = channelDeliveryFromLastForward({
    channel: "whatsapp",
    lastForward: normalizeChannelLastForward(
      lastForward({
        ok: false,
        status: 404,
        classification: "handler-not-ready",
      }),
      1200,
    )!,
    now: 1300,
  });

  assert.equal(snapshot.state, "native-forward-failed");
  assert.equal(snapshot.finality, "latest-attempt");
  assert.equal(snapshot.terminal, false);
});

test("channelDeliveryFromLastForward produces legal transition histories", () => {
  const accepted = channelDeliveryFromLastForward({
    channel: "slack",
    lastForward: normalizeChannelLastForward(lastForward(), 1200)!,
    now: 1300,
  });
  const failed = channelDeliveryFromLastForward({
    channel: "whatsapp",
    lastForward: normalizeChannelLastForward(
      lastForward({ ok: false, status: 404, classification: "handler-not-ready" }),
      1200,
    )!,
    now: 1300,
  });

  assert.doesNotThrow(() => assertChannelDeliveryTransitionHistory(accepted));
  assert.doesNotThrow(() => assertChannelDeliveryTransitionHistory(failed));
});

test("applyUserVisibleReplyToChannelDelivery keeps reconciliation histories legal", () => {
  const snapshot = channelDeliveryFromLastForward({
    channel: "slack",
    lastForward: normalizeChannelLastForward(lastForward(), 1200)!,
    now: 1300,
  });

  const observed = applyUserVisibleReplyToChannelDelivery({
    current: snapshot,
    channel: "slack",
    deliveryId: "delivery-1",
    now: 1400,
    userVisibleReply: {
      status: "observed",
      checkedAt: 1400,
      observedAt: 1400,
      timeoutMs: null,
      source: "platform-api",
      reason: "reply-found",
      evidence: null,
    },
  });
  const timedOut = applyUserVisibleReplyToChannelDelivery({
    current: snapshot,
    channel: "slack",
    deliveryId: "delivery-1",
    now: 1500,
    userVisibleReply: {
      status: "timed-out",
      checkedAt: 1500,
      observedAt: null,
      timeoutMs: 30_000,
      source: "synthetic-canary",
      reason: "deadline-expired",
      evidence: null,
    },
  });

  assert.ok(observed);
  assert.ok(timedOut);
  assert.doesNotThrow(() => assertChannelDeliveryTransitionHistory(observed));
  assert.doesNotThrow(() => assertChannelDeliveryTransitionHistory(timedOut));
});

test("renderChannelDeliveryMermaid renders transition source", () => {
  const mermaid = renderChannelDeliveryMermaid();

  assert.match(mermaid, /^stateDiagram-v2/);
  assert.match(mermaid, /fast-path-forwarding --> visibility-unknown: fast-path-accepted/);
  assert.match(mermaid, /visibility-unknown --> reply-observed: reply-observed/);
});
