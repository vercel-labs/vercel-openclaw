import { randomBytes } from "node:crypto";

import type {
  DiscordChannelConfig,
  SlackChannelConfig,
  TelegramChannelConfig,
} from "@/shared/channels";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { SingleMeta } from "@/shared/types";
import { getChannelQueueDepth } from "@/server/channels/driver";
import { buildChannelConnectability } from "@/server/channels/connectability";
import {
  isPublicUrl,
} from "@/server/channels/discord/application";
import { buildPublicUrl, buildPublicDisplayUrl } from "@/server/public-url";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";

export type PublicSlackState = {
  configured: boolean;
  queueDepth: number;
  webhookUrl: string;
  configuredAt: number | null;
  team: string | null;
  user: string | null;
  botId: string | null;
  hasSigningSecret: boolean;
  hasBotToken: boolean;
  lastError: string | null;
  connectability: ChannelConnectability;
};

export type PublicTelegramState = {
  configured: boolean;
  queueDepth: number;
  webhookUrl: string | null;
  botUsername: string | null;
  configuredAt: number | null;
  lastError: string | null;
  status: "connected" | "disconnected" | "error";
  commandSyncStatus: "synced" | "unsynced" | "error";
  commandsRegisteredAt: number | null;
  commandSyncError: string | null;
  connectability: ChannelConnectability;
};

export type PublicDiscordState = {
  configured: boolean;
  queueDepth: number;
  webhookUrl: string;
  applicationId: string | null;
  publicKey: string | null;
  configuredAt: number | null;
  appName: string | null;
  botUsername: string | null;
  endpointConfigured: boolean;
  endpointUrl: string | null;
  endpointError: string | null;
  commandRegistered: boolean;
  commandId: string | null;
  inviteUrl: string | null;
  isPublicUrl: boolean;
  connectability: ChannelConnectability;
};

export type PublicChannelState = {
  slack: PublicSlackState;
  telegram: PublicTelegramState;
  discord: PublicDiscordState;
};

export function buildSlackWebhookUrl(request?: Request): string {
  return buildPublicUrl("/api/channels/slack/webhook", request);
}

export function buildTelegramWebhookUrl(request?: Request): string {
  // Telegram validates webhooks via the x-telegram-bot-api-secret-token
  // header, not URL query params.  Including the bypass secret in the URL
  // causes Telegram's setWebhook to silently drop the registration.
  return buildPublicDisplayUrl("/api/channels/telegram/webhook", request);
}

export function buildDiscordPublicWebhookUrl(request?: Request): string {
  return buildPublicUrl("/api/channels/discord/webhook", request);
}

export function createTelegramWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

export async function getPublicChannelState(
  request: Request,
  meta?: SingleMeta,
): Promise<PublicChannelState> {
  const resolvedMeta = meta ?? (await getInitializedMeta());
  const [slackQueueDepth, telegramQueueDepth, discordQueueDepth] =
    await Promise.all([
      getChannelQueueDepth("slack"),
      getChannelQueueDepth("telegram"),
      getChannelQueueDepth("discord"),
    ]);

  // Display URLs (without bypass secret) — safe for admin-visible state
  const slackDisplayUrl = buildPublicDisplayUrl("/api/channels/slack/webhook", request);
  const telegramDisplayUrl = buildPublicDisplayUrl("/api/channels/telegram/webhook", request);
  const discordDisplayUrl = buildPublicDisplayUrl("/api/channels/discord/webhook", request);

  const discordPublic = isPublicUrl(discordDisplayUrl);

  const [slackConnectability, telegramConnectability, discordConnectability] =
    await Promise.all([
      buildChannelConnectability("slack", request, slackDisplayUrl),
      buildChannelConnectability("telegram", request, telegramDisplayUrl),
      buildChannelConnectability("discord", request, discordDisplayUrl),
    ]);

  return {
    slack: toPublicSlackState(
      resolvedMeta.channels.slack,
      slackDisplayUrl,
      slackQueueDepth,
      slackConnectability,
    ),
    telegram: toPublicTelegramState(
      resolvedMeta.channels.telegram,
      telegramDisplayUrl,
      telegramQueueDepth,
      telegramConnectability,
    ),
    discord: toPublicDiscordState(
      resolvedMeta.channels.discord,
      discordDisplayUrl,
      discordQueueDepth,
      discordPublic,
      discordConnectability,
    ),
  };
}

export async function setSlackChannelConfig(
  config: SlackChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.slack = config;
  });
}

export async function setTelegramChannelConfig(
  config: TelegramChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.telegram = config;
  });
}

export async function setDiscordChannelConfig(
  config: DiscordChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.discord = config;
  });
}

function toPublicSlackState(
  config: SlackChannelConfig | null,
  webhookUrl: string,
  queueDepth: number,
  connectability: ChannelConnectability,
): PublicSlackState {
  return {
    configured: config !== null,
    queueDepth,
    webhookUrl,
    configuredAt: config?.configuredAt ?? null,
    team: config?.team ?? null,
    user: config?.user ?? null,
    botId: config?.botId ?? null,
    hasSigningSecret: Boolean(config?.signingSecret),
    hasBotToken: Boolean(config?.botToken),
    lastError: config?.lastError ?? null,
    connectability,
  };
}

function toPublicTelegramState(
  config: TelegramChannelConfig | null,
  webhookUrl: string,
  queueDepth: number,
  connectability: ChannelConnectability,
): PublicTelegramState {
  const status =
    config?.lastError ? "error" : config ? "connected" : "disconnected";

  return {
    configured: config !== null,
    queueDepth,
    webhookUrl: config ? webhookUrl : null,
    botUsername: config?.botUsername ?? null,
    configuredAt: config?.configuredAt ?? null,
    lastError: config?.lastError ?? null,
    status,
    commandSyncStatus: config?.commandSyncStatus ?? "unsynced",
    commandsRegisteredAt: config?.commandsRegisteredAt ?? null,
    commandSyncError: config?.commandSyncError ?? null,
    connectability,
  };
}

function toPublicDiscordState(
  config: DiscordChannelConfig | null,
  webhookUrl: string,
  queueDepth: number,
  publicUrl: boolean,
  connectability: ChannelConnectability,
): PublicDiscordState {
  const inviteUrl =
    config?.applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.applicationId)}&scope=bot+applications.commands&permissions=3072`
      : null;

  return {
    configured: config !== null,
    queueDepth,
    webhookUrl,
    applicationId: config?.applicationId ?? null,
    publicKey: config?.publicKey ?? null,
    configuredAt: config?.configuredAt ?? null,
    appName: config?.appName ?? null,
    botUsername: config?.botUsername ?? null,
    endpointConfigured: config?.endpointConfigured === true,
    endpointUrl: config?.endpointUrl ?? null,
    endpointError: config?.endpointError ?? null,
    commandRegistered: config?.commandRegistered === true,
    commandId: config?.commandId ?? null,
    inviteUrl,
    isPublicUrl: publicUrl,
    connectability,
  };
}
