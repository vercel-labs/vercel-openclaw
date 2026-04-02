import {
  hasWhatsAppBusinessCredentials,
  type ChannelName,
} from "@/shared/channels";
import type { BootMessageHandle } from "@/server/channels/core/types";
import type { QueuedChannelJob } from "@/server/channels/driver";
import { extractTelegramChatId } from "@/server/channels/telegram/adapter";
import { deleteMessage, editMessageText } from "@/server/channels/telegram/bot-api";
import { deleteMessage as deleteWhatsAppMessage } from "@/server/channels/whatsapp/whatsapp-api";
import { logInfo, logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { getStore } from "@/server/store/store";
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";

export type RetryingForwardResult = {
  ok: boolean;
  status: number;
  attempts: number;
  totalMs: number;
  retries: Array<{ attempt: number; reason: string; status?: number; error?: string }>;
};

export type DrainChannelWorkflowDependencies = {
  processChannelJob: typeof import("@/server/channels/driver").processChannelJob;
  isRetryable: typeof import("@/server/channels/driver").isRetryable;
  createSlackAdapter: typeof import("@/server/channels/slack/adapter").createSlackAdapter;
  createTelegramAdapter: typeof import("@/server/channels/telegram/adapter").createTelegramAdapter;
  createDiscordAdapter: typeof import("@/server/channels/discord/adapter").createDiscordAdapter;
  createWhatsAppAdapter: typeof import("@/server/channels/whatsapp/adapter").createWhatsAppAdapter;
  reconcileDiscordIntegration: typeof import("@/server/channels/discord/reconcile").reconcileDiscordIntegration;
  runWithBootMessages: typeof import("@/server/channels/core/boot-messages").runWithBootMessages;
  ensureSandboxReady: typeof import("@/server/sandbox/lifecycle").ensureSandboxReady;
  getSandboxDomain: typeof import("@/server/sandbox/lifecycle").getSandboxDomain;
  forwardToNativeHandler: typeof forwardToNativeHandler;
  forwardToNativeHandlerWithRetry: typeof forwardToNativeHandlerWithRetry;
  waitForTelegramNativeHandler: typeof waitForTelegramNativeHandler;
  buildExistingBootHandle: typeof buildExistingBootHandle;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
};

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

export type ProcessChannelStepOptions = {
  receivedAtMs?: number | null;
  dependencies?: DrainChannelWorkflowDependencies;
};

export async function drainChannelWorkflow(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  receivedAtMs?: number | null,
): Promise<void> {
  "use workflow";

  await processChannelStep(channel, payload, origin, requestId, bootMessageId ?? null, { receivedAtMs: receivedAtMs ?? null });
}

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  options?: ProcessChannelStepOptions,
): Promise<void> {
  "use step";

  const receivedAtMs = options?.receivedAtMs ?? null;
  const workflowStartedAt = Date.now();
  // Diagnostic trace — every phase appends here, written to store at the end.
  const diag: Record<string, unknown> = {
    channel,
    requestId,
    bootMessageId: bootMessageId ?? null,
    receivedAtMs,
    workflowStartedAt,
  };

  console.log(`[DIAG] processChannelStep START channel=${channel} requestId=${requestId} bootMessageId=${bootMessageId ?? "none"}`);

  const resolvedDependencies =
    options?.dependencies ?? (await loadDrainChannelWorkflowDependencies());
  const {
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardToNativeHandlerWithRetry,
    waitForTelegramNativeHandler: waitForTgHandler,
    buildExistingBootHandle,
  } = resolvedDependencies;

  if (channel === "discord") {
    try {
      await reconcileDiscordIntegration();
    } catch (err) {
      logWarn("channels.discord_integration_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const existingBootHandle = await buildExistingBootHandle(channel, payload, bootMessageId);
  diag.hasExistingBootHandle = Boolean(existingBootHandle);

  try {
    // --- Phase 1: Wake the sandbox ---
    console.log(`[DIAG] Phase 1: runWithBootMessages starting`);
    const bootResult = await runWithBootMessages({
      channel: channel as ChannelName,
      adapter: buildMinimalBootAdapter(),
      message: { text: "", chatId: "", from: "" } as never,
      origin,
      reason: `channel:${channel}`,
      timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      existingBootHandle,
    });

    diag.bootResultStatus = bootResult.meta.status;
    diag.bootResultSandboxId = bootResult.meta.sandboxId;
    diag.bootMessageSent = bootResult.bootMessageSent;
    diag.bootCompletedAt = Date.now();
    diag.bootDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] Phase 1 DONE: status=${bootResult.meta.status} sandboxId=${bootResult.meta.sandboxId} bootMessageSent=${bootResult.bootMessageSent} durationMs=${diag.bootDurationMs}`);

    const readyMeta = bootResult.meta.status === "running"
      ? bootResult.meta
      : await ensureSandboxReady({
          origin,
          reason: `channel:${channel}`,
          timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
        });

    const sandboxReadyAt = Date.now();
    diag.readyMetaStatus = readyMeta.status;
    diag.readyMetaSandboxId = readyMeta.sandboxId;
    diag.readyMetaPortUrlKeys = readyMeta.portUrls ? Object.keys(readyMeta.portUrls) : null;
    diag.readyMetaPortUrls = readyMeta.portUrls;
    diag.readyMetaHasWebhookSecret = Boolean(readyMeta.channels?.telegram?.webhookSecret);
    diag.usedBootMetaDirectly = bootResult.meta.status === "running";
    diag.sandboxReadyAt = sandboxReadyAt;
    console.log(`[DIAG] Sandbox ready: status=${readyMeta.status} sandboxId=${readyMeta.sandboxId} portUrls=${JSON.stringify(readyMeta.portUrls)} hasWebhookSecret=${diag.readyMetaHasWebhookSecret} usedBootMeta=${diag.usedBootMetaDirectly}`);

    logInfo("channels.workflow_sandbox_ready", {
      channel,
      requestId,
      bootResultStatus: bootResult.meta.status,
      sandboxId: readyMeta.sandboxId,
      portUrlKeys: readyMeta.portUrls ? Object.keys(readyMeta.portUrls) : null,
    });

    // --- Phase 2: Forward raw payload to native handler ---
    let forwardResult: { ok: boolean; status: number };
    let retryingResult: RetryingForwardResult | null = null;

    const forwardStartedAt = Date.now();
    console.log(`[DIAG] Phase 2: forwarding to native handler channel=${channel}`);

    // For Telegram, the native handler on port 8787 may not be ready yet
    // even though the gateway on port 3000 is running.  The Telegram
    // provider takes ~2-4s after gateway boot to register its webhook
    // route.  Poll with a lightweight probe first so the real payload
    // isn't swallowed by the base server's generic 200 handler.
    if (channel === "telegram") {
      const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");
      const probeResult = await waitForTgHandler(
        getSandboxDomain,
        OPENCLAW_TELEGRAM_WEBHOOK_PORT,
        readyMeta.channels?.telegram?.webhookSecret ?? null,
      );
      diag.telegramProbeAttempts = probeResult.attempts;
      diag.telegramProbeWaitMs = probeResult.waitMs;
      diag.telegramProbeLastStatus = probeResult.lastStatus;
      console.log(`[DIAG] Telegram native handler probe done: attempts=${probeResult.attempts} waitMs=${probeResult.waitMs} lastStatus=${probeResult.lastStatus}`);

      retryingResult = await forwardToNativeHandlerWithRetry(
        channel as ChannelName,
        payload,
        readyMeta,
        getSandboxDomain,
      );
      forwardResult = { ok: retryingResult.ok, status: retryingResult.status };
    } else {
      forwardResult = await forwardToNativeHandler(
        channel as ChannelName,
        payload,
        readyMeta,
        getSandboxDomain,
      );
    }

    const forwardCompletedAt = Date.now();
    diag.forwardOk = forwardResult.ok;
    diag.forwardStatus = forwardResult.status;
    diag.forwardDurationMs = forwardCompletedAt - forwardStartedAt;
    diag.forwardAttempts = retryingResult?.attempts ?? null;
    diag.forwardRetries = retryingResult?.retries ?? null;
    diag.forwardTotalMs = retryingResult?.totalMs ?? null;
    console.log(`[DIAG] Phase 2 DONE: ok=${forwardResult.ok} status=${forwardResult.status} attempts=${retryingResult?.attempts ?? 1} retries=${JSON.stringify(retryingResult?.retries ?? [])} durationMs=${diag.forwardDurationMs}`);

    logInfo("channels.workflow_native_forward_result", {
      channel,
      requestId,
      sandboxId: readyMeta.sandboxId,
      ok: forwardResult.ok,
      status: forwardResult.status,
      retryingForwardAttempts: retryingResult?.attempts ?? null,
      retryingForwardTotalMs: retryingResult?.totalMs ?? null,
      retryingForwardRetries: retryingResult?.retries?.length ?? null,
    });

    // Emit one end-to-end Telegram wake summary per request.
    if (channel === "telegram") {
      const restore = readyMeta.lastRestoreMetrics;
      logInfo("channels.telegram_wake_summary", {
        channel,
        requestId,
        sandboxId: readyMeta.sandboxId,
        bootResultStatus: bootResult.meta.status,
        webhookToWorkflowMs: typeof receivedAtMs === "number" ? Math.max(0, workflowStartedAt - receivedAtMs) : null,
        workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
        forwardMs: forwardCompletedAt - forwardStartedAt,
        endToEndMs: typeof receivedAtMs === "number" ? Math.max(0, forwardCompletedAt - receivedAtMs) : null,
        restoreTotalMs: restore?.totalMs ?? null,
        sandboxCreateMs: restore?.sandboxCreateMs ?? null,
        assetSyncMs: restore?.assetSyncMs ?? null,
        startupScriptMs: restore?.startupScriptMs ?? null,
        localReadyMs: restore?.localReadyMs ?? null,
        publicReadyMs: restore?.publicReadyMs ?? null,
        bootOverlapMs: restore?.bootOverlapMs ?? null,
        skippedStaticAssetSync: restore?.skippedStaticAssetSync ?? null,
        skippedDynamicConfigSync: restore?.skippedDynamicConfigSync ?? null,
        dynamicConfigReason: restore?.dynamicConfigReason ?? null,
        retryingForwardAttempts: retryingResult?.attempts ?? null,
        retryingForwardTotalMs: retryingResult?.totalMs ?? null,
        hotSpareHit: restore?.hotSpareHit ?? null,
        hotSparePromotionMs: restore?.hotSparePromotionMs ?? null,
        hotSpareRejectReason: restore?.hotSpareRejectReason ?? null,
      });
    }

    // Clean up the boot message after the native handler has processed.
    if (existingBootHandle) {
      await existingBootHandle.clear().catch(() => {});
    }

    diag.outcome = forwardResult.ok ? "success" : `failed:${forwardResult.status}`;
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep END outcome=${diag.outcome} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store for admin retrieval
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    if (!forwardResult.ok) {
      throw new Error(
        `native_forward_failed status=${forwardResult.status}`,
      );
    }
  } catch (error) {
    diag.outcome = "error";
    diag.error = error instanceof Error ? error.message : String(error);
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep ERROR: ${diag.error} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store even on failure
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    throw toWorkflowProcessingError(channel, error, resolvedDependencies);
  }
}

const NATIVE_HANDLER_TIMEOUT_ERROR = "native_handler_timeout";

const TELEGRAM_PROBE_MAX_ATTEMPTS = 20;
const TELEGRAM_PROBE_INTERVAL_MS = 500;
const TELEGRAM_PROBE_TIMEOUT_MS = 15_000;

export type TelegramProbeResult = {
  ready: boolean;
  attempts: number;
  waitMs: number;
  lastStatus: number | null;
};

/**
 * Poll the Telegram native handler on port 8787 until the webhook route
 * is registered.  The gateway starts a base HTTP server on 8787 immediately,
 * but the Telegram provider takes 2-4 seconds to register the
 * `/telegram-webhook` path.  During that window the base server returns
 * a generic 200 for POST requests, silently swallowing the payload.
 *
 * We send a GET to `/telegram-webhook` — the registered handler returns
 * 401 (missing secret header), while the base server returns 404.
 * When we see 401, the handler is ready and we can forward the real payload.
 */
async function waitForTelegramNativeHandler(
  getSandboxDomain: (port?: number) => Promise<string>,
  port: number,
  webhookSecret: string | null,
): Promise<TelegramProbeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + TELEGRAM_PROBE_TIMEOUT_MS;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    try {
      const sandboxUrl = await getSandboxDomain(port);
      // Send a POST with an invalid secret — if the Telegram handler is
      // registered it returns 401 (secret mismatch).  The base server
      // returns 404 (path not found) or 200 (generic catch-all).
      const resp = await fetch(`${sandboxUrl}/telegram-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(webhookSecret ? { "x-telegram-bot-api-secret-token": "probe-invalid-secret" } : {}),
        },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(3_000),
      });
      lastStatus = resp.status;

      // 401 = Telegram handler is registered and rejecting our invalid secret.
      // This means the real forward with the correct secret will be accepted.
      if (resp.status === 401) {
        console.log(`[DIAG] telegram_probe: ready at attempt=${attempt} status=401 waitMs=${Date.now() - startedAt}`);
        return { ready: true, attempts: attempt, waitMs: Date.now() - startedAt, lastStatus: 401 };
      }

      console.log(`[DIAG] telegram_probe: attempt=${attempt} status=${resp.status} (not ready)`);
    } catch (err) {
      console.log(`[DIAG] telegram_probe: attempt=${attempt} error=${err instanceof Error ? err.message : String(err)}`);
    }

    if (attempt < TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, TELEGRAM_PROBE_INTERVAL_MS));
    }
  }

  console.log(`[DIAG] telegram_probe: TIMEOUT after ${Date.now() - startedAt}ms lastStatus=${lastStatus}`);
  // Timed out — proceed anyway and let the retrying forward handle it.
  return { ready: false, attempts: TELEGRAM_PROBE_MAX_ATTEMPTS, waitMs: Date.now() - startedAt, lastStatus };
}

/**
 * Minimal adapter that satisfies runWithBootMessages type requirements.
 * Only the boot message handle matters — message extraction is unused
 * because we forward the raw payload to the native handler.
 */
function buildMinimalBootAdapter() {
  return {
    extractMessage: async () => ({ kind: "skip" as const, reason: "native-forward" }),
    sendReply: async () => {},
    // sendBootMessage MUST be present — without it, runWithBootMessages
    // exits immediately when there's no existingBootHandle, skipping
    // the entire sandbox-ready polling loop.
    sendBootMessage: async () => ({
      async update() {},
      async clear() {},
    }),
  };
}

/**
 * Forward the raw webhook payload to OpenClaw's native channel handler on
 * the sandbox, matching the fast-path forwarding used in webhook routes.
 */
async function forwardToNativeHandler(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
): Promise<{ ok: boolean; status: number }> {
  const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");

  let forwardUrl: string;
  const headers: Record<string, string> = { "content-type": "application/json" };

  switch (channel) {
    case "telegram": {
      const sandboxUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
      forwardUrl = `${sandboxUrl}/telegram-webhook`;
      if (meta.channels.telegram?.webhookSecret) {
        headers["x-telegram-bot-api-secret-token"] = meta.channels.telegram.webhookSecret;
      }
      break;
    }
    case "slack": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/slack/events`;
      break;
    }
    case "whatsapp": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/whatsapp-webhook`;
      break;
    }
    case "discord": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/discord-webhook`;
      break;
    }
    default:
      throw new Error(`unsupported_native_forward_channel:${channel}`);
  }

  console.log(`[DIAG] native_forward_attempt url=${forwardUrl} channel=${channel} sandboxId=${meta.sandboxId} hasSecret=${Boolean(headers["x-telegram-bot-api-secret-token"])}`);

  const response = await fetch(forwardUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  // Always capture response body for diagnostics.
  let responseBody: string | null = null;
  try {
    responseBody = await response.text();
  } catch { /* best effort */ }

  console.log(`[DIAG] native_forward_response status=${response.status} ok=${response.ok} bodyLength=${responseBody?.length ?? 0} body=${(responseBody ?? "").slice(0, 300)}`);

  if (!response.ok) {
    logWarn("channels.native_forward_error_response", {
      channel,
      status: response.status,
      forwardUrl,
      sandboxId: meta.sandboxId,
      responseBody: responseBody?.slice(0, 500) ?? null,
    });
  }

  return { ok: response.ok, status: response.status };
}

const RETRYING_FORWARD_MAX_ATTEMPTS = 6;
const RETRYING_FORWARD_RETRY_INTERVAL_MS = 1_000;
const RETRYING_FORWARD_TIMEOUT_MS = 30_000;

/**
 * Collapsed probe + forward: sends the real payload directly to the native
 * handler, retrying on proxy-level failures (502/503/504), fetch exceptions,
 * and handler-not-ready responses (401/404).
 *
 * 401/404 are retried because the native handler (e.g. Telegram on port 8787)
 * may be listening at the TCP level but not yet have its webhook routes and
 * secret validation fully initialized.  The gateway boots port 3000 first;
 * the Telegram webhook listener on 8787 registers its path a few seconds
 * later.  During that window the handler returns 401 (secret check against
 * an uninitialized route) or 404 (path not yet registered).
 *
 * Duplicate-safety: retries ONLY happen when the handler definitely did not
 * process the request. Any response that is 2xx, 3xx, or 4xx (other than
 * 401/404) is treated as "handler received the request" and is never retried.
 */
async function forwardToNativeHandlerWithRetry(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
): Promise<RetryingForwardResult> {
  const startedAt = Date.now();
  const deadline = startedAt + RETRYING_FORWARD_TIMEOUT_MS;
  const retries: Array<{ attempt: number; reason: string; status?: number; error?: string }> = [];

  for (let attempt = 1; attempt <= RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    try {
      const result = await forwardToNativeHandler(channel, payload, meta, getSandboxDomain);

      // Proxy-level failures (502/503/504): handler not listening yet. Safe to retry.
      // Handler-not-ready (401/404): native handler is listening at TCP level
      // but webhook route or secret validation is not yet initialized.
      if (result.status >= 502 || result.status === 401 || result.status === 404) {
        const reason = result.status >= 502 ? "proxy-error" : "handler-not-ready";
        const entry = { attempt, reason, status: result.status };
        retries.push(entry);
        logInfo("channels.native_forward_retry", {
          channel,
          attempt,
          status: result.status,
          reason,
        });
        if (attempt < RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS));
        }
        continue;
      }

      // Any other direct handler response: do NOT retry regardless of status.
      // This includes 200 (success), other 4xx (client error), 500 (server error).
      const totalMs = Date.now() - startedAt;
      logInfo("channels.retrying_forward_complete", {
        channel,
        ok: result.ok,
        status: result.status,
        attempts: attempt,
        totalMs,
        retryCount: retries.length,
      });
      return {
        ok: result.ok,
        status: result.status,
        attempts: attempt,
        totalMs,
        retries,
      };
    } catch (error) {
      // Connection refused, DNS failure, timeout — handler not reachable.
      const errorMsg = error instanceof Error ? error.message : String(error);
      const entry = { attempt, reason: "fetch-exception" as const, error: errorMsg };
      retries.push(entry);
      logInfo("channels.native_forward_retry", {
        channel,
        attempt,
        reason: "fetch-exception",
        error: errorMsg,
      });
      if (attempt < RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS));
      }
    }
  }

  // Exhausted retries — report as gateway timeout.
  const totalMs = Date.now() - startedAt;
  logWarn("channels.retrying_forward_exhausted", {
    channel,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    retryCount: retries.length,
  });
  return {
    ok: false,
    status: 504,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    retries,
  };
}

async function buildExistingBootHandle(
  channel: string,
  payload: unknown,
  bootMessageId?: number | string | null,
): Promise<BootMessageHandle | undefined> {
  if (typeof bootMessageId === "number" && channel === "telegram") {
    const meta = await getInitializedMeta();
    const tgConfig = meta.channels.telegram;
    const chatId = extractTelegramChatId(payload);
    if (tgConfig && chatId) {
      const token = tgConfig.botToken;
      const numChatId = Number(chatId);
      return {
        async update(text: string) {
          try {
            await editMessageText(token, numChatId, bootMessageId, text);
          } catch (error) {
            logWarn("channels.telegram_boot_message_update_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await deleteMessage(token, numChatId, bootMessageId);
          } catch (error) {
            logWarn("channels.telegram_boot_message_cleanup_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  if (typeof bootMessageId === "string" && channel === "slack") {
    const meta = await getInitializedMeta();
    const slackConfig = meta.channels.slack;
    const slackPayload = payload as { event?: { channel?: string } } | null;
    const slackChannel = slackPayload?.event?.channel;
    if (slackConfig && slackChannel) {
      const token = slackConfig.botToken;
      return {
        async update(text: string) {
          try {
            await fetch("https://slack.com/api/chat.update", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: slackChannel, ts: bootMessageId, text }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_update_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: slackChannel, ts: bootMessageId }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_cleanup_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  if (typeof bootMessageId === "string" && channel === "whatsapp") {
    const meta = await getInitializedMeta();
    const waConfig = meta.channels.whatsapp;
    if (hasWhatsAppBusinessCredentials(waConfig)) {
      return {
        async update() {
          // WhatsApp does not support editing sent messages.
        },
        async clear() {
          try {
            await deleteWhatsAppMessage(waConfig.accessToken, bootMessageId);
          } catch (error) {
            logWarn("channels.whatsapp_boot_message_cleanup_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  return undefined;
}

export function buildQueuedChannelJob(
  payload: unknown,
  origin: string,
  requestId: string | null,
): QueuedChannelJob<unknown> {
  return {
    payload,
    origin,
    receivedAt: Date.now(),
    requestId,
  };
}

// Workflows can run for up to 5 minutes — give the sandbox 2 minutes to
// restore instead of the old 25-second queue consumer timeout.
const WORKFLOW_SANDBOX_READY_TIMEOUT_MS = 120_000;
const WORKFLOW_RETRY_AFTER = "15s";

function parseNativeForwardFailedStatus(errorMsg: string): number | null {
  const match = /native_forward_failed status=(\d+)/.exec(errorMsg);
  if (!match) {
    return null;
  }

  const status = Number.parseInt(match[1], 10);
  return Number.isNaN(status) ? null : status;
}

export function toWorkflowProcessingError(
  channel: string,
  error: unknown,
  dependencies: DrainChannelErrorDependencies,
): Error {
  const message = `drain_channel_workflow_failed:${channel}:${formatChannelError(error)}`;
  const errorMsg = formatChannelError(error);

  // Sandbox readiness failures are transient infrastructure issues while the
  // sandbox is restoring. Retry the workflow step so the webhook can recover
  // once the sandbox becomes available again.
  const nativeForwardFailedStatus = parseNativeForwardFailedStatus(errorMsg);
  if (
    errorMsg.includes("sandbox_not_ready") ||
    errorMsg.includes("SANDBOX_READY_TIMEOUT") ||
    errorMsg.includes(NATIVE_HANDLER_TIMEOUT_ERROR) ||
    (nativeForwardFailedStatus !== null && nativeForwardFailedStatus >= 500)
  ) {
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  if (nativeForwardFailedStatus !== null) {
    return new dependencies.FatalError(message);
  }

  if (dependencies.isRetryable(error)) {
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  return new dependencies.FatalError(message);
}

async function loadDrainChannelWorkflowDependencies(): Promise<DrainChannelWorkflowDependencies> {
  const [
    { processChannelJob, isRetryable },
    { createSlackAdapter },
    { createTelegramAdapter },
    { createDiscordAdapter },
    { createWhatsAppAdapter },
    { reconcileDiscordIntegration },
    { runWithBootMessages },
    { ensureSandboxReady, getSandboxDomain },
    { RetryableError, FatalError },
  ] = await Promise.all([
    import("@/server/channels/driver"),
    import("@/server/channels/slack/adapter"),
    import("@/server/channels/telegram/adapter"),
    import("@/server/channels/discord/adapter"),
    import("@/server/channels/whatsapp/adapter"),
    import("@/server/channels/discord/reconcile"),
    import("@/server/channels/core/boot-messages"),
    import("@/server/sandbox/lifecycle"),
    import("workflow"),
  ]);

  return {
    processChannelJob,
    isRetryable,
    createSlackAdapter,
    createTelegramAdapter,
    createDiscordAdapter,
    createWhatsAppAdapter,
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardToNativeHandlerWithRetry,
    waitForTelegramNativeHandler,
    buildExistingBootHandle,
    RetryableError,
    FatalError,
  };
}

function formatChannelError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
