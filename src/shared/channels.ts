export type ChannelName = "slack" | "telegram" | "discord";

export type SlackChannelConfig = {
  signingSecret: string;
  botToken: string;
  configuredAt: number;
  team?: string;
  user?: string;
  botId?: string;
  lastError?: string;
};

export type TelegramChannelConfig = {
  botToken: string;
  webhookSecret: string;
  previousWebhookSecret?: string;
  previousSecretExpiresAt?: number;
  webhookUrl: string;
  botUsername: string;
  configuredAt: number;
  lastError?: string;
};

export type DiscordChannelConfig = {
  publicKey: string;
  applicationId: string;
  botToken: string;
  configuredAt: number;
  appName?: string;
  botUsername?: string;
  endpointConfigured?: boolean;
  endpointUrl?: string;
  endpointError?: string;
  commandRegistered?: boolean;
  commandId?: string;
  commandRegisteredAt?: number;
};

export type ChannelConfigs = {
  slack: SlackChannelConfig | null;
  telegram: TelegramChannelConfig | null;
  discord: DiscordChannelConfig | null;
};

export function createDefaultChannelConfigs(): ChannelConfigs {
  return {
    slack: null,
    telegram: null,
    discord: null,
  };
}

export function ensureChannelConfigs(input: unknown): ChannelConfigs {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createDefaultChannelConfigs();
  }

  const raw = input as Partial<ChannelConfigs>;
  return {
    slack: isSlackChannelConfig(raw.slack) ? raw.slack : null,
    telegram: isTelegramChannelConfig(raw.telegram) ? raw.telegram : null,
    discord: isDiscordChannelConfig(raw.discord) ? raw.discord : null,
  };
}

function isSlackChannelConfig(value: unknown): value is SlackChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<SlackChannelConfig>;
  return (
    typeof raw.signingSecret === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isTelegramChannelConfig(value: unknown): value is TelegramChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<TelegramChannelConfig>;
  return (
    typeof raw.botToken === "string" &&
    typeof raw.webhookSecret === "string" &&
    typeof raw.webhookUrl === "string" &&
    typeof raw.botUsername === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isDiscordChannelConfig(value: unknown): value is DiscordChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<DiscordChannelConfig>;
  return (
    typeof raw.publicKey === "string" &&
    typeof raw.applicationId === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}
