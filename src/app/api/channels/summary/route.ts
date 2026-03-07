import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { getChannelQueueDepth } from "@/server/channels/driver";
import { channelDeadLetterKey } from "@/server/channels/keys";
import { logError } from "@/server/log";
import { getStore, getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

type ChannelSummaryEntry = {
  connected: boolean;
  queueDepth: number;
  deadLetterCount: number;
  lastError: string | null;
};

type ChannelSummaryResponse = {
  slack: ChannelSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
};

async function getDeadLetterCount(channel: "slack" | "telegram" | "discord"): Promise<number> {
  try {
    return await getStore().getQueueLength(channelDeadLetterKey(channel));
  } catch {
    return 0;
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const [
      slackQueue,
      telegramQueue,
      discordQueue,
      slackDL,
      telegramDL,
      discordDL,
    ] = await Promise.all([
      getChannelQueueDepth("slack"),
      getChannelQueueDepth("telegram"),
      getChannelQueueDepth("discord"),
      getDeadLetterCount("slack"),
      getDeadLetterCount("telegram"),
      getDeadLetterCount("discord"),
    ]);

    const body: ChannelSummaryResponse = {
      slack: {
        connected: meta.channels.slack !== null,
        queueDepth: slackQueue,
        deadLetterCount: slackDL,
        lastError: meta.channels.slack?.lastError ?? null,
      },
      telegram: {
        connected: meta.channels.telegram !== null,
        queueDepth: telegramQueue,
        deadLetterCount: telegramDL,
        lastError: meta.channels.telegram?.lastError ?? null,
      },
      discord: {
        connected: meta.channels.discord !== null,
        queueDepth: discordQueue,
        deadLetterCount: discordDL,
        lastError: meta.channels.discord?.endpointError ?? null,
      },
    };

    const response = Response.json(body);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    logError("channels.summary_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}
