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
  waitForNativeHandler: typeof waitForNativeHandler;
  forwardToNativeHandler: typeof forwardToNativeHandler;
  buildExistingBootHandle: typeof buildExistingBootHandle;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
};

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

export async function drainChannelWorkflow(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
): Promise<void> {
  "use workflow";

  await processChannelStep(channel, payload, origin, requestId, bootMessageId ?? null);
}

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  dependencies?: DrainChannelWorkflowDependencies,
): Promise<void> {
  "use step";

  const resolvedDependencies =
    dependencies ?? (await loadDrainChannelWorkflowDependencies());
  const {
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    waitForNativeHandler,
    forwardToNativeHandler,
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

  // Build a BootMessageHandle for the message already sent from the webhook
  // route, so runWithBootMessages edits it in-place instead of creating a
  // second message.
  const existingBootHandle = await buildExistingBootHandle(channel, payload, bootMessageId);

  try {
    // --- Phase 1: Wake the sandbox with boot message updates ---
    // Use runWithBootMessages to poll sandbox status and progressively
    // update the boot message ("🦞 Restoring…" → "🦞 Starting gateway…" → etc.)
    // runWithBootMessages needs an adapter for the boot message handle.
    // We only need the existing boot handle (already built above).
    // Use a minimal adapter shim — the real message extraction is not needed
    // since we forward the raw payload to the native handler.
    const bootResult = await runWithBootMessages({
      channel: channel as ChannelName,
      adapter: buildMinimalBootAdapter(),
      message: { text: "", chatId: "", from: "" } as never,
      origin,
      reason: `channel:${channel}`,
      timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      existingBootHandle,
    });

    const readyMeta = await ensureSandboxReady({
      origin,
      reason: `channel:${channel}`,
      timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
    });

    logInfo("channels.workflow_sandbox_ready", {
      channel,
      requestId,
      bootResultStatus: bootResult.meta.status,
      sandboxId: readyMeta.sandboxId,
    });

    // --- Phase 2: Wait for native handler + forward raw payload ---
    // The gateway (port 3000) is ready, but the native channel handler
    // (e.g. port 8787 for Telegram) may need a few more seconds to start.
    // Poll until the native handler is reachable before forwarding.
    await waitForNativeHandler(channel as ChannelName, readyMeta, getSandboxDomain);

    const forwardResult = await forwardToNativeHandler(
      channel as ChannelName,
      payload,
      readyMeta,
      getSandboxDomain,
    );

    logInfo("channels.workflow_native_forward_result", {
      channel,
      requestId,
      sandboxId: readyMeta.sandboxId,
      ok: forwardResult.ok,
      status: forwardResult.status,
    });

    // Clean up the boot message after the native handler has processed.
    if (existingBootHandle) {
      await existingBootHandle.clear().catch(() => {});
    }

    if (!forwardResult.ok) {
      throw new Error(
        `native_forward_failed status=${forwardResult.status}`,
      );
    }
  } catch (error) {
    throw toWorkflowProcessingError(channel, error, resolvedDependencies);
  }
}

const NATIVE_HANDLER_POLL_INTERVAL_MS = 1_000;
const NATIVE_HANDLER_POLL_TIMEOUT_MS = 30_000;
const NATIVE_HANDLER_TIMEOUT_ERROR = "native_handler_timeout";

function buildNativeHandlerTimeoutError(
  channel: ChannelName,
  timeoutMs: number,
): Error {
  return new Error(
    `${NATIVE_HANDLER_TIMEOUT_ERROR} channel=${channel} timeoutMs=${timeoutMs}`,
  );
}

/**
 * Wait for the native channel handler to be fully ready.
 *
 * The Telegram provider on port 8787 starts AFTER the gateway on port 3000.
 * The Vercel proxy may return 502/503 before the handler is listening, and
 * the handler's HTTP server may accept connections before the message
 * processing pipeline is fully initialized.
 *
 * Strategy: poll until we get a non-proxy-error response (< 500), then wait
 * an additional stabilization period for the provider to finish initializing.
 */
async function waitForNativeHandler(
  channel: ChannelName,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
): Promise<void> {
  // Only Telegram uses a separate port; other channels use the main gateway port
  if (channel !== "telegram") return;

  const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");
  const deadline = Date.now() + NATIVE_HANDLER_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const sandboxUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
      const probe = await fetch(`${sandboxUrl}/telegram-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(meta.channels.telegram?.webhookSecret
            ? { "x-telegram-bot-api-secret-token": meta.channels.telegram.webhookSecret }
            : {}),
        },
        body: JSON.stringify({ update_id: 0 }),
        signal: AbortSignal.timeout(5_000),
      });
      // 502/503 from the Vercel proxy means the handler isn't listening yet.
      // Only accept responses that come from the actual handler (< 500).
      if (probe.status < 500) {
        logInfo("channels.native_handler_ready", { channel, status: probe.status });
        // The HTTP server accepts connections before the Telegram provider
        // finishes initializing.  Wait for the provider to fully start
        // (setWebhook, dedup init, etc.) before forwarding the real message.
        await new Promise((r) => setTimeout(r, 5_000));
        return;
      }
      logInfo("channels.native_handler_proxy_error", { channel, status: probe.status });
    } catch {
      // Connection refused or timeout — handler not yet listening
    }
    await new Promise((r) => setTimeout(r, NATIVE_HANDLER_POLL_INTERVAL_MS));
  }
  logWarn("channels.native_handler_poll_timeout", {
    channel,
    timeoutMs: NATIVE_HANDLER_POLL_TIMEOUT_MS,
  });
  throw buildNativeHandlerTimeoutError(channel, NATIVE_HANDLER_POLL_TIMEOUT_MS);
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

  const response = await fetch(forwardUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  return { ok: response.ok, status: response.status };
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
    waitForNativeHandler,
    forwardToNativeHandler,
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
