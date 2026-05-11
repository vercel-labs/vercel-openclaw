import {
  createDefaultNoticeSnapshot,
  transitionChannelDelivery,
  type ChannelDeliveryEvent,
  type ChannelDeliverySnapshot,
  type ChannelFastPathSnapshot,
  type ChannelNoticeSnapshot,
  type ChannelWorkflowSnapshot,
} from "@/shared/channel-delivery";
import { createInitialChannelDeliverySnapshot } from "@/shared/channel-delivery";
import type { ChannelName } from "@/shared/channels";
import {
  FastPathOutcomeKind,
  UserNoticeReason,
  WebhookRouteOutcome,
  type FastPathOutcome,
  type UserNoticePlan,
  type WebhookPlan,
} from "@/server/channels/core/outcomes";

export function channelNoticeFromUserNoticePlan(input: {
  plan: UserNoticePlan;
  now?: number;
}): ChannelNoticeSnapshot {
  const now = input.now ?? Date.now();
  if (input.plan.kind === "send-before-workflow") {
    return createDefaultNoticeSnapshot({
      state: "send-pending",
      reason: input.plan.reason,
      updatedAt: now,
    });
  }
  if (
    input.plan.reason === UserNoticeReason.NoRecipient ||
    input.plan.reason === UserNoticeReason.ChannelCannotSendWebhookNotice
  ) {
    return createDefaultNoticeSnapshot({
      state: "unavailable",
      reason: input.plan.reason,
      updatedAt: now,
    });
  }
  return createDefaultNoticeSnapshot({
    state: "not-needed",
    reason: input.plan.reason,
    updatedAt: now,
  });
}

function withTransitionHistory(
  base: ChannelDeliverySnapshot,
  events: ChannelDeliveryEvent[],
  now: number,
  reason: string | null,
): ChannelDeliverySnapshot["transitions"] {
  let snapshot = base;
  for (const event of events) {
    snapshot = transitionChannelDelivery(snapshot, event, {
      updatedAt: now,
      reason,
    });
  }
  return snapshot.transitions;
}

function fastPathSnapshot(fastPath: FastPathOutcome): ChannelFastPathSnapshot {
  return {
    kind: fastPath.kind,
    reason: "reason" in fastPath ? fastPath.reason : null,
    classification: "classification" in fastPath ? fastPath.classification : null,
    status: "status" in fastPath ? fastPath.status : null,
    transport: "transport" in fastPath ? fastPath.transport : null,
    sandboxUrl: "sandboxUrl" in fastPath ? fastPath.sandboxUrl : null,
    sandboxId: fastPath.sandboxId,
    indeterminateDelivery:
      fastPath.kind === FastPathOutcomeKind.FallbackToWorkflow &&
      fastPath.indeterminateDelivery === true,
  };
}

function workflowSnapshot(plan: WebhookPlan, now: number): ChannelWorkflowSnapshot | null {
  if (plan.workflow.kind !== "start") {
    return null;
  }
  return {
    planned: true,
    startReason: plan.workflow.reason,
    startedAt: null,
    startFailedAt: plan.routeOutcome === WebhookRouteOutcome.WorkflowStartFailed ? now : null,
  };
}

export function channelDeliveryFromFastPathOutcome(input: {
  channel: ChannelName;
  deliveryId: string | null;
  fastPath: FastPathOutcome;
  receivedAt?: number | null;
  now?: number;
}): ChannelDeliverySnapshot {
  const now = input.now ?? Date.now();
  const base = createInitialChannelDeliverySnapshot({
    channel: input.channel,
    deliveryId: input.deliveryId,
    receivedAt: input.receivedAt ?? null,
    now,
    source: "fast-path-outcome",
  });
  const fastPath = fastPathSnapshot(input.fastPath);

  if (input.fastPath.kind === FastPathOutcomeKind.Accepted) {
    return {
      ...base,
      state: "visibility-unknown",
      finality: "terminal-revisable",
      terminal: true,
      completedAt: now,
      updatedAt: now,
      reason: "fast-path-accepted",
      fastPath,
      transitions: withTransitionHistory(base, ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-accepted"], now, "fast-path-accepted"),
    };
  }
  if (input.fastPath.kind === FastPathOutcomeKind.HandledNoWorkflow) {
    return {
      ...base,
      state: "accepted-noop",
      finality: "terminal",
      terminal: true,
      completedAt: now,
      updatedAt: now,
      reason: input.fastPath.reason,
      fastPath,
      transitions: withTransitionHistory(base, ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-accepted-noop"], now, input.fastPath.reason),
    };
  }
  return {
    ...base,
    state: "workflow-planned",
    finality: "in-progress",
    terminal: false,
    updatedAt: now,
    reason: "reason" in input.fastPath ? input.fastPath.reason : null,
    fastPath,
    workflow: {
      planned: true,
      startReason: input.fastPath.kind === FastPathOutcomeKind.FallbackToWorkflow
        ? "fast-path-fallback"
        : "fast-path-skipped",
      startedAt: null,
      startFailedAt: null,
    },
    transitions: withTransitionHistory(
      base,
      input.fastPath.kind === FastPathOutcomeKind.FallbackToWorkflow
        ? ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-fallback"]
        : ["validated", "dedup-checked", "workflow-planned"],
      now,
      "reason" in input.fastPath ? input.fastPath.reason : null,
    ),
  };
}

export function channelDeliveryFromWebhookPlan(input: {
  channel: ChannelName;
  deliveryId: string | null;
  plan: WebhookPlan;
  receivedAt?: number | null;
  now?: number;
}): ChannelDeliverySnapshot {
  const now = input.now ?? Date.now();
  const base = createInitialChannelDeliverySnapshot({
    channel: input.channel,
    deliveryId: input.deliveryId,
    receivedAt: input.receivedAt ?? null,
    now,
    source: "webhook-plan",
  });
  const notice = channelNoticeFromUserNoticePlan({ plan: input.plan.userNotice, now });
  const fastPath = input.plan.fastPath ? fastPathSnapshot(input.plan.fastPath) : null;
  const workflow = workflowSnapshot(input.plan, now);

  switch (input.plan.routeOutcome) {
    case WebhookRouteOutcome.Reject:
      return { ...base, state: "rejected", finality: "terminal", terminal: true, completedAt: now, updatedAt: now, routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow, transitions: withTransitionHistory(base, ["validation-rejected"], now, input.plan.workflow.reason) };
    case WebhookRouteOutcome.AckDuplicate:
      return { ...base, state: "duplicate", finality: "terminal", terminal: true, completedAt: now, updatedAt: now, routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow, transitions: withTransitionHistory(base, ["validated", "duplicate-detected"], now, input.plan.workflow.reason) };
    case WebhookRouteOutcome.AckNoop:
      return { ...base, state: "accepted-noop", finality: "terminal", terminal: true, completedAt: now, updatedAt: now, routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow, transitions: withTransitionHistory(base, ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-accepted-noop"], now, input.plan.workflow.reason) };
    case WebhookRouteOutcome.FastPathAccepted:
      return { ...base, state: "visibility-unknown", finality: "terminal-revisable", terminal: true, completedAt: now, updatedAt: now, reason: "fast-path-accepted", routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow, transitions: withTransitionHistory(base, ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-accepted"], now, "fast-path-accepted") };
    case WebhookRouteOutcome.WorkflowStartFailed:
      return { ...base, state: "workflow-start-failed", finality: "terminal", terminal: true, completedAt: now, updatedAt: now, routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow: workflow ?? { planned: true, startReason: null, startedAt: null, startFailedAt: now }, transitions: withTransitionHistory(base, ["validated", "dedup-checked", "workflow-planned", "workflow-start-failed"], now, input.plan.workflow.reason) };
    case WebhookRouteOutcome.StartWorkflow:
      return { ...base, state: "workflow-planned", finality: "in-progress", terminal: false, updatedAt: now, routeOutcome: input.plan.routeOutcome, notice, fastPath, workflow: workflow ?? { planned: true, startReason: null, startedAt: null, startFailedAt: null }, transitions: withTransitionHistory(base, ["validated", "dedup-checked", "workflow-planned"], now, input.plan.workflow.reason) };
  }
}
