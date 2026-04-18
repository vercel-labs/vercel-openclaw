// Shared Slack app scopes, events, and manifest builder.
// Used by both the manifest route and the OAuth install flow.

import {
  buildBotDisplayName,
  buildDescription,
  buildDisplayName,
  slugifyForSlash,
  type ProjectIdentity,
} from "./project-identity";

// Scopes aligned with OpenClaw's native Slack manifest plus extras for
// the proxied HTTP-mode integration (assistant:write, im:write).
export const SLACK_BOT_SCOPES = [
  // Messaging — post, edit, delete, ephemeral
  "chat:write",
  // Slash commands
  "commands",
  // Reactions — ack emoji, status reactions
  "reactions:write",
  "reactions:read",
  // History — thread context, conversation replies (including multi-person DMs)
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  // Channel/user info — room detection, user display names, @mention events
  "channels:read",
  "groups:read",
  "im:write",
  "users:read",
  "app_mentions:read",
  // Files — image uploads, file attachments
  "files:read",
  "files:write",
  // Pins
  "pins:read",
  "pins:write",
  // Custom emoji — list workspace emojis for agent use
  "emoji:read",
  // Slack AI assistant threads — status, title, suggested prompts
  "assistant:write",
] as const;

// Events aligned with OpenClaw's native manifest — covers @mentions,
// all message types (channels, groups, DMs, multi-person DMs), reactions,
// membership changes, renames, and pins.
export const SLACK_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
  "reaction_removed",
  "member_joined_channel",
  "member_left_channel",
  "channel_rename",
  "pin_added",
  "pin_removed",
] as const;

export type SlackManifestUrls = {
  webhookUrl: string;
  /** Optional OAuth redirect — required for manifest-created apps that
   *  install via `oauth.v2.access`. Safe to include for the paste-to-Slack
   *  flow too; Slack just uses it as the default redirect. */
  redirectUrl?: string;
  /** Per-project identity: scope + name drive display name, bot name, and
   *  slash command so multiple projects can coexist in one Slack workspace. */
  identity: ProjectIdentity;
};

export function buildSlackManifest(
  urls: SlackManifestUrls,
): Record<string, unknown> {
  const { webhookUrl, redirectUrl, identity } = urls;
  const displayName = buildDisplayName(identity);
  const botDisplayName = buildBotDisplayName(identity);
  const description = buildDescription(identity);
  const command = slugifyForSlash(identity);

  const oauthConfig: Record<string, unknown> = {
    scopes: {
      bot: [...SLACK_BOT_SCOPES],
    },
  };
  if (redirectUrl) {
    oauthConfig.redirect_urls = [redirectUrl];
  }

  return {
    display_information: {
      name: displayName,
      description,
      background_color: "#0f172a",
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      assistant_view: {
        assistant_description:
          "VClaw AI assistant — ask questions, run tasks, and manage your workspace.",
        suggested_prompts: [
          {
            title: "What can you do?",
            message: "What tools and capabilities do you have?",
          },
          {
            title: "Generate an image",
            message: "Generate an image of a sunset over mountains",
          },
        ],
      },
      bot_user: {
        display_name: botDisplayName,
        always_online: true,
      },
      slash_commands: [
        {
          command,
          description: `Send a message to OpenClaw (${identity.combined})`,
          should_escape: false,
          url: webhookUrl,
        },
      ],
    },
    oauth_config: oauthConfig,
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
