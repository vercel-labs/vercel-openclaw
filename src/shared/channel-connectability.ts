import type { ChannelName } from "@/shared/channels";

export type ChannelConnectabilityStatus = "pass" | "warn" | "fail";

export type ChannelConnectabilityIssueId =
  | "public-origin"
  | "public-webhook-url"
  | "webhook-bypass"
  | "store"
  | "drain-recovery";

export type ChannelConnectabilityIssue = {
  id: ChannelConnectabilityIssueId;
  status: ChannelConnectabilityStatus;
  message: string;
  env: string[];
};

export type ChannelConnectability = {
  channel: ChannelName;
  canConnect: boolean;
  status: ChannelConnectabilityStatus;
  webhookUrl: string | null;
  issues: ChannelConnectabilityIssue[];
};
