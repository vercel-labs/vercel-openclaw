import type { ChannelName } from "@/shared/channels";
import type { SingleMeta } from "@/shared/types";
import type {
  BootMessageHandle,
  ExtractedChannelMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { logInfo, logWarn } from "@/server/log";
import {
  ensureSandboxRunning,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

const BOOT_MESSAGE_INITIAL = "🦞 Waking up\u2026 one moment.";

const STATUS_MESSAGES: Partial<Record<SingleMeta["status"], string>> = {
  restoring: "🦞 Restoring\u2026",
  creating: "🦞 Creating sandbox\u2026",
  setup: "🦞 Setting up\u2026",
  booting: "🦞 Starting gateway\u2026",
  running: "🦞 Processing\u2026",
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const BOOT_MESSAGE_CLEAR_DELAY_MS = 500;

export type RunWithBootMessagesOptions<
  TMessage extends ExtractedChannelMessage,
> = {
  channel: ChannelName;
  adapter: PlatformAdapter<unknown, TMessage>;
  message: TMessage;
  origin: string;
  reason: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Reuse a boot message already sent (e.g. from the webhook route). */
  existingBootHandle?: BootMessageHandle;
};

export type BootMessagesResult = {
  meta: SingleMeta;
  bootMessageSent: boolean;
};

/**
 * Wake the sandbox with phased boot status messages.
 *
 * If the sandbox is already running, returns immediately without sending
 * a boot message. Otherwise sends "🦞 Waking up…" and progressively updates
 * the message as the sandbox transitions through restore phases.
 */
export async function runWithBootMessages<
  TMessage extends ExtractedChannelMessage,
>(
  options: RunWithBootMessagesOptions<TMessage>,
): Promise<BootMessagesResult> {
  const {
    channel,
    adapter,
    message,
    origin,
    reason,
    timeoutMs,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    existingBootHandle,
  } = options;

  const initialMeta = await getInitializedMeta();

  if (initialMeta.status === "running" && initialMeta.sandboxId) {
    // Sandbox already running — clean up any pre-sent boot message immediately
    if (existingBootHandle) {
      existingBootHandle.clear().catch((error) => {
        logWarn("channels.boot_message_cleanup_failed", {
          channel,
          phase: "already-running",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { meta: initialMeta, bootMessageSent: false };
  }

  if (!existingBootHandle && !adapter.sendBootMessage) {
    return { meta: initialMeta, bootMessageSent: false };
  }

  let handle: BootMessageHandle;
  if (existingBootHandle) {
    handle = existingBootHandle;
  } else {
    try {
      handle = await adapter.sendBootMessage!(message, BOOT_MESSAGE_INITIAL);
    } catch (error) {
      logWarn("channels.boot_message_send_failed", {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return { meta: initialMeta, bootMessageSent: false };
    }
  }

  logInfo("channels.boot_message_sent", { channel });

  let lastStatus: string | null = null;
  const deadline = Date.now() + timeoutMs;

  try {
    for (;;) {
      const result = await ensureSandboxRunning({ origin, reason });
      const meta = result.meta;

      if (meta.status !== lastStatus) {
        lastStatus = meta.status;
        const statusMessage = STATUS_MESSAGES[meta.status];
        if (statusMessage) {
          await handle.update(statusMessage);
        }
      }

      if (meta.status === "running" && meta.sandboxId) {
        return { meta, bootMessageSent: true };
      }

      if (meta.status === "error") {
        throw new Error(
          `Sandbox entered error state: ${meta.lastError ?? "unknown"}`,
        );
      }

      // Also try gateway probe for statuses that might already be running
      if (
        meta.sandboxId &&
        ["setup", "booting"].includes(meta.status)
      ) {
        const probe = await probeGatewayReady();
        if (probe.ready) {
          await handle.update(
            STATUS_MESSAGES.running ?? "Processing your message\u2026",
          );
          return {
            meta: await getInitializedMeta(),
            bootMessageSent: true,
          };
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Sandbox did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds (last status: ${meta.status}).`,
        );
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    // Always clean up the boot message
    try {
      await sleep(BOOT_MESSAGE_CLEAR_DELAY_MS);
      await handle.clear();
    } catch (error) {
      logWarn("channels.boot_message_cleanup_failed", {
        channel,
        phase: "finalize",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
