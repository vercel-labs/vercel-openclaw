import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getMe } from "@/server/channels/telegram/bot-api";

function parseBotToken(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BOT_TOKEN", "Missing botToken.");
  }

  return value.trim();
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = (await request.json()) as { botToken?: unknown };
    const botToken = parseBotToken(body.botToken);
    const bot = await getMe(botToken);

    return authJsonOk(
      {
        ok: true,
        bot: {
          id: bot.id,
          first_name: bot.first_name,
          username: bot.username,
        },
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
