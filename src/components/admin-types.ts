import type { ChannelConnectability } from "@/shared/channel-connectability";

export type DomainCategory = "npm" | "curl" | "git" | "dns" | "fetch" | "unknown";

export type LearnedDomain = {
  domain: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
  categories?: DomainCategory[];
};

export type FirewallEvent = {
  id: string;
  timestamp: number;
  action: string;
  decision: string;
  domain?: string;
  reason?: string;
  source?: string;
  sourceCommand?: string;
  category?: DomainCategory;
};

export type StatusPayload = {
  authMode: "admin-secret" | "sign-in-with-vercel";
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
    lastIngestedAt: number | null;
    learningStartedAt: number | null;
    commandsObserved: number;
    wouldBlock: string[];
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
      connectability: ChannelConnectability;
    };
    telegram: {
      configured: boolean;
      queueDepth: number;
      webhookUrl: string | null;
      botUsername: string | null;
      configuredAt: number | null;
      lastError: string | null;
      status: "connected" | "disconnected" | "error";
      connectability: ChannelConnectability;
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
      connectability: ChannelConnectability;
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

export type DiagnosticsResponse = {
  mode: "disabled" | "learning" | "enforcing";
  learningHealth: {
    durationMs: number | null;
    commandsObserved: number;
    uniqueDomains: number;
    lastIngestedAt: number | null;
    stalenessMs: number | null;
  };
  syncStatus: {
    lastAppliedAt: number | null;
    lastFailedAt: number | null;
    lastReason: string | null;
  };
  ingestionStatus: {
    lastSkipReason: string | null;
    consecutiveSkips: number;
  };
  wouldBlockCount: number;
};

export type FirewallIngestOutcome = {
  timestamp: number;
  durationMs: number;
  domainsSeenCount: number;
  newCount: number;
  updatedCount: number;
  skipReason: string | null;
};

export type FirewallSyncOutcome = {
  timestamp: number;
  durationMs: number;
  allowlistCount: number;
  policyHash: string;
  applied: boolean;
  reason: string;
};

export type FirewallStatePayload = {
  mode: "disabled" | "learning" | "enforcing";
  allowlist: string[];
  learned: LearnedDomain[];
  events: FirewallEvent[];
  updatedAt: number;
  lastIngestedAt: number | null;
  learningStartedAt: number | null;
  commandsObserved: number;
  wouldBlock: string[];
  lastSyncAppliedAt: number | null;
  lastSyncFailedAt: number | null;
  lastSyncReason: string | null;
  lastIngestionSkipReason: string | null;
  ingestionSkipCount: number;
  lastIngestOutcome: FirewallIngestOutcome | null;
  lastSyncOutcome: FirewallSyncOutcome | null;
};

export type FirewallReportPayload = {
  schemaVersion: 1;
  generatedAt: number;
  state: FirewallStatePayload;
  diagnostics: DiagnosticsResponse;
  groupedLearned: Array<{
    registrableDomain: string;
    domains: LearnedDomain[];
  }>;
  wouldBlock: string[];
  lastIngest: FirewallIngestOutcome | null;
  lastSync: FirewallSyncOutcome | null;
  limitations: string[];
  policyHash: string;
};

export type RunAction = (
  action: string,
  input: RequestInit & { label: string },
) => Promise<void>;

export type RequestJson = <T>(
  action: string,
  input: RequestInit & { label: string; refreshAfter?: boolean },
) => Promise<T | null>;
