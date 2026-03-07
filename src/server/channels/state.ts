import { randomBytes } from "node:crypto";

import type {
  DiscordChannelConfig,
  SlackChannelConfig,
  TelegramChannelConfig,
} from "@/shared/channels";
import type { SingleMeta } from "@/shared/types";
import { getBaseOrigin } from "@/server/env";
import { getChannelQueueDepth } from "@/server/channels/driver";
import {
  buildWebhookUrl as buildDiscordWebhookUrl,
  isPublicUrl,
  resolveBaseUrl,
} from "@/server/channels/discord/application";
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
};

export type PublicTelegramState = {
  configured: boolean;
  queueDepth: number;
  webhookUrl: string | null;
  botUsername: string | null;
  configuredAt: number | null;
  lastError: string | null;
  status: "connected" | "disconnected" | "error";
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
};

export type PublicChannelState = {
  slack: PublicSlackState;
  telegram: PublicTelegramState;
  discord: PublicDiscordState;
};

export function buildSlackWebhookUrl(request: Request): string {
  return `${getBaseOrigin(request)}/api/channels/slack/webhook`;
}

export function buildTelegramWebhookUrl(request: Request): string {
  return `${getBaseOrigin(request)}/api/channels/telegram/webhook`;
}

export function buildDiscordPublicWebhookUrl(request: Request): string {
  return buildDiscordWebhookUrl(resolveBaseUrl(request));
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

  const slackWebhookUrl = buildSlackWebhookUrl(request);
  const telegramWebhookUrl = buildTelegramWebhookUrl(request);
  const discordWebhookUrl = buildDiscordPublicWebhookUrl(request);
  const discordPublic = isPublicUrl(discordWebhookUrl);

  return {
    slack: toPublicSlackState(resolvedMeta.channels.slack, slackWebhookUrl, slackQueueDepth),
    telegram: toPublicTelegramState(
      resolvedMeta.channels.telegram,
      telegramWebhookUrl,
      telegramQueueDepth,
    ),
    discord: toPublicDiscordState(
      resolvedMeta.channels.discord,
      discordWebhookUrl,
      discordQueueDepth,
      discordPublic,
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
  };
}

function toPublicTelegramState(
  config: TelegramChannelConfig | null,
  webhookUrl: string,
  queueDepth: number,
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
  };
}

function toPublicDiscordState(
  config: DiscordChannelConfig | null,
  webhookUrl: string,
  queueDepth: number,
  publicUrl: boolean,
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
  };
}
