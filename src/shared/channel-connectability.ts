import type { ChannelName } from "@/shared/channels";

export type ChannelConnectabilityStatus = "pass" | "warn" | "fail";

export type ChannelConnectabilityIssueId =
  | "public-origin"
  | "public-webhook-url"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "launch-verification"
  | "openclaw-package-spec"
  | "oauth-client-id"
  | "oauth-client-secret"
  | "session-secret";

export type ChannelConnectabilityIssue = {
  id: ChannelConnectabilityIssueId;
  status: ChannelConnectabilityStatus;
  message: string;
  remediation: string;
  env: string[];
};

export type ChannelConnectability = {
  channel: ChannelName;
  canConnect: boolean;
  status: ChannelConnectabilityStatus;
  webhookUrl: string | null;
  issues: ChannelConnectabilityIssue[];
};
