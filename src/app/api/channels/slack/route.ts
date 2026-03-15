import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { setSlackChannelConfig } from "@/server/channels/state";
import { getPublicChannelState } from "@/server/channels/state";

type SlackAuthTestResponse = {
  ok?: unknown;
  error?: unknown;
  team?: unknown;
  user?: unknown;
  bot_id?: unknown;
};

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const SLACK_AUTH_TEST_TIMEOUT_MS = 15_000;

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a non-empty string`);
  }

  return value.trim();
}

function parseSlackAuthPayload(payload: unknown): SlackAuthTestResponse {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(
      502,
      "SLACK_AUTH_TEST_INVALID_RESPONSE",
      "Slack auth.test returned an invalid response payload",
    );
  }

  return payload as SlackAuthTestResponse;
}

function toSlackErrorCode(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return "SLACK_AUTH_TEST_FAILED";
}

function parseSuccessField(value: unknown, field: "team" | "user" | "bot_id"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(
      502,
      "SLACK_AUTH_TEST_INVALID_RESPONSE",
      `Slack auth.test response missing ${field}`,
    );
  }

  return value;
}

async function runSlackAuthTest(botToken: string): Promise<{
  team: string;
  user: string;
  botId: string;
}> {
  const slackResponse = await fetch(SLACK_AUTH_TEST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
    },
    signal: AbortSignal.timeout(SLACK_AUTH_TEST_TIMEOUT_MS),
  });

  const payload = parseSlackAuthPayload(await slackResponse.json());
  if (!slackResponse.ok || payload.ok !== true) {
    const slackError = toSlackErrorCode(payload.error);
    throw new ApiError(400, slackError, slackError);
  }

  return {
    team: parseSuccessField(payload.team, "team"),
    user: parseSuccessField(payload.user, "user"),
    botId: parseSuccessField(payload.bot_id, "bot_id"),
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const state = await getPublicChannelState(request);
    return authJsonOk(state.slack, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const connectability = buildChannelConnectability("slack", request);
  if (!connectability.canConnect) {
    return buildChannelConnectBlockedResponse(auth, connectability);
  }

  try {
    const body = (await request.json()) as {
      signingSecret?: unknown;
      botToken?: unknown;
    };
    const signingSecret = parseNonEmptyString(body.signingSecret, "signingSecret");
    const botToken = parseNonEmptyString(body.botToken, "botToken");
    const authTest = await runSlackAuthTest(botToken);

    const configuredAt = Date.now();
    await setSlackChannelConfig({
      signingSecret,
      botToken,
      configuredAt,
      team: authTest.team,
      user: authTest.user,
      botId: authTest.botId,
    });

    const state = await getPublicChannelState(request);
    return authJsonOk(state.slack, auth);
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
    await setSlackChannelConfig(null);
    const state = await getPublicChannelState(request);
    return authJsonOk(state.slack, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
