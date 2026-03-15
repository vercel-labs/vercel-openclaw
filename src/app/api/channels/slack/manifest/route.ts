import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { buildPublicUrl } from "@/server/public-url";

const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
] as const;

const SLACK_BOT_EVENTS = [
  "message.im",
  "message.channels",
  "message.groups",
] as const;

function buildManifest(webhookUrl: string): Record<string, unknown> {
  return {
    display_information: {
      name: "OpenClaw Gateway",
      description: "OpenClaw Slack integration",
      background_color: "#0f172a",
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "OpenClaw",
        always_online: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: webhookUrl,
        bot_events: [...SLACK_BOT_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const webhookUrl = buildPublicUrl("/api/channels/slack/webhook", request);
    const manifest = buildManifest(webhookUrl);
    const manifestJson = JSON.stringify(manifest);
    const createAppUrl =
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;

    return authJsonOk(
      {
        manifest,
        createAppUrl,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
