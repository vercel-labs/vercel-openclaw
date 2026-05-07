import type { ChannelName } from "@/shared/channels";

export const ForwardClassification = {
  Accepted: "accepted",
  SandboxNotListening: "sandbox-not-listening",
  ProxyError: "proxy-error",
  HandlerNotReady: "handler-not-ready",
  HandlerError: "handler-error",
  FetchException: "fetch-exception",
  SwallowedByBaseServer: "swallowed-by-base-server",
  Exhausted: "exhausted",
} as const;

export type ForwardClassification =
  (typeof ForwardClassification)[keyof typeof ForwardClassification];

export const FastPathOutcomeKind = {
  NotAttempted: "not-attempted",
  Accepted: "accepted",
  FallbackToWorkflow: "fallback-to-workflow",
  HandledNoWorkflow: "handled-no-workflow",
} as const;

export type FastPathOutcomeKind =
  (typeof FastPathOutcomeKind)[keyof typeof FastPathOutcomeKind];

export const FastPathSkipReason = {
  SandboxStatusNotRunning: "sandbox-status-not-running",
  MissingSandboxId: "missing-sandbox-id",
  ChannelHasNoFastPath: "channel-has-no-fast-path",
  UnsupportedPayload: "unsupported-payload",
  GatewayNotReady: "gateway-not-ready",
} as const;

export type FastPathSkipReason =
  (typeof FastPathSkipReason)[keyof typeof FastPathSkipReason];

export const FastPathFallbackReason = {
  SandboxNotListening: "sandbox-not-listening",
  ProxyError: "proxy-error",
  HandlerNotReady: "handler-not-ready",
  HandlerErrorPolicyStartWorkflow: "handler-error-policy-start-workflow",
  SuspiciousEmpty200: "suspicious-empty-200",
  SwallowedByBaseServer: "swallowed-by-base-server",
  FetchException: "fetch-exception",
  FastPathTimeout: "fast-path-timeout",
  RouteRepairFailed: "route-repair-failed",
  GatewayHealthReconcile: "gateway-health-reconcile",
} as const;

export type FastPathFallbackReason =
  (typeof FastPathFallbackReason)[keyof typeof FastPathFallbackReason];

export const FastPathHandledNoWorkflowReason = {
  HandlerResponseReceived: "handler-response-received",
  NonGatewayHandlerResponse: "non-gateway-handler-response",
  PlatformNoop: "platform-noop",
} as const;

export type FastPathHandledNoWorkflowReason =
  (typeof FastPathHandledNoWorkflowReason)[keyof typeof FastPathHandledNoWorkflowReason];

export type FastPathTransport = "public" | "local";

export type FastPathOutcome =
  | {
      kind: typeof FastPathOutcomeKind.NotAttempted;
      reason: FastPathSkipReason;
      initialStatus: string;
      sandboxId: string | null;
    }
  | {
      kind: typeof FastPathOutcomeKind.Accepted;
      classification: typeof ForwardClassification.Accepted;
      status: number;
      transport: FastPathTransport;
      sandboxUrl: string | null;
      sandboxId: string | null;
      bodyHead: string | null;
      durationMs: number;
    }
  | {
      kind: typeof FastPathOutcomeKind.FallbackToWorkflow;
      reason: FastPathFallbackReason;
      classification: Exclude<ForwardClassification, "accepted">;
      status: number | null;
      transport: FastPathTransport | null;
      sandboxUrl: string | null;
      sandboxId: string | null;
      bodyHead: string | null;
      errorMessage?: string | null;
      durationMs: number;
      shouldReconcile: boolean;
      stalePort?: number | null;
      stalePortReason?: "fast-path-not-listening" | null;
      indeterminateDelivery?: boolean;
    }
  | {
      kind: typeof FastPathOutcomeKind.HandledNoWorkflow;
      reason: FastPathHandledNoWorkflowReason;
      classification: Exclude<ForwardClassification, "accepted">;
      status: number;
      transport: FastPathTransport;
      sandboxUrl: string | null;
      sandboxId: string | null;
      bodyHead: string | null;
      durationMs: number;
    };

export const WorkflowStartReason = {
  ColdSandbox: "cold-sandbox",
  FastPathSkipped: "fast-path-skipped",
  FastPathFallback: "fast-path-fallback",
  GatewayNotReady: "gateway-not-ready",
  PlatformDeferred: "platform-deferred",
} as const;

export type WorkflowStartReason =
  (typeof WorkflowStartReason)[keyof typeof WorkflowStartReason];

export const UserNoticeReason = {
  ColdSandbox: "cold-sandbox",
  FastPathFallback: "fast-path-fallback",
  StaleRunningReconciled: "stale-running-reconciled",
  GatewayNotReady: "gateway-not-ready",
  FastPathAccepted: "fast-path-accepted",
  HandledNoWorkflow: "handled-no-workflow",
  Duplicate: "duplicate",
  NoRecipient: "no-recipient",
  ChannelCannotSendWebhookNotice: "channel-cannot-send-webhook-notice",
  PlatformAlreadyDeferred: "platform-already-deferred",
} as const;

export type UserNoticeReason =
  (typeof UserNoticeReason)[keyof typeof UserNoticeReason];

export type UserNoticePlan =
  | {
      kind: "send-before-workflow";
      reason: Extract<
        UserNoticeReason,
        | "cold-sandbox"
        | "fast-path-fallback"
        | "stale-running-reconciled"
        | "gateway-not-ready"
      >;
      textKey: "waking-up";
    }
  | {
      kind: "do-not-send";
      reason: Extract<
        UserNoticeReason,
        | "fast-path-accepted"
        | "handled-no-workflow"
        | "duplicate"
        | "no-recipient"
        | "channel-cannot-send-webhook-notice"
        | "platform-already-deferred"
      >;
    };

export const WebhookRouteOutcome = {
  Reject: "reject",
  AckNoop: "ack-noop",
  AckDuplicate: "ack-duplicate",
  FastPathAccepted: "fast-path-accepted",
  StartWorkflow: "start-workflow",
  WorkflowStartFailed: "workflow-start-failed",
} as const;

export type WebhookRouteOutcome =
  (typeof WebhookRouteOutcome)[keyof typeof WebhookRouteOutcome];

export type WebhookPlan = {
  channel: ChannelName;
  routeOutcome: WebhookRouteOutcome;
  fastPath: FastPathOutcome | null;
  userNotice: UserNoticePlan;
  workflow:
    | { kind: "start"; reason: WorkflowStartReason }
    | { kind: "do-not-start"; reason: string };
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
