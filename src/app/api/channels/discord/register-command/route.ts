import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { setDiscordChannelConfig } from "@/server/channels/state";
import { getInitializedMeta } from "@/server/store/store";

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function registerAskCommand(
  applicationId: string,
  botToken: string,
  fetchFn?: typeof fetch,
): Promise<{ commandId?: string }> {
  const fetcher = fetchFn ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("Fetch is unavailable in this runtime");
  }

  const normalizedToken = botToken.trim().replace(/^Bot\s+/i, "").trim();
  const response = await fetcher(
    `${DISCORD_API_BASE}/applications/${encodeURIComponent(applicationId)}/commands`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${normalizedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ask",
        description: "Ask the AI a question",
        type: 1,
        options: [
          {
            name: "text",
            description: "Your question",
            type: 3,
            required: true,
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Discord command registration failed with status ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    commandId: typeof payload.id === "string" ? payload.id : undefined,
  };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const config = meta.channels.discord;
    if (!config) {
      throw new ApiError(409, "DISCORD_NOT_CONFIGURED", "Discord is not configured.");
    }

    const command = await registerAskCommand(config.applicationId, config.botToken);
    await setDiscordChannelConfig({
      ...config,
      commandRegistered: true,
      commandId: command.commandId,
      commandRegisteredAt: Date.now(),
    });

    return authJsonOk(
      {
        ok: true,
        commandId: command.commandId ?? null,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
