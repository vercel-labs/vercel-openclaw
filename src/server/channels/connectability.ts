import type { ChannelName } from "@/shared/channels";
import type {
  ChannelConnectability,
  ChannelConnectabilityIssue,
  ChannelConnectabilityStatus,
} from "@/shared/channel-connectability";
import {
  buildDeploymentContract,
  type DeploymentContract,
  type DeploymentRequirement,
} from "@/server/deployment-contract";
import { logInfo } from "@/server/log";
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

function buildResult(
  channel: ChannelName,
  webhookUrl: string | null,
  issues: ChannelConnectabilityIssue[],
): ChannelConnectability {
  return {
    channel,
    canConnect: !issues.some((issue) => issue.status === "fail"),
    status: summarizeStatus(issues),
    webhookUrl,
    issues,
  };
}

function contractRequirementToIssue(
  channel: ChannelName,
  requirement: DeploymentRequirement,
): ChannelConnectabilityIssue {
  const label = CHANNEL_LABELS[channel];
  return {
    id: requirement.id as ChannelConnectabilityIssue["id"],
    status: requirement.status,
    message:
      requirement.status === "fail"
        ? `${label} cannot be connected: ${requirement.message}`
        : `${label}: ${requirement.message}`,
    remediation: requirement.remediation,
    env: requirement.env,
  };
}

function collectContractIssues(
  channel: ChannelName,
  contract: { requirements: DeploymentRequirement[] },
): ChannelConnectabilityIssue[] {
  return contract.requirements
    .filter((r) => r.status !== "pass")
    .map((r) => contractRequirementToIssue(channel, r));
}

/**
 * Shared inputs that can be pre-resolved once and threaded through
 * multiple connectability/prerequisite calls to avoid redundant reads.
 */
export type SharedConnectabilityInputs = {
  contract?: DeploymentContract;
};

/**
 * Config-only prerequisite check for a channel.
 * Delegates deployment-level checks (public-origin, webhook-bypass, store,
 * ai-gateway, package-spec, auth) to the deployment contract — single source
 * of truth. Only channel-specific checks (webhook URL construction, public
 * HTTPS validation) remain here.
 * Does NOT check launch-verification readiness state.
 * Used by buildDeployPreflight() so preflight is purely config-based.
 */
export async function buildChannelPrerequisite(
  channel: ChannelName,
  request: Request,
  webhookUrlOverride?: string,
  shared: SharedConnectabilityInputs = {},
): Promise<ChannelConnectability> {
  const label = CHANNEL_LABELS[channel];
  const contract = shared.contract ?? await buildDeploymentContract({ request });
  const issues: ChannelConnectabilityIssue[] = collectContractIssues(
    channel,
    contract,
  );

  let webhookUrl: string | null = webhookUrlOverride ?? null;

  const hasIssue = (id: ChannelConnectabilityIssue["id"]) =>
    issues.some((issue) => issue.id === id);

  if (!webhookUrl) {
    try {
      webhookUrl = buildPublicUrl(WEBHOOK_PATHS[channel], request);
    } catch {
      if (!hasIssue("public-origin")) {
        addIssue(issues, {
          id: "public-origin",
          status: "fail",
          message: `Could not resolve a canonical public origin for ${label}.`,
          remediation:
            "Deploy to Vercel so the app gets a public URL automatically, or set NEXT_PUBLIC_APP_URL to your custom domain.",
          env: [...PUBLIC_ORIGIN_ENVS],
        });
      }
    }
  }

  if (webhookUrl && !isPublicHttpsUrl(webhookUrl)) {
    addIssue(issues, {
      id: "public-webhook-url",
      status: "fail",
      message: `${label} requires a public HTTPS webhook URL before it can be connected.`,
      remediation:
        "Deploy to Vercel to get a public HTTPS URL. Local development URLs cannot receive platform webhooks.",
      env: [...PUBLIC_ORIGIN_ENVS],
    });
  }

  logInfo("channel_prerequisite.built", {
    channel,
    status: summarizeStatus(issues),
    issueCount: issues.length,
    issueIds: issues.map((i) => i.id),
  });

  return buildResult(channel, webhookUrl, issues);
}

/**
 * Config-only prerequisite report for all channels.
 * Used by buildDeployPreflight() — does NOT include launch-verification checks.
 */
export async function buildChannelPrerequisiteReport(
  request: Request,
  shared: SharedConnectabilityInputs = {},
): Promise<Record<ChannelName, ChannelConnectability>> {
  const contract = shared.contract ?? await buildDeploymentContract({ request });
  const nextShared = { ...shared, contract };

  const [slack, telegram, discord] = await Promise.all([
    buildChannelPrerequisite("slack", request, undefined, nextShared),
    buildChannelPrerequisite("telegram", request, undefined, nextShared),
    buildChannelPrerequisite("discord", request, undefined, nextShared),
  ]);

  return { slack, telegram, discord };
}

/**
 * Full connectability check for a channel.
 * Delegates to buildChannelPrerequisite for config-level checks.
 * Used by channel PUT routes to gate credential saves and by the status API.
 */
export async function buildChannelConnectability(
  channel: ChannelName,
  request: Request,
  webhookUrlOverride?: string,
  shared: SharedConnectabilityInputs = {},
): Promise<ChannelConnectability> {
  return buildChannelPrerequisite(channel, request, webhookUrlOverride, shared);
}

export async function buildChannelConnectabilityReport(
  request: Request,
  shared: SharedConnectabilityInputs = {},
): Promise<Record<ChannelName, ChannelConnectability>> {
  const contract = shared.contract ?? await buildDeploymentContract({ request });
  const nextShared = { ...shared, contract };

  const [slack, telegram, discord] = await Promise.all([
    buildChannelConnectability("slack", request, undefined, nextShared),
    buildChannelConnectability("telegram", request, undefined, nextShared),
    buildChannelConnectability("discord", request, undefined, nextShared),
  ]);

  return { slack, telegram, discord };
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
