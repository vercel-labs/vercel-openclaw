import type { ChannelName } from "@/shared/channels";
import type {
  ChannelConnectability,
  ChannelConnectabilityIssue,
  ChannelConnectabilityStatus,
} from "@/shared/channel-connectability";
import { getAuthMode, getCronSecret, getStoreEnv } from "@/server/env";
import { buildPublicUrl } from "@/server/public-url";

const WEBHOOK_PATHS: Record<ChannelName, string> = {
  slack: "/api/channels/slack/webhook",
  telegram: "/api/channels/telegram/webhook",
  discord: "/api/channels/discord/webhook",
};

const CHANNEL_LABELS: Record<ChannelName, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
};

const PUBLIC_ORIGIN_ENVS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_DOMAIN",
  "BASE_DOMAIN",
];

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }

    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) {
      return false;
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function summarizeStatus(
  issues: ChannelConnectabilityIssue[],
): ChannelConnectabilityStatus {
  if (issues.some((issue) => issue.status === "fail")) {
    return "fail";
  }
  if (issues.some((issue) => issue.status === "warn")) {
    return "warn";
  }
  return "pass";
}

function addIssue(
  issues: ChannelConnectabilityIssue[],
  issue: ChannelConnectabilityIssue,
): void {
  issues.push(issue);
}

export function buildChannelConnectability(
  channel: ChannelName,
  request: Request,
  webhookUrlOverride?: string,
): ChannelConnectability {
  const label = CHANNEL_LABELS[channel];
  const issues: ChannelConnectabilityIssue[] = [];
  let webhookUrl: string | null = webhookUrlOverride ?? null;

  if (!webhookUrl) {
    try {
      webhookUrl = buildPublicUrl(WEBHOOK_PATHS[channel], request);
    } catch {
      addIssue(issues, {
        id: "public-origin",
        status: "fail",
        message: `Could not resolve a canonical public origin for ${label}.`,
        env: [...PUBLIC_ORIGIN_ENVS],
      });
    }
  }

  if (webhookUrl && !isPublicHttpsUrl(webhookUrl)) {
    addIssue(issues, {
      id: "public-webhook-url",
      status: "fail",
      message: `${label} requires a public HTTPS webhook URL before it can be connected.`,
      env: [...PUBLIC_ORIGIN_ENVS],
    });
  }

  const requiresBypass =
    getAuthMode() === "deployment-protection" && process.env.VERCEL === "1";

  if (requiresBypass && !process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()) {
    addIssue(issues, {
      id: "webhook-bypass",
      status: "fail",
      message:
        `${label} cannot reach a protected Vercel deployment until ` +
        "VERCEL_AUTOMATION_BYPASS_SECRET is configured.",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    });
  }

  if (!getStoreEnv()) {
    addIssue(issues, {
      id: "store",
      status: "warn",
      message: `${label} queue state will not survive cold starts until Upstash is configured.`,
      env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    });
  }

  if (!getCronSecret()) {
    addIssue(issues, {
      id: "drain-recovery",
      status: "warn",
      message: `${label} retries currently depend on future traffic because CRON_SECRET is missing.`,
      env: ["CRON_SECRET"],
    });
  }

  const status = summarizeStatus(issues);

  return {
    channel,
    canConnect: !issues.some((issue) => issue.status === "fail"),
    status,
    webhookUrl,
    issues,
  };
}

export function buildChannelConnectabilityReport(
  request: Request,
): Record<ChannelName, ChannelConnectability> {
  return {
    slack: buildChannelConnectability("slack", request),
    telegram: buildChannelConnectability("telegram", request),
    discord: buildChannelConnectability("discord", request),
  };
}

export function buildChannelConnectBlockedResponse(
  auth: { setCookieHeader: string | null },
  connectability: ChannelConnectability,
): Response {
  const response = Response.json(
    {
      error: {
        code: "CHANNEL_CONNECT_BLOCKED",
        message: `Cannot connect ${connectability.channel} until deployment blockers are resolved.`,
      },
      connectability,
    },
    { status: 409 },
  );

  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }

  return response;
}
