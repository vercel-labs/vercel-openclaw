import { createDiscordAdapter } from "@/server/channels/discord/adapter";
import { drainChannelQueue } from "@/server/channels/driver";

export async function drainDiscordQueue(): Promise<void> {
  await drainChannelQueue({
    channel: "discord",
    getConfig: (meta) => meta.channels.discord,
    createAdapter: (config) => createDiscordAdapter(config),
  });
}
