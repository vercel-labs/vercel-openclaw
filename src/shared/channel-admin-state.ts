import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { ChannelMode } from "@/shared/channels";
import type { WhatsAppLinkState } from "@/shared/channels";

export type PublicSlackState = {
  configured: boolean;
  webhookUrl: string;
  configuredAt: number | null;
  team: string | null;
  user: string | null;
  botId: string | null;
  hasSigningSecret: boolean;
  hasBotToken: boolean;
  lastError: string | null;
  connectability: ChannelConnectability;
  /** "oauth" when app credentials are present (env or Redis), "manual" otherwise. */
  installMethod: "oauth" | "manual";
  /** Install route URL when OAuth mode is available. */
  installUrl: string | null;
  /** True when client_id + client_secret + signing_secret are all resolved. */
  appCredentialsConfigured: boolean;
  /** Where the resolved app credentials came from. */
  appCredentialsSource: "redis" | "env" | "none";
  /** Slack app ID (e.g. "A07ABC123") when the app was created via apps.manifest.create. */
  appId: string | null;
  /** Display name captured when the app was created. */
  appName: string | null;
  /** Unix-epoch ms when the stored app record was created. */
  appCreatedAt: number | null;
  /** Vercel scope/team slug that owned this app at create time. */
  projectScope: string | null;
  /** Vercel project name that owned this app at create time. */
  projectName: string | null;
};

export type PublicTelegramState = {
  configured: boolean;
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

export type PublicWhatsAppState = {
  configured: boolean;
  mode: ChannelMode;
  webhookUrl: string | null;
  status: WhatsAppLinkState;
  configuredAt: number | null;
  displayName: string | null;
  linkedPhone: string | null;
  lastError: string | null;
  requiresRunningSandbox: boolean;
  loginVia: string;
  connectability: ChannelConnectability;
};

export type PublicChannelState = {
  slack: PublicSlackState;
  telegram: PublicTelegramState;
  discord: PublicDiscordState;
  whatsapp: PublicWhatsAppState;
};
