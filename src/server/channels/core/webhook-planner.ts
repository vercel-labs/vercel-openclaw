import type { ChannelName } from "@/shared/channels";
import {
  FastPathOutcomeKind,
  FastPathSkipReason,
  UserNoticeReason,
  WebhookRouteOutcome,
  WorkflowStartReason,
  assertNever,
  type FastPathOutcome,
  type UserNoticePlan,
  type WebhookPlan,
} from "@/server/channels/core/outcomes";

export type WebhookPlannerPolicy = {
  noticeOnWorkflowStart: boolean;
};

export type PlanWebhookAfterFastPathInput = {
  channel: ChannelName;
  fastPath: FastPathOutcome;
  effectiveStatus: string;
  canSendUserNotice: boolean;
  policy: WebhookPlannerPolicy;
};

function workflowNotice(input: {
  policy: WebhookPlannerPolicy;
  canSendUserNotice: boolean;
  reason: Extract<UserNoticePlan, { kind: "send-before-workflow" }>["reason"];
}): UserNoticePlan {
  if (input.policy.noticeOnWorkflowStart && input.canSendUserNotice) {
    return {
      kind: "send-before-workflow",
      reason: input.reason,
      textKey: "waking-up",
    };
  }

  return {
    kind: "do-not-send",
    reason: input.canSendUserNotice
      ? UserNoticeReason.ChannelCannotSendWebhookNotice
      : UserNoticeReason.NoRecipient,
  };
}

export function planWebhookAfterFastPath(
  input: PlanWebhookAfterFastPathInput,
): WebhookPlan {
  const { channel, fastPath, effectiveStatus, policy, canSendUserNotice } = input;

  switch (fastPath.kind) {
    case FastPathOutcomeKind.Accepted:
      return {
        channel,
        routeOutcome: WebhookRouteOutcome.FastPathAccepted,
        fastPath,
        workflow: { kind: "do-not-start", reason: "fast-path-accepted" },
        userNotice: {
          kind: "do-not-send",
          reason: UserNoticeReason.FastPathAccepted,
        },
      };

    case FastPathOutcomeKind.HandledNoWorkflow:
      return {
        channel,
        routeOutcome: WebhookRouteOutcome.AckNoop,
        fastPath,
        workflow: { kind: "do-not-start", reason: fastPath.reason },
        userNotice: {
          kind: "do-not-send",
          reason: UserNoticeReason.HandledNoWorkflow,
        },
      };

    case FastPathOutcomeKind.FallbackToWorkflow:
      return {
        channel,
        routeOutcome: WebhookRouteOutcome.StartWorkflow,
        fastPath,
        workflow: {
          kind: "start",
          reason: WorkflowStartReason.FastPathFallback,
        },
        userNotice: workflowNotice({
          policy,
          canSendUserNotice,
          reason: UserNoticeReason.FastPathFallback,
        }),
      };

    case FastPathOutcomeKind.NotAttempted: {
      if (fastPath.reason === FastPathSkipReason.GatewayNotReady) {
        return {
          channel,
          routeOutcome: WebhookRouteOutcome.StartWorkflow,
          fastPath,
          workflow: {
            kind: "start",
            reason: WorkflowStartReason.GatewayNotReady,
          },
          userNotice: workflowNotice({
            policy,
            canSendUserNotice,
            reason: UserNoticeReason.GatewayNotReady,
          }),
        };
      }

      const cold = effectiveStatus !== "running";
      const workflowReason =
        cold
            ? WorkflowStartReason.ColdSandbox
            : WorkflowStartReason.FastPathSkipped;
      return {
        channel,
        routeOutcome: WebhookRouteOutcome.StartWorkflow,
        fastPath,
        workflow: {
          kind: "start",
          reason: workflowReason,
        },
        userNotice: cold
          ? workflowNotice({
              policy,
              canSendUserNotice,
              reason: UserNoticeReason.ColdSandbox,
            })
          : {
              kind: "do-not-send",
              reason: canSendUserNotice
                ? UserNoticeReason.ChannelCannotSendWebhookNotice
                : UserNoticeReason.NoRecipient,
            },
      };
    }

    default:
      return assertNever(fastPath);
  }
}
