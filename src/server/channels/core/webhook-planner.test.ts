import assert from "node:assert/strict";
import test from "node:test";

import { planWebhookAfterFastPath } from "@/server/channels/core/webhook-planner";
import type { FastPathOutcome } from "@/server/channels/core/outcomes";

const fallbackOutcome: FastPathOutcome = {
  kind: "fallback-to-workflow",
  reason: "sandbox-not-listening",
  classification: "sandbox-not-listening",
  status: 502,
  transport: "public",
  sandboxUrl: "https://stale-8787.example",
  sandboxId: "sbx",
  bodyHead: "This sandbox is not listening on the requested port.",
  durationMs: 20,
  shouldReconcile: true,
  stalePort: 8787,
  stalePortReason: "fast-path-not-listening",
};

test("webhook planner: fast-path fallback sends notice even when status is running", () => {
  const plan = planWebhookAfterFastPath({
    channel: "telegram",
    effectiveStatus: "running",
    canSendUserNotice: true,
    policy: { noticeOnWorkflowStart: true },
    fastPath: fallbackOutcome,
  });

  assert.equal(plan.routeOutcome, "start-workflow");
  assert.deepEqual(plan.workflow, {
    kind: "start",
    reason: "fast-path-fallback",
  });
  assert.deepEqual(plan.userNotice, {
    kind: "send-before-workflow",
    reason: "fast-path-fallback",
    textKey: "waking-up",
  });
});

test("webhook planner: fast-path accepted starts no workflow and sends no notice", () => {
  const plan = planWebhookAfterFastPath({
    channel: "telegram",
    effectiveStatus: "running",
    canSendUserNotice: true,
    policy: { noticeOnWorkflowStart: true },
    fastPath: {
      kind: "accepted",
      classification: "accepted",
      status: 200,
      transport: "public",
      sandboxUrl: "https://sbx.example",
      sandboxId: "sbx",
      bodyHead: "ok",
      durationMs: 250,
    },
  });

  assert.equal(plan.routeOutcome, "fast-path-accepted");
  assert.equal(plan.workflow.kind, "do-not-start");
  assert.deepEqual(plan.userNotice, {
    kind: "do-not-send",
    reason: "fast-path-accepted",
  });
});

test("webhook planner: cold sandbox without fast path sends notice", () => {
  const plan = planWebhookAfterFastPath({
    channel: "telegram",
    effectiveStatus: "suspended",
    canSendUserNotice: true,
    policy: { noticeOnWorkflowStart: true },
    fastPath: {
      kind: "not-attempted",
      reason: "sandbox-status-not-running",
      initialStatus: "suspended",
      sandboxId: "sbx",
    },
  });

  assert.deepEqual(plan.workflow, { kind: "start", reason: "cold-sandbox" });
  assert.deepEqual(plan.userNotice, {
    kind: "send-before-workflow",
    reason: "cold-sandbox",
    textKey: "waking-up",
  });
});

test("webhook planner: gateway-not-ready sends notice even while status is running", () => {
  const plan = planWebhookAfterFastPath({
    channel: "slack",
    effectiveStatus: "running",
    canSendUserNotice: true,
    policy: { noticeOnWorkflowStart: true },
    fastPath: {
      kind: "not-attempted",
      reason: "gateway-not-ready",
      initialStatus: "running",
      sandboxId: "sbx",
    },
  });

  assert.deepEqual(plan.workflow, { kind: "start", reason: "gateway-not-ready" });
  assert.deepEqual(plan.userNotice, {
    kind: "send-before-workflow",
    reason: "gateway-not-ready",
    textKey: "waking-up",
  });
});

test("webhook planner: fallback without recipient still starts workflow but sends no notice", () => {
  const plan = planWebhookAfterFastPath({
    channel: "telegram",
    effectiveStatus: "running",
    canSendUserNotice: false,
    policy: { noticeOnWorkflowStart: true },
    fastPath: fallbackOutcome,
  });

  assert.deepEqual(plan.workflow, {
    kind: "start",
    reason: "fast-path-fallback",
  });
  assert.deepEqual(plan.userNotice, {
    kind: "do-not-send",
    reason: "no-recipient",
  });
});

test("webhook planner: handled-no-workflow sends no notice and starts no workflow", () => {
  const plan = planWebhookAfterFastPath({
    channel: "whatsapp",
    effectiveStatus: "running",
    canSendUserNotice: true,
    policy: { noticeOnWorkflowStart: true },
    fastPath: {
      kind: "handled-no-workflow",
      reason: "non-gateway-handler-response",
      classification: "handler-error",
      status: 500,
      transport: "public",
      sandboxUrl: "https://sbx.example",
      sandboxId: "sbx",
      bodyHead: "handler errored after receipt",
      durationMs: 25,
    },
  });

  assert.equal(plan.routeOutcome, "ack-noop");
  assert.equal(plan.workflow.kind, "do-not-start");
  assert.deepEqual(plan.userNotice, {
    kind: "do-not-send",
    reason: "handled-no-workflow",
  });
});
