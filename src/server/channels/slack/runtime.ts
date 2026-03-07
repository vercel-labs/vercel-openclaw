import { createSlackAdapter } from "@/server/channels/slack/adapter";
import { drainChannelQueue } from "@/server/channels/driver";

export async function drainSlackQueue(): Promise<void> {
  await drainChannelQueue({
    channel: "slack",
    getConfig: (meta) => meta.channels.slack,
    createAdapter: (config) => createSlackAdapter(config),
  });
}
