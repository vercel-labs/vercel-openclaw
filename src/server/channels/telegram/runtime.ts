import { createTelegramAdapter } from "@/server/channels/telegram/adapter";
import { drainChannelQueue } from "@/server/channels/driver";

export async function drainTelegramQueue(): Promise<void> {
  await drainChannelQueue({
    channel: "telegram",
    getConfig: (meta) => meta.channels.telegram,
    createAdapter: (config) => createTelegramAdapter(config),
  });
}
