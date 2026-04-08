import { randomBytes } from "node:crypto";

import type {
  DiscordChannelConfig,
  SlackChannelConfig,
  TelegramChannelConfig,
  WhatsAppChannelConfig,
} from "@/shared/channels";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { SingleMeta } from "@/shared/types";
import {
  buildChannelConnectabilityMap,
} from "@/server/channels/connectability";
import {
  isPublicUrl,
} from "@/server/channels/discord/application";
import {
  buildChannelDisplayWebhookUrl,
  buildChannelWebhookUrl,
} from "@/server/channels/webhook-urls";
import { getSlackInstallConfig } from "@/server/channels/slack/install-config";
import { buildDeploymentContract } from "@/server/deployment-contract";
import { logDebug } from "@/server/log";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";

export type {
  PublicSlackState,
  PublicTelegramState,
  PublicDiscordState,
  PublicWhatsAppState,
  PublicChannelState,
} from "@/shared/channel-admin-state";

import type {
  PublicSlackState,
  PublicTelegramState,
  PublicDiscordState,
  PublicWhatsAppState,
  PublicChannelState,
} from "@/shared/channel-admin-state";

export function buildSlackWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("slack", request)!;
}

export function buildTelegramWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("telegram", request)!;
}

export function buildDiscordPublicWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("discord", request)!;
}

export function createTelegramWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

export async function getPublicChannelState(
  request: Request,
  meta?: SingleMeta,
): Promise<PublicChannelState> {
  const resolvedMeta = meta ?? (await getInitializedMeta());

  // Display URLs (without bypass secret) — safe for admin-visible state.
  // Resolved once and threaded through to both public state and connectability.
  const slackDisplayUrl = buildChannelDisplayWebhookUrl("slack", request)!;
  const telegramDisplayUrl = buildChannelDisplayWebhookUrl("telegram", request)!;
  const discordDisplayUrl = buildChannelDisplayWebhookUrl("discord", request)!;

  // Single contract + single connectability map — no redundant builds.
  const contract = await buildDeploymentContract({ request });
  const connectability = await buildChannelConnectabilityMap(request, {
    shared: { contract },
    webhookUrlOverrides: {
      slack: slackDisplayUrl,
      telegram: telegramDisplayUrl,
      discord: discordDisplayUrl,
    },
  });

  logDebug("public_channel_state.built", {
    contractSource: "fresh",
    channels: (["slack", "telegram", "discord", "whatsapp"] as const).map(
      (ch) => `${ch}:${connectability[ch].status}`,
    ),
  });

  return {
    slack: toPublicSlackState(
      resolvedMeta.channels.slack,
      slackDisplayUrl,
      connectability.slack,
    ),
    telegram: toPublicTelegramState(
      resolvedMeta.channels.telegram,
      telegramDisplayUrl,
      connectability.telegram,
    ),
    discord: toPublicDiscordState(
      resolvedMeta.channels.discord,
      discordDisplayUrl,
      isPublicUrl(discordDisplayUrl),
      connectability.discord,
    ),
    whatsapp: toPublicWhatsAppState(
      resolvedMeta.channels.whatsapp,
      connectability.whatsapp,
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

export async function setWhatsAppChannelConfig(
  config: WhatsAppChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.whatsapp = config;
  });
}

function toPublicSlackState(
  config: SlackChannelConfig | null,
  webhookUrl: string,
  connectability: ChannelConnectability,
): PublicSlackState {
  const installConfig = getSlackInstallConfig();
  return {
    configured: config !== null,
    webhookUrl,
    configuredAt: config?.configuredAt ?? null,
    team: config?.team ?? null,
    user: config?.user ?? null,
    botId: config?.botId ?? null,
    hasSigningSecret: Boolean(config?.signingSecret),
    hasBotToken: Boolean(config?.botToken),
    lastError: config?.lastError ?? null,
    connectability,
    installMethod: installConfig.enabled ? "oauth" : "manual",
    installUrl: installConfig.enabled ? "/api/channels/slack/install" : null,
    appCredentialsConfigured: installConfig.enabled,
  };
}

function toPublicTelegramState(
  config: TelegramChannelConfig | null,
  webhookUrl: string,
  connectability: ChannelConnectability,
): PublicTelegramState {
  const status =
    config?.lastError ? "error" : config ? "connected" : "disconnected";

  return {
    configured: config !== null,
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
  publicUrl: boolean,
  connectability: ChannelConnectability,
): PublicDiscordState {
  const inviteUrl =
    config?.applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.applicationId)}&scope=bot+applications.commands&permissions=3072`
      : null;

  return {
    configured: config !== null,
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

function toPublicWhatsAppState(
  config: WhatsAppChannelConfig | null,
  connectability: ChannelConnectability,
): PublicWhatsAppState {
  return {
    configured: config?.enabled === true,
    mode: connectability.mode,
    webhookUrl: config ? connectability.webhookUrl : null,
    status: config?.lastKnownLinkState ?? "unconfigured",
    configuredAt: config?.configuredAt ?? null,
    displayName: config?.displayName ?? null,
    linkedPhone: config?.linkedPhone ?? null,
    lastError: config?.lastError ?? null,
    requiresRunningSandbox: false,
    loginVia: "/gateway",
    connectability,
  };
}
