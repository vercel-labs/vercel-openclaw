import { handleCallback } from "@vercel/queue";

import { isRetryable } from "@/server/channels/driver";
import {
  ensureSandboxReady,
  getSandboxDomain,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { logError, logInfo } from "@/server/log";
import {
  buildLaunchVerifyQueueAckMessage,
  buildLaunchVerifyQueueFailureMessage,
  buildLaunchVerifyQueueSuccessMessage,
  runLaunchVerifyCompletion,
  saveLaunchVerifyQueueResult,
  type LaunchVerifyQueueProbe,
  type LaunchVerifyQueueStage,
  type LaunchVerifyQueueTimings,
} from "@/server/launch-verify/queue-probe";
import { buildQueueRetryDecision } from "@/server/queues/retry";

const MAX_DELIVERY_COUNT = 8;

function buildTimings(input: {
  probeCreatedAt: number;
  deliveredAt: number;
  readyAt?: number;
  completedAt: number;
}): LaunchVerifyQueueTimings {
  return {
    queueDelayMs: Math.max(0, input.deliveredAt - input.probeCreatedAt),
    ...(input.readyAt != null
      ? {
          sandboxReadyMs: Math.max(0, input.readyAt - input.deliveredAt),
          completionMs: Math.max(0, input.completedAt - input.readyAt),
        }
      : {}),
    totalMs: Math.max(0, input.completedAt - input.probeCreatedAt),
  };
}

function retry(
  error: unknown,
  metadata: { messageId: string; deliveryCount: number },
) {
  return buildQueueRetryDecision({
    queueName: "launch-verify",
    error,
    metadata,
    isRetryable,
    logError,
    events: {
      error: "launch_verify.queue_consumer_error",
      exhausted: "launch_verify.queue_consumer_exhausted",
    },
    maxDeliveryCount: MAX_DELIVERY_COUNT,
  });
}

export const POST = handleCallback<LaunchVerifyQueueProbe>(
  async (probe, metadata) => {
    const deliveredAt = Date.now();
    let stage: LaunchVerifyQueueStage = "queue-delivery";
    let readyAt: number | undefined;

    try {
      logInfo("launch_verify.queue_consumer_received", {
        kind: probe.kind,
        probeId: probe.probeId,
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        queueDelayMs: Math.max(0, deliveredAt - probe.createdAt),
      });

      if (probe.kind === "ack") {
        const timings = buildTimings({
          probeCreatedAt: probe.createdAt,
          deliveredAt,
          completedAt: deliveredAt,
        });
        await saveLaunchVerifyQueueResult({
          probeId: probe.probeId,
          ok: true,
          completedAt: deliveredAt,
          messageId: metadata.messageId,
          stage,
          timings,
          message: buildLaunchVerifyQueueAckMessage(timings),
        });
        return;
      }

      stage = "sandbox-ready";
      const readyMeta = await ensureSandboxReady({
        origin: probe.origin,
        reason: `launch-verify:${probe.probeId}`,
        timeoutMs: probe.sandboxReadyTimeoutMs ?? 90_000,
      });
      readyAt = Date.now();

      stage = "chat-completion";
      const gatewayUrl = await getSandboxDomain();
      const replyText = await runLaunchVerifyCompletion({
        gatewayUrl,
        gatewayToken: readyMeta.gatewayToken,
        prompt: probe.prompt,
        expectedText: probe.expectedText,
        requestTimeoutMs: probe.requestTimeoutMs ?? 90_000,
      });

      await touchRunningSandbox();

      const completedAt = Date.now();
      const timings = buildTimings({
        probeCreatedAt: probe.createdAt,
        deliveredAt,
        readyAt,
        completedAt,
      });

      await saveLaunchVerifyQueueResult({
        probeId: probe.probeId,
        ok: true,
        completedAt,
        messageId: metadata.messageId,
        stage,
        timings,
        message: buildLaunchVerifyQueueSuccessMessage(timings),
        replyText,
      });

      logInfo("launch_verify.queue_consumer_success", {
        probeId: probe.probeId,
        messageId: metadata.messageId,
        timings,
      });
    } catch (error) {
      const retryable = isRetryable(error);
      const exhausted = metadata.deliveryCount >= MAX_DELIVERY_COUNT;

      if (!retryable || exhausted) {
        const completedAt = Date.now();
        const timings = buildTimings({
          probeCreatedAt: probe.createdAt,
          deliveredAt,
          readyAt,
          completedAt,
        });
        await saveLaunchVerifyQueueResult({
          probeId: probe.probeId,
          ok: false,
          completedAt,
          messageId: metadata.messageId,
          stage,
          timings,
          message: buildLaunchVerifyQueueFailureMessage({ stage, timings }),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      throw error;
    }
  },
  {
    visibilityTimeoutSeconds: 600,
    retry,
  },
);
