import { randomUUID } from "node:crypto";

import { pollUntil } from "@/server/async/poll";
import { extractReply, toPlainText } from "@/server/channels/core/reply";
import { callGatewayWithAuthRecovery } from "@/server/gateway/auth-recovery";
import { logInfo, logWarn } from "@/server/log";
import { OPENCLAW_OPERATOR_SCOPES } from "@/server/openclaw/config";
import { ensureFreshGatewayToken } from "@/server/sandbox/lifecycle";
import { launchVerifyQueueResultKey } from "@/server/store/keyspace";
import { getInitializedMeta, getStore } from "@/server/store/store";

const RESULT_TTL_SECONDS = 15 * 60;
const RESULT_POLL_MS = 1_000;

export type LaunchVerifyQueueStage =
  | "queue-delivery"
  | "sandbox-ready"
  | "chat-completion";

export type LaunchVerifyQueueTimings = {
  queueDelayMs: number;
  sandboxReadyMs?: number;
  completionMs?: number;
  totalMs: number;
};

type BaseProbe = {
  probeId: string;
  origin: string;
  createdAt: number;
};

export type LaunchVerifyQueueProbe =
  | (BaseProbe & { kind: "ack" })
  | (BaseProbe & {
      kind: "chat";
      prompt: string;
      expectedText: string;
      sandboxReadyTimeoutMs?: number;
      requestTimeoutMs?: number;
    });

export type LaunchVerifyQueueResult = {
  probeId: string;
  ok: boolean;
  completedAt: number;
  message: string;
  messageId?: string | null;
  replyText?: string;
  error?: string;
  stage?: LaunchVerifyQueueStage;
  timings?: LaunchVerifyQueueTimings;
};

function resultKey(probeId: string): string {
  return launchVerifyQueueResultKey(probeId);
}

type ProbeInput =
  | { kind: "ack"; origin: string }
  | {
      kind: "chat";
      origin: string;
      prompt: string;
      expectedText: string;
      sandboxReadyTimeoutMs?: number;
      requestTimeoutMs?: number;
    };

function formatDurationMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function formatTimingSummary(timings: LaunchVerifyQueueTimings): string {
  const parts = [`queue delay ${formatDurationMs(timings.queueDelayMs)}`];
  if (timings.sandboxReadyMs != null) {
    parts.push(`sandbox ready ${formatDurationMs(timings.sandboxReadyMs)}`);
  }
  if (timings.completionMs != null) {
    parts.push(`completion ${formatDurationMs(timings.completionMs)}`);
  }
  parts.push(`total ${formatDurationMs(timings.totalMs)}`);
  return parts.join(", ");
}

function formatQueueStage(stage: LaunchVerifyQueueStage): string {
  switch (stage) {
    case "queue-delivery":
      return "queue delivery";
    case "sandbox-ready":
      return "sandbox wake/restore";
    case "chat-completion":
      return "chat completion";
  }
}

export function buildLaunchVerifyQueueSuccessMessage(
  timings: LaunchVerifyQueueTimings,
): string {
  return `Queue callback completed sandbox wake and chat round-trip (${formatTimingSummary(timings)}).`;
}

export function buildLaunchVerifyQueueAckMessage(
  timings: LaunchVerifyQueueTimings,
): string {
  return `Queue callback executed successfully (${formatTimingSummary(timings)}).`;
}

export function buildLaunchVerifyQueueFailureMessage(input: {
  stage: LaunchVerifyQueueStage;
  timings: LaunchVerifyQueueTimings;
}): string {
  return `Queue callback failed during ${formatQueueStage(input.stage)} (${formatTimingSummary(input.timings)}).`;
}

export async function publishLaunchVerifyQueueProbe(
  probe: ProbeInput,
): Promise<{ probeId: string; messageId: string | null }> {
  const { send } = await import("@vercel/queue");

  const probeId = randomUUID();
  const payload: LaunchVerifyQueueProbe = {
    ...probe,
    probeId,
    createdAt: Date.now(),
  } as LaunchVerifyQueueProbe;

  logInfo("launch_verify.queue_probe_publish", {
    kind: payload.kind,
    probeId,
  });

  const result = await send("launch-verify", payload, {
    idempotencyKey: `launch-verify:${probeId}`,
  });

  logInfo("launch_verify.queue_probe_published", {
    probeId,
    messageId: result.messageId ?? null,
  });

  return { probeId, messageId: result.messageId ?? null };
}

export async function saveLaunchVerifyQueueResult(
  result: LaunchVerifyQueueResult,
): Promise<void> {
  logInfo("launch_verify.queue_result_save", {
    probeId: result.probeId,
    ok: result.ok,
  });
  await getStore().setValue(resultKey(result.probeId), result, RESULT_TTL_SECONDS);
}

export async function waitForLaunchVerifyQueueResult(
  probeId: string,
  timeoutMs = 60_000,
): Promise<LaunchVerifyQueueResult> {
  logInfo("launch_verify.queue_result_wait_start", {
    probeId,
    timeoutMs,
  });

  return pollUntil<LaunchVerifyQueueResult>({
    label: "launch-verify.queue-result",
    timeoutMs,
    initialDelayMs: RESULT_POLL_MS,
    timeoutError: () =>
      new Error(
        `Timed out waiting for launch-verify queue probe ${probeId}; queue delivery or callback execution may be stalled.`,
      ),
    step: async () => {
      const result =
        await getStore().getValue<LaunchVerifyQueueResult>(resultKey(probeId));

      if (!result) {
        return { done: false, delayMs: RESULT_POLL_MS };
      }

      await getStore().deleteValue(resultKey(probeId)).catch(() => {});
      logInfo("launch_verify.queue_result_received", {
        probeId,
        ok: result.ok,
        stage: result.stage ?? null,
        timings: result.timings ?? null,
      });

      return { done: true, result };
    },
  });
}

function normalizeReply(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const COMPLETION_MAX_RETRIES = 2;
const COMPLETION_RETRY_DELAY_MS = 3_000;

export async function runLaunchVerifyCompletion(options: {
  gatewayUrl: string;
  gatewayToken: string;
  prompt: string;
  expectedText: string;
  requestTimeoutMs?: number;
}): Promise<string> {
  logInfo("launch_verify.completion_start", {
    gatewayUrl: options.gatewayUrl,
    prompt: options.prompt,
  });

  const timeoutMs = options.requestTimeoutMs ?? 90_000;

  // Pre-refresh the gateway token before the first attempt.
  await ensureFreshGatewayToken();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= COMPLETION_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      logInfo("launch_verify.completion_retry", { attempt, maxRetries: COMPLETION_MAX_RETRIES });
      await new Promise((r) => setTimeout(r, COMPLETION_RETRY_DELAY_MS));
    }

    const meta = await getInitializedMeta();
    const sandboxId = meta.sandboxId ?? "unknown";

    const recoveryResult = await callGatewayWithAuthRecovery<string>({
      label: "launch-verify",
      sandboxId,
      makeRequest: async () => {
        // Re-read meta so retries after token refresh pick up the new token.
        const currentMeta = await getInitializedMeta();
        const gatewayToken = currentMeta.gatewayToken ?? options.gatewayToken;
        return fetch(
          new URL("/v1/chat/completions", options.gatewayUrl),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${gatewayToken}`,
              "X-AI-Gateway-Token": gatewayToken,
              "x-openclaw-scopes": OPENCLAW_OPERATOR_SCOPES,
            },
            body: JSON.stringify({
              model: "openclaw",
              messages: [{ role: "user", content: options.prompt }],
              stream: false,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      },
      parseResponse: async (response) => {
        const payload = (await response.json()) as unknown;
        const reply = extractReply(payload);
        if (!reply) {
          throw new Error("Gateway response did not contain a reply.");
        }
        return toPlainText(reply);
      },
      onRefreshNeeded: async () => {
        try {
          await ensureFreshGatewayToken({ force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    if (recoveryResult.ok) {
      const replyText = recoveryResult.result;

      logInfo("launch_verify.completion_done", {
        replyText,
        expectedText: options.expectedText,
        refreshed: recoveryResult.refreshed,
      });

      if (normalizeReply(replyText) !== normalizeReply(options.expectedText)) {
        throw new Error(
          `Expected ${JSON.stringify(options.expectedText)} but got ${JSON.stringify(replyText)}`,
        );
      }

      return replyText;
    }

    // Auth recovery failed
    lastError = new Error(recoveryResult.error);

    if (recoveryResult.retryable && attempt < COMPLETION_MAX_RETRIES) {
      logWarn("launch_verify.completion_retryable_failure", {
        attempt,
        error: recoveryResult.error,
        retryable: recoveryResult.retryable,
      });
      continue;
    }

    // Non-retryable or exhausted retries
    throw lastError;
  }

  throw lastError ?? new Error("Gateway completions failed after retries.");
}
