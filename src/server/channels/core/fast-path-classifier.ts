import type { ChannelName } from "@/shared/channels";
import {
  FastPathFallbackReason,
  FastPathHandledNoWorkflowReason,
  FastPathOutcomeKind,
  ForwardClassification,
  type FastPathOutcome,
  type FastPathTransport,
} from "@/server/channels/core/outcomes";

export type NativeResponsePolicy =
  | "non-ok-starts-workflow"
  | "gateway-errors-start-workflow-non-gateway-handled";

export type FastPathClassifierPolicy = {
  channel: ChannelName;
  nativeResponsePolicy: NativeResponsePolicy;
  classifySuspiciousEmpty200?: boolean;
  stalePortOnSandboxNotListening?: number | null;
};

export type ClassifyFastPathHttpResultInput = {
  policy: FastPathClassifierPolicy;
  status: number;
  ok: boolean;
  bodyHead: string | null;
  bodyLength: number;
  durationMs: number;
  transport: FastPathTransport;
  sandboxUrl: string | null;
  sandboxId: string | null;
};

export type ClassifyFastPathExceptionInput = {
  policy: FastPathClassifierPolicy;
  error: unknown;
  durationMs: number;
  transport?: FastPathTransport | null;
  sandboxUrl?: string | null;
  sandboxId: string | null;
};

const SUSPICIOUS_EMPTY_200_MS = 150;

export function classifyFastPathHttpResult(
  input: ClassifyFastPathHttpResultInput,
): FastPathOutcome {
  const bodyHead = input.bodyHead ?? "";
  const suspiciousEmpty200 =
    input.policy.classifySuspiciousEmpty200 === true &&
    input.status === 200 &&
    input.durationMs < SUSPICIOUS_EMPTY_200_MS &&
    input.bodyLength === 0;

  if (input.ok && !suspiciousEmpty200) {
    return {
      kind: FastPathOutcomeKind.Accepted,
      classification: ForwardClassification.Accepted,
      status: input.status,
      transport: input.transport,
      sandboxUrl: input.sandboxUrl,
      sandboxId: input.sandboxId,
      bodyHead,
      durationMs: input.durationMs,
    };
  }

  if (suspiciousEmpty200) {
    return {
      kind: FastPathOutcomeKind.FallbackToWorkflow,
      reason: FastPathFallbackReason.SuspiciousEmpty200,
      classification: ForwardClassification.SwallowedByBaseServer,
      status: input.status,
      transport: input.transport,
      sandboxUrl: input.sandboxUrl,
      sandboxId: input.sandboxId,
      bodyHead,
      durationMs: input.durationMs,
      shouldReconcile: false,
    };
  }

  const sandboxNotListening = /sandbox is not listening/i.test(bodyHead);
  const gatewayError = input.status === 502 || input.status === 503 || input.status === 504;
  const handlerNotReady = input.status === 404;
  const classification = sandboxNotListening
    ? ForwardClassification.SandboxNotListening
    : gatewayError
      ? ForwardClassification.ProxyError
      : handlerNotReady
        ? ForwardClassification.HandlerNotReady
        : ForwardClassification.HandlerError;

  if (
    input.policy.nativeResponsePolicy === "gateway-errors-start-workflow-non-gateway-handled" &&
    !sandboxNotListening &&
    !gatewayError &&
    !handlerNotReady
  ) {
    return {
      kind: FastPathOutcomeKind.HandledNoWorkflow,
      reason: FastPathHandledNoWorkflowReason.NonGatewayHandlerResponse,
      classification,
      status: input.status,
      transport: input.transport,
      sandboxUrl: input.sandboxUrl,
      sandboxId: input.sandboxId,
      bodyHead,
      durationMs: input.durationMs,
    };
  }

  return {
    kind: FastPathOutcomeKind.FallbackToWorkflow,
    reason: sandboxNotListening
      ? FastPathFallbackReason.SandboxNotListening
      : gatewayError
        ? FastPathFallbackReason.ProxyError
        : handlerNotReady
          ? FastPathFallbackReason.HandlerNotReady
          : FastPathFallbackReason.HandlerErrorPolicyStartWorkflow,
    classification,
    status: input.status,
    transport: input.transport,
    sandboxUrl: input.sandboxUrl,
    sandboxId: input.sandboxId,
    bodyHead,
    durationMs: input.durationMs,
    shouldReconcile: gatewayError || sandboxNotListening,
    stalePort: sandboxNotListening
      ? input.policy.stalePortOnSandboxNotListening ?? null
      : null,
    stalePortReason: sandboxNotListening ? "fast-path-not-listening" : null,
  };
}

export function classifyFastPathException(
  input: ClassifyFastPathExceptionInput,
): Extract<FastPathOutcome, { kind: "fallback-to-workflow" }> {
  const error = input.error;
  const errorName = error instanceof Error ? error.name : null;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isAbort = errorName === "TimeoutError" || errorName === "AbortError";

  return {
    kind: FastPathOutcomeKind.FallbackToWorkflow,
    reason: isAbort
      ? FastPathFallbackReason.FastPathTimeout
      : FastPathFallbackReason.FetchException,
    classification: ForwardClassification.FetchException,
    status: null,
    transport: input.transport ?? "public",
    sandboxUrl: input.sandboxUrl ?? null,
    sandboxId: input.sandboxId,
    bodyHead: errorMessage,
    errorMessage,
    durationMs: input.durationMs,
    shouldReconcile: true,
    indeterminateDelivery: isAbort,
  };
}
