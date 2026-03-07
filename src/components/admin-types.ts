export type LearnedDomain = {
  domain: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
};

export type FirewallEvent = {
  id: string;
  timestamp: number;
  action: string;
  decision: string;
  domain?: string;
  reason?: string;
  source?: string;
};

export type StatusPayload = {
  authMode: "deployment-protection" | "sign-in-with-vercel";
  storeBackend: string;
  persistentStore: boolean;
  status: string;
  sandboxId: string | null;
  snapshotId: string | null;
  gatewayReady: boolean;
  gatewayUrl: string;
  lastError: string | null;
  firewall: {
    mode: "disabled" | "learning" | "enforcing";
    allowlist: string[];
    learned: LearnedDomain[];
    events: FirewallEvent[];
    updatedAt: number;
  };
  channels: {
    slack: {
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
    telegram: {
      configured: boolean;
      queueDepth: number;
      webhookUrl: string | null;
      botUsername: string | null;
      configuredAt: number | null;
      lastError: string | null;
      status: "connected" | "disconnected" | "error";
    };
    discord: {
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
  };
  user: {
    sub: string;
    email?: string;
    name?: string;
    preferredUsername?: string;
  } | null;
};

export type UnauthorizedPayload = {
  authorizeUrl?: string;
  error: string;
  message: string;
};

export type SlackTestPayload = {
  ok: boolean;
  team: string;
  user: string;
  botId: string;
};

export type TelegramPreviewPayload = {
  ok: boolean;
  bot: {
    id: number;
    first_name: string;
    username?: string;
  };
};

export type RunAction = (
  action: string,
  input: RequestInit & { label: string },
) => Promise<void>;

export type RequestJson = <T>(
  action: string,
  input: RequestInit & { label: string; refreshAfter?: boolean },
) => Promise<T | null>;
