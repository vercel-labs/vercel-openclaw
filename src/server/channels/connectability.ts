import type { ChannelName } from "@/shared/channels";
import type {
  ChannelConnectability,
  ChannelConnectabilityIssue,
  ChannelConnectabilityStatus,
} from "@/shared/channel-connectability";
import {
  getAiGatewayAuthMode,
  getStoreEnv,
  isVercelDeployment,
} from "@/server/env";
import { buildDeploymentContract } from "@/server/deployment-contract";
import { getWebhookBypassRequirement } from "@/server/deploy-requirements";
import {
  readChannelReadiness,
  getCurrentDeploymentId,
} from "@/server/launch-verify/state";
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

/**
 * Config-only prerequisite check for a channel.
 * Checks: public origin, HTTPS, bypass secret, store, AI gateway auth.
 * Does NOT check launch-verification readiness state.
 * Used by buildDeployPreflight() so preflight is purely config-based.
 */
export async function buildChannelPrerequisite(
  channel: ChannelName,
  request: Request,
  webhookUrlOverride?: string,
): Promise<ChannelConnectability> {
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
        remediation:
          "Deploy to Vercel so the app gets a public URL automatically, or set NEXT_PUBLIC_APP_URL to your custom domain.",
        env: [...PUBLIC_ORIGIN_ENVS],
      });
    }
  }

  if (webhookUrl && !isPublicHttpsUrl(webhookUrl)) {
    addIssue(issues, {
      id: "public-webhook-url",
      status: "fail",
      message: `${label} requires a public HTTPS webhook URL before it can be connected.`,
      remediation:
        "Deploy to Vercel to get a public HTTPS URL. Local development URLs (localhost) cannot receive webhooks from external platforms.",
      env: [...PUBLIC_ORIGIN_ENVS],
    });
  }

  const bypassRequirement = getWebhookBypassRequirement();

  if (bypassRequirement.required && !bypassRequirement.configured) {
    addIssue(issues, {
      id: "webhook-bypass",
      status: "fail",
      message:
        `${label} cannot reach a protected Vercel deployment until ` +
        "VERCEL_AUTOMATION_BYPASS_SECRET is configured.",
      remediation:
        "In your Vercel project, go to Settings > Deployment Protection > Protection Bypass for Automation and enable it. Copy the generated secret and add it as the VERCEL_AUTOMATION_BYPASS_SECRET environment variable.",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    });
  }

  if (!getStoreEnv()) {
    const onVercel = isVercelDeployment();
    addIssue(issues, {
      id: "store",
      status: onVercel ? "fail" : "warn",
      message: onVercel
        ? `${label} cannot be connected without durable state on a Vercel deployment.`
        : `${label} is using in-memory state. Channel reliability requires Upstash in production.`,
      remediation:
        "Add Upstash Redis from the Vercel Marketplace so queue state, channel credentials, session history, and sandbox metadata survive cold starts.",
      env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    });
  }

  const aiGatewayAuth = await getAiGatewayAuthMode();
  if (isVercelDeployment() && aiGatewayAuth !== "oidc") {
    addIssue(issues, {
      id: "ai-gateway",
      status: "fail",
      message:
        `${label} requires Vercel AI Gateway authentication through OIDC on deployed Vercel environments.`,
      remediation:
        "Remove AI_GATEWAY_API_KEY from the Vercel project and redeploy. This app should use the deployment's Vercel OIDC token for AI Gateway auth.",
      env: ["AI_GATEWAY_API_KEY"],
    });
  }

  // Contract-derived issues: openclaw-package-spec, auth config.
  // Uses the same deployment contract as preflight so wording is identical.
  const contract = await buildDeploymentContract();
  for (const req of contract.requirements) {
    if (req.status === "fail") {
      addIssue(issues, {
        id: req.id as ChannelConnectabilityIssue["id"],
        status: "fail",
        message: `${label} cannot be connected: ${req.message}`,
        remediation: req.remediation,
        env: req.env,
      });
    }
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
): Promise<Record<ChannelName, ChannelConnectability>> {
  const [slack, telegram, discord] = await Promise.all([
    buildChannelPrerequisite("slack", request),
    buildChannelPrerequisite("telegram", request),
    buildChannelPrerequisite("discord", request),
  ]);

  return { slack, telegram, discord };
}

/**
 * Full connectability check for a channel: config prerequisites + launch-verification.
 * Used by channel PUT routes to gate credential saves.
 */
export async function buildChannelConnectability(
  channel: ChannelName,
  request: Request,
  webhookUrlOverride?: string,
): Promise<ChannelConnectability> {
  const prerequisite = await buildChannelPrerequisite(
    channel,
    request,
    webhookUrlOverride,
  );

  // Start with all config-level issues
  const issues: ChannelConnectabilityIssue[] = [...prerequisite.issues];
  const label = CHANNEL_LABELS[channel];

  // Add runtime launch-verification check
  const readiness = await readChannelReadiness();
  const currentDeploymentId = getCurrentDeploymentId();
  if (!readiness.ready || readiness.deploymentId !== currentDeploymentId) {
    const reason = readiness.deploymentId !== currentDeploymentId
      ? "Launch verification has not been run for the current deployment."
      : readiness.failingPhaseId
        ? `Launch verification failed at phase "${readiness.failingPhaseId}".`
        : "Launch verification has not passed yet.";
    addIssue(issues, {
      id: "launch-verification",
      status: "fail",
      message: `${label} cannot be connected until destructive launch verification passes. ${reason}`,
      remediation:
        'Run destructive launch verification from the admin panel or POST /api/admin/launch-verify with {"mode":"destructive"} (or ?mode=destructive) to prove the full queue → wake → reply path works.',
      env: [],
    });
  }

  logInfo("channel_connectability.built", {
    channel,
    status: summarizeStatus(issues),
    issueCount: issues.length,
    issueIds: issues.map((i) => i.id),
  });

  return buildResult(channel, prerequisite.webhookUrl, issues);
}

export async function buildChannelConnectabilityReport(
  request: Request,
): Promise<Record<ChannelName, ChannelConnectability>> {
  const [slack, telegram, discord] = await Promise.all([
    buildChannelConnectability("slack", request),
    buildChannelConnectability("telegram", request),
    buildChannelConnectability("discord", request),
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
