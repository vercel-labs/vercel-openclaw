import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { getMe, deleteWebhook, setWebhook } from "@/server/channels/telegram/bot-api";
import {
  createTelegramWebhookSecret,
  getPublicChannelState,
  setTelegramChannelConfig,
  buildTelegramWebhookUrl,
} from "@/server/channels/state";
import { getInitializedMeta } from "@/server/store/store";

const PREVIOUS_SECRET_GRACE_MS = 30 * 60 * 1000;

function parseBotToken(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BOT_TOKEN", "botToken must be a non-empty string");
  }

  return value.trim();
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const state = await getPublicChannelState(request);
    return authJsonOk(state.telegram, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const connectability = buildChannelConnectability("telegram", request);
  if (!connectability.canConnect) {
    return buildChannelConnectBlockedResponse(auth, connectability);
  }

  try {
    const body = (await request.json()) as { botToken?: unknown };
    const botToken = parseBotToken(body.botToken);
    const bot = await getMe(botToken);
    const meta = await getInitializedMeta();
    const current = meta.channels.telegram;
    const webhookSecret = createTelegramWebhookSecret();
    const webhookUrl = buildTelegramWebhookUrl(request);

    await setWebhook(botToken, webhookUrl, webhookSecret);

    const now = Date.now();
    await setTelegramChannelConfig({
      botToken,
      webhookSecret,
      previousWebhookSecret: current?.webhookSecret,
      previousSecretExpiresAt: current?.webhookSecret ? now + PREVIOUS_SECRET_GRACE_MS : undefined,
      webhookUrl,
      botUsername: bot.username ?? "",
      configuredAt: now,
    });

    const state = await getPublicChannelState(request);
    return authJsonOk(state.telegram, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    if (meta.channels.telegram?.botToken) {
      await deleteWebhook(meta.channels.telegram.botToken).catch(() => {});
    }

    await setTelegramChannelConfig(null);
    const state = await getPublicChannelState(request);
    return authJsonOk(state.telegram, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
