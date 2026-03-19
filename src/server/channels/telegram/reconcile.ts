import { setWebhook, getMyCommands } from "@/server/channels/telegram/bot-api";
import type { TelegramBotCommand } from "@/server/channels/telegram/bot-api";
import { getTelegramBotCommands, syncTelegramCommands } from "@/server/channels/telegram/commands";
import { setTelegramChannelConfig } from "@/server/channels/state";
import { logInfo, logWarn } from "@/server/log";
import { getInitializedMeta, getStore } from "@/server/store/store";

/**
 * Strip the Vercel protection bypass query parameter from a URL.
 * Telegram's setWebhook silently drops registrations when the URL
 * contains this parameter.
 */
function stripBypassParam(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("x-vercel-protection-bypass")) {
      parsed.searchParams.delete("x-vercel-protection-bypass");
      return parsed.toString();
    }
  } catch {
    // Not a valid URL — return as-is.
  }
  return url;
}

export const TELEGRAM_RECONCILE_KEY =
  "telegram:integration:last-reconciled-at";
export const TELEGRAM_WEBHOOK_RECONCILE_KEY = TELEGRAM_RECONCILE_KEY;
export const TELEGRAM_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export const TELEGRAM_WEBHOOK_RECONCILE_INTERVAL_MS = TELEGRAM_RECONCILE_INTERVAL_MS;

function commandsMatch(
  actual: TelegramBotCommand[],
  desired: TelegramBotCommand[],
): boolean {
  if (actual.length !== desired.length) return false;
  const normalize = (cmds: TelegramBotCommand[]) =>
    [...cmds].sort((a, b) => a.command.localeCompare(b.command));
  const a = normalize(actual);
  const d = normalize(desired);
  return a.every(
    (cmd, i) =>
      cmd.command === d[i].command && cmd.description === d[i].description,
  );
}

export type TelegramReconcileResult = {
  checkedAt: number;
  webhookReconciled: boolean;
  commandsSynced: boolean;
  commandCount: number;
};

export async function reconcileTelegramIntegration(options?: {
  force?: boolean;
  ensureCommands?: boolean;
}): Promise<TelegramReconcileResult | null> {
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return null;
  }

  if (!options?.force) {
    const lastReconciledAt = await getStore().getValue<number>(
      TELEGRAM_RECONCILE_KEY,
    );
    if (
      lastReconciledAt &&
      Date.now() - lastReconciledAt < TELEGRAM_RECONCILE_INTERVAL_MS
    ) {
      return null;
    }
  }

  // Strip the bypass query param if present — Telegram silently rejects
  // webhook URLs that contain it.
  const webhookUrl = stripBypassParam(config.webhookUrl);
  await setWebhook(config.botToken, webhookUrl, config.webhookSecret);

  let commandsSynced = false;
  let commandCount = 0;
  const ensureCommands = options?.ensureCommands !== false;

  if (ensureCommands) {
    try {
      const desired = getTelegramBotCommands();
      const actual = await getMyCommands(config.botToken);

      if (!commandsMatch(actual, desired)) {
        await syncTelegramCommands(config.botToken);
        commandsSynced = true;
      }
      commandCount = desired.length;

      await setTelegramChannelConfig({
        ...config,
        commandSyncStatus: "synced",
        commandsRegisteredAt: commandsSynced
          ? Date.now()
          : config.commandsRegisteredAt,
        commandSyncError: undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn("channels.telegram_command_reconcile_failed", {
        error: message,
      });
      await setTelegramChannelConfig({
        ...config,
        commandSyncStatus: "error",
        commandSyncError: message,
      });
    }
  }

  const checkedAt = Date.now();
  await getStore().setValue(TELEGRAM_RECONCILE_KEY, checkedAt);

  logInfo("channels.telegram_integration_reconciled", {
    webhookUrl: config.webhookUrl,
    commandsSynced,
    commandCount,
  });

  return {
    checkedAt,
    webhookReconciled: true,
    commandsSynced,
    commandCount,
  };
}

export async function reconcileTelegramWebhook(options?: {
  force?: boolean;
}): Promise<boolean> {
  const result = await reconcileTelegramIntegration({
    force: options?.force,
    ensureCommands: true,
  });
  return result !== null;
}
