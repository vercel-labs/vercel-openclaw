import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  recordChannelLastForward,
  recordChannelUserVisibleReply,
} from "@/server/channels/last-forward";
import {
  _resetStoreForTesting,
  getInitializedMeta,
} from "@/server/store/store";
import type { ChannelLastForwardInput } from "@/shared/channels";

afterEach(() => {
  _resetStoreForTesting();
});

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

test("recordChannelLastForward defaults native forwards to unknown user-visible reply", async () => {
  await recordChannelLastForward("slack", lastForward());

  const meta = await getInitializedMeta();
  const forward = meta.channelDiagnostics?.slack?.lastForward;
  const deliveryState = meta.channelDiagnostics?.slack?.lastDeliveryState;

  assert.ok(forward);
  assert.equal(forward.userVisibleReply.status, "unknown");
  assert.equal(forward.userVisibleReply.source, "not-attempted");
  assert.equal(forward.userVisibleReply.reason, "native-forward-only");
  assert.ok(deliveryState);
  assert.equal(deliveryState.state, "visibility-unknown");
  assert.equal(deliveryState.finality, "terminal-revisable");
  assert.equal(deliveryState.reply?.status, "unknown");
});

test("recordChannelLastForward preserves explicit observed user-visible reply", async () => {
  await recordChannelLastForward(
    "telegram",
    lastForward({
      deliveryId: "delivery-2",
      userVisibleReply: {
        status: "observed",
        checkedAt: 1500,
        observedAt: 1500,
        timeoutMs: null,
        source: "platform-api",
        reason: "reply-found",
        evidence: { messageIdHash: "abc" },
      },
    }),
  );

  const meta = await getInitializedMeta();
  const forward = meta.channelDiagnostics?.telegram?.lastForward;
  const deliveryState = meta.channelDiagnostics?.telegram?.lastDeliveryState;

  assert.ok(forward);
  assert.equal(forward.userVisibleReply.status, "observed");
  assert.equal(forward.userVisibleReply.source, "platform-api");
  assert.ok(deliveryState);
  assert.equal(deliveryState.state, "reply-observed");
  assert.equal(deliveryState.reply?.status, "observed");
});

test("recordChannelLastForward maps failed forwards to latest-attempt delivery state", async () => {
  await recordChannelLastForward(
    "whatsapp",
    lastForward({
      ok: false,
      status: 404,
      classification: "handler-not-ready",
    }),
  );

  const meta = await getInitializedMeta();
  const deliveryState = meta.channelDiagnostics?.whatsapp?.lastDeliveryState;

  assert.ok(deliveryState);
  assert.equal(deliveryState.state, "native-forward-failed");
  assert.equal(deliveryState.finality, "latest-attempt");
  assert.equal(deliveryState.terminal, false);
  assert.equal(deliveryState.native?.classification, "handler-not-ready");
});

test("recordChannelUserVisibleReply only updates matching delivery id", async () => {
  await recordChannelLastForward("discord", lastForward({ deliveryId: "current" }));

  const staleUpdated = await recordChannelUserVisibleReply("discord", "old", {
    status: "timed-out",
    checkedAt: 2000,
    observedAt: null,
    timeoutMs: 30_000,
    source: "synthetic-canary",
    reason: "deadline-expired",
    evidence: null,
  });
  assert.equal(staleUpdated, false);

  let meta = await getInitializedMeta();
  assert.equal(meta.channelDiagnostics?.discord?.lastForward?.userVisibleReply.status, "unknown");

  const currentUpdated = await recordChannelUserVisibleReply("discord", "current", {
    status: "observed",
    checkedAt: 2100,
    observedAt: 2100,
    timeoutMs: null,
    source: "manual",
    reason: "operator-confirmed",
    evidence: null,
  });
  assert.equal(currentUpdated, true);

  meta = await getInitializedMeta();
  assert.equal(meta.channelDiagnostics?.discord?.lastForward?.userVisibleReply.status, "observed");
  assert.equal(meta.channelDiagnostics?.discord?.lastForward?.userVisibleReply.source, "manual");
  assert.equal(meta.channelDiagnostics?.discord?.lastDeliveryState?.state, "reply-observed");
  assert.equal(meta.channelDiagnostics?.discord?.lastDeliveryState?.reply?.source, "manual");
});
