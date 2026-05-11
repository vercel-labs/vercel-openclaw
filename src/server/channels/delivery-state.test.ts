import assert from "node:assert/strict";
import test from "node:test";

import {
  channelDeliveryFromFastPathOutcome,
  channelDeliveryFromWebhookPlan,
  channelNoticeFromUserNoticePlan,
} from "@/server/channels/delivery-state";
import { assertChannelDeliveryTransitionHistory } from "@/shared/channel-delivery";
import type { FastPathOutcome, WebhookPlan } from "@/server/channels/core/outcomes";

const acceptedFastPath: FastPathOutcome = {
  kind: "accepted",
  classification: "accepted",
  status: 200,
  transport: "public",
  sandboxUrl: "https://sandbox.example.com",
  sandboxId: "sbx-test",
  bodyHead: "ok",
  durationMs: 25,
};

test("channelDeliveryFromFastPathOutcome maps accepted fast path to visibility-unknown", () => {
  const state = channelDeliveryFromFastPathOutcome({
    channel: "slack",
    deliveryId: "delivery-1",
    fastPath: acceptedFastPath,
    now: 1000,
  });

  assert.equal(state.state, "visibility-unknown");
  assert.equal(state.fastPath?.classification, "accepted");
});

test("channelDeliveryFromFastPathOutcome maps handled-no-workflow to accepted-noop", () => {
  const state = channelDeliveryFromFastPathOutcome({
    channel: "slack",
    deliveryId: "delivery-1",
    now: 1000,
    fastPath: {
      kind: "handled-no-workflow",
      reason: "platform-noop",
      classification: "handler-error",
      status: 200,
      transport: "public",
      sandboxUrl: "https://sandbox.example.com",
      sandboxId: "sbx-test",
      bodyHead: "ignored",
      durationMs: 15,
    },
  });

  assert.equal(state.state, "accepted-noop");
  assert.equal(state.finality, "terminal");
  assert.equal(state.fastPath?.kind, "handled-no-workflow");
});

test("channelDeliveryFromFastPathOutcome preserves indeterminate fallback metadata", () => {
  const state = channelDeliveryFromFastPathOutcome({
    channel: "telegram",
    deliveryId: "delivery-1",
    now: 1000,
    fastPath: {
      kind: "fallback-to-workflow",
      reason: "fast-path-timeout",
      classification: "fetch-exception",
      status: null,
      transport: "public",
      sandboxUrl: "https://sandbox.example.com",
      sandboxId: "sbx-test",
      bodyHead: "TimeoutError",
      durationMs: 5000,
      shouldReconcile: true,
      indeterminateDelivery: true,
    },
  });

  assert.equal(state.state, "workflow-planned");
  assert.equal(state.fastPath?.indeterminateDelivery, true);
});

test("channelNoticeFromUserNoticePlan maps workflow notice to send-pending", () => {
  const notice = channelNoticeFromUserNoticePlan({
    now: 1000,
    plan: {
      kind: "send-before-workflow",
      reason: "cold-sandbox",
      textKey: "waking-up",
    },
  });

  assert.equal(notice.state, "send-pending");
  assert.equal(notice.reason, "cold-sandbox");
});

test("channelNoticeFromUserNoticePlan maps no-recipient to unavailable", () => {
  const notice = channelNoticeFromUserNoticePlan({
    now: 1000,
    plan: {
      kind: "do-not-send",
      reason: "no-recipient",
    },
  });

  assert.equal(notice.state, "unavailable");
  assert.equal(notice.reason, "no-recipient");
});

test("channelDeliveryFromWebhookPlan maps start-workflow plan", () => {
  const plan: WebhookPlan = {
    channel: "telegram",
    routeOutcome: "start-workflow",
    fastPath: {
      kind: "not-attempted",
      reason: "sandbox-status-not-running",
      initialStatus: "stopped",
      sandboxId: "sbx-test",
    },
    userNotice: {
      kind: "send-before-workflow",
      reason: "cold-sandbox",
      textKey: "waking-up",
    },
    workflow: {
      kind: "start",
      reason: "cold-sandbox",
    },
  };

  const state = channelDeliveryFromWebhookPlan({
    channel: "telegram",
    deliveryId: "delivery-1",
    plan,
    now: 1000,
  });

  assert.equal(state.state, "workflow-planned");
  assert.equal(state.workflow?.startReason, "cold-sandbox");
  assert.equal(state.notice.state, "send-pending");
});

test("channelDeliveryFromWebhookPlan maps reject plan", () => {
  const plan: WebhookPlan = {
    channel: "discord",
    routeOutcome: "reject",
    fastPath: null,
    userNotice: {
      kind: "do-not-send",
      reason: "platform-already-deferred",
    },
    workflow: {
      kind: "do-not-start",
      reason: "invalid-signature",
    },
  };

  const state = channelDeliveryFromWebhookPlan({
    channel: "discord",
    deliveryId: "delivery-1",
    plan,
    now: 1000,
  });

  assert.equal(state.state, "rejected");
  assert.equal(state.routeOutcome, "reject");
  assert.equal(state.terminal, true);
});

test("channelDeliveryFromWebhookPlan maps workflow-start-failed plan", () => {
  const plan: WebhookPlan = {
    channel: "whatsapp",
    routeOutcome: "workflow-start-failed",
    fastPath: acceptedFastPath,
    userNotice: {
      kind: "do-not-send",
      reason: "fast-path-accepted",
    },
    workflow: {
      kind: "start",
      reason: "fast-path-fallback",
    },
  };

  const state = channelDeliveryFromWebhookPlan({
    channel: "whatsapp",
    deliveryId: "delivery-1",
    plan,
    now: 1000,
  });

  assert.equal(state.state, "workflow-start-failed");
  assert.equal(state.workflow?.planned, true);
  assert.equal(state.workflow?.startFailedAt, 1000);
  assert.equal(state.terminal, true);
});

test("channelDeliveryFromWebhookPlan maps duplicate plan", () => {
  const plan: WebhookPlan = {
    channel: "slack",
    routeOutcome: "ack-duplicate",
    fastPath: null,
    userNotice: {
      kind: "do-not-send",
      reason: "duplicate",
    },
    workflow: {
      kind: "do-not-start",
      reason: "duplicate",
    },
  };

  const state = channelDeliveryFromWebhookPlan({
    channel: "slack",
    deliveryId: "delivery-1",
    plan,
    now: 1000,
  });

  assert.equal(state.state, "duplicate");
  assert.equal(state.terminal, true);
  assert.equal(state.notice.state, "not-needed");
});

test("projection wrappers produce legal transition histories", () => {
  const snapshots = [
    channelDeliveryFromFastPathOutcome({
      channel: "slack",
      deliveryId: "delivery-1",
      fastPath: acceptedFastPath,
      now: 1000,
    }),
    channelDeliveryFromFastPathOutcome({
      channel: "telegram",
      deliveryId: "delivery-2",
      now: 1000,
      fastPath: {
        kind: "fallback-to-workflow",
        reason: "fast-path-timeout",
        classification: "fetch-exception",
        status: null,
        transport: "public",
        sandboxUrl: "https://sandbox.example.com",
        sandboxId: "sbx-test",
        bodyHead: "TimeoutError",
        durationMs: 5000,
        shouldReconcile: true,
        indeterminateDelivery: true,
      },
    }),
    channelDeliveryFromWebhookPlan({
      channel: "whatsapp",
      deliveryId: "delivery-3",
      now: 1000,
      plan: {
        channel: "whatsapp",
        routeOutcome: "workflow-start-failed",
        fastPath: null,
        userNotice: { kind: "do-not-send", reason: "platform-already-deferred" },
        workflow: { kind: "start", reason: "fast-path-fallback" },
      },
    }),
  ];

  for (const snapshot of snapshots) {
    assert.doesNotThrow(() => assertChannelDeliveryTransitionHistory(snapshot));
  }
});
