import {
  hasWhatsAppBusinessCredentials,
  type SlackChannelConfig,
  type TelegramChannelConfig,
  type DiscordChannelConfig,
  type WhatsAppChannelConfig,
} from "@/shared/channels";
import type { BootMessageHandle } from "@/server/channels/core/types";
import type { ChannelJobOptions, QueuedChannelJob } from "@/server/channels/driver";
import type { SlackExtractedMessage } from "@/server/channels/slack/adapter";
import type { TelegramExtractedMessage } from "@/server/channels/telegram/adapter";
import type { DiscordExtractedMessage } from "@/server/channels/discord/adapter";
import type { WhatsAppExtractedMessage } from "@/server/channels/whatsapp/adapter";
import { extractTelegramChatId } from "@/server/channels/telegram/adapter";
import { deleteMessage, editMessageText } from "@/server/channels/telegram/bot-api";
import { deleteMessage as deleteWhatsAppMessage } from "@/server/channels/whatsapp/whatsapp-api";
import { logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";

export type DrainChannelWorkflowDependencies = {
  processChannelJob: typeof import("@/server/channels/driver").processChannelJob;
  isRetryable: typeof import("@/server/channels/driver").isRetryable;
  createSlackAdapter: typeof import("@/server/channels/slack/adapter").createSlackAdapter;
  createTelegramAdapter: typeof import("@/server/channels/telegram/adapter").createTelegramAdapter;
  createDiscordAdapter: typeof import("@/server/channels/discord/adapter").createDiscordAdapter;
  createWhatsAppAdapter: typeof import("@/server/channels/whatsapp/adapter").createWhatsAppAdapter;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
};

type DrainChannelAdapterDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "createSlackAdapter" | "createTelegramAdapter" | "createDiscordAdapter" | "createWhatsAppAdapter"
>;

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

type SupportedChannelJobOptions =
  | ChannelJobOptions<SlackChannelConfig, unknown, SlackExtractedMessage>
  | ChannelJobOptions<TelegramChannelConfig, unknown, TelegramExtractedMessage>
  | ChannelJobOptions<DiscordChannelConfig, unknown, DiscordExtractedMessage>
  | ChannelJobOptions<WhatsAppChannelConfig, unknown, WhatsAppExtractedMessage>;

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

  if (channel === "discord") {
    try {
      const { reconcileDiscordIntegration } = await import("@/server/channels/discord/reconcile");
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
  let existingBootHandle: BootMessageHandle | undefined;
  if (typeof bootMessageId === "number" && channel === "telegram") {
    const meta = await getInitializedMeta();
    const tgConfig = meta.channels.telegram;
    const chatId = extractTelegramChatId(payload);
    if (tgConfig && chatId) {
      const token = tgConfig.botToken;
      const numChatId = Number(chatId);
      existingBootHandle = {
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
      existingBootHandle = {
        async update() {
          // WhatsApp does not support editing sent messages. Keep the
          // pre-sent boot message in place until final cleanup.
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

  try {
    const options = buildChannelJobOptions(channel, resolvedDependencies);
    const job = buildQueuedChannelJob(payload, origin, requestId);

    const { getStore } = await import("@/server/store/store");
    const { instanceKeyPrefix } = await import("@/server/store/keyspace");
    const debugKey = `${instanceKeyPrefix()}debug:workflow-step`;
    const store = getStore();
    await store.setValue(debugKey, JSON.stringify({
      phase: "starting",
      channel,
      requestId,
      bootMessageId: bootMessageId ?? null,
      ts: Date.now(),
    }), 300);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolvedDependencies.processChannelJob(options as any, job, undefined, existingBootHandle);

    await store.setValue(debugKey, JSON.stringify({
      phase: "completed",
      channel,
      requestId,
      ts: Date.now(),
    }), 300);
  } catch (error) {
    try {
      const { getStore } = await import("@/server/store/store");
      const { instanceKeyPrefix } = await import("@/server/store/keyspace");
      const store = getStore();
      await store.setValue(`${instanceKeyPrefix()}debug:workflow-step`, JSON.stringify({
        phase: "error",
        channel,
        requestId,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        ts: Date.now(),
      }), 300);
    } catch { /* ignore store errors in diagnostic */ }
    throw toWorkflowProcessingError(channel, error, resolvedDependencies);
  }
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

export function buildChannelJobOptions(
  channel: string,
  dependencies: DrainChannelAdapterDependencies,
): SupportedChannelJobOptions {
  switch (channel) {
    case "slack":
      return {
        channel: "slack",
        getConfig: (meta) => meta.channels.slack,
        createAdapter: (config: Parameters<typeof dependencies.createSlackAdapter>[0]) => dependencies.createSlackAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    case "telegram":
      return {
        channel: "telegram",
        getConfig: (meta) => meta.channels.telegram,
        createAdapter: (config: Parameters<typeof dependencies.createTelegramAdapter>[0]) => dependencies.createTelegramAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    case "discord":
      return {
        channel: "discord",
        getConfig: (meta) => meta.channels.discord,
        createAdapter: (config: Parameters<typeof dependencies.createDiscordAdapter>[0]) => dependencies.createDiscordAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    case "whatsapp":
      return {
        channel: "whatsapp",
        getConfig: (meta) =>
          hasWhatsAppBusinessCredentials(meta.channels.whatsapp)
            ? meta.channels.whatsapp
            : null,
        createAdapter: (config: Parameters<typeof dependencies.createWhatsAppAdapter>[0]) => dependencies.createWhatsAppAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    default:
      throw new Error(`unsupported_channel:${channel}`);
  }
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
  if (errorMsg.includes("sandbox_not_ready") || errorMsg.includes("SANDBOX_READY_TIMEOUT")) {
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
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
    { RetryableError, FatalError },
  ] = await Promise.all([
    import("@/server/channels/driver"),
    import("@/server/channels/slack/adapter"),
    import("@/server/channels/telegram/adapter"),
    import("@/server/channels/discord/adapter"),
    import("@/server/channels/whatsapp/adapter"),
    import("workflow"),
  ]);

  return {
    processChannelJob,
    isRetryable,
    createSlackAdapter,
    createTelegramAdapter,
    createDiscordAdapter,
    createWhatsAppAdapter,
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
