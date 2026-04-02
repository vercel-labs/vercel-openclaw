import type { ChannelMode, ChannelName } from "@/shared/channels";
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
import { logDebug, logInfo } from "@/server/log";
import { buildChannelDisplayWebhookUrl } from "@/server/channels/webhook-urls";

const ALL_CHANNELS: ChannelName[] = ["slack", "telegram", "discord", "whatsapp"];

type ChannelDefinition = {
  label: string;
  mode: ChannelMode;
  requiresPublicWebhook: boolean;
};

const CHANNEL_DEFINITIONS: Record<ChannelName, ChannelDefinition> = {
  slack: { label: "Slack", mode: "webhook-proxied", requiresPublicWebhook: true },
  telegram: { label: "Telegram", mode: "webhook-proxied", requiresPublicWebhook: true },
  discord: { label: "Discord", mode: "webhook-proxied", requiresPublicWebhook: true },
  whatsapp: { label: "WhatsApp", mode: "webhook-proxied", requiresPublicWebhook: true },
};

const CHANNEL_LABELS: Record<ChannelName, string> = Object.fromEntries(
  ALL_CHANNELS.map((ch) => [ch, CHANNEL_DEFINITIONS[ch].label]),
) as Record<ChannelName, string>;

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
    mode: CHANNEL_DEFINITIONS[channel].mode,
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
    id: requirement.id,
    status: requirement.status,
    message:
      requirement.status === "fail"
        ? `${label} cannot be connected: ${requirement.message}`
        : `${label}: ${requirement.message}`,
    remediation: requirement.remediation,
    env: requirement.env,
  };
}

/**
 * Contract requirements that affect determinism or benchmarking but do not
 * prevent channels from functioning. These are excluded from channel
 * connectability checks.
 */
const NON_CHANNEL_BLOCKING_REQUIREMENTS: Set<string> = new Set([
  "openclaw-package-spec",
  "webhook-bypass",
  "cron-secret",
]);

function collectContractIssues(
  channel: ChannelName,
  contract: { requirements: DeploymentRequirement[] },
): ChannelConnectabilityIssue[] {
  return contract.requirements
    .filter((r) => r.status !== "pass" && !NON_CHANNEL_BLOCKING_REQUIREMENTS.has(r.id))
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
  const def = CHANNEL_DEFINITIONS[channel];
  const label = def.label;
  const contract = shared.contract ?? await buildDeploymentContract({ request });

  // Webhook-proxied channels: contract + webhook URL checks.
  const issues: ChannelConnectabilityIssue[] = collectContractIssues(
    channel,
    contract,
  );

  let webhookUrl: string | null = webhookUrlOverride ?? null;

  const hasIssue = (id: ChannelConnectabilityIssue["id"]) =>
    issues.some((issue) => issue.id === id);

  if (!webhookUrl) {
    try {
      webhookUrl = buildChannelDisplayWebhookUrl(channel, request);
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

  // Log which contract requirement IDs were consumed/excluded so drift is inspectable.
  const excludedContractIds = contract.requirements
    .filter((r) => r.status !== "pass" && NON_CHANNEL_BLOCKING_REQUIREMENTS.has(r.id))
    .map((r) => `${r.id}:${r.status}`);

  logDebug("channel_prerequisite.built", {
    channel,
    mode: def.mode,
    status: summarizeStatus(issues),
    issueCount: issues.length,
    issueIds: issues.map((i) => i.id),
    excludedContractIds,
  });

  return buildResult(channel, webhookUrl, issues);
}

/**
 * Shared connectability map builder — single implementation consumed by both
 * `buildChannelPrerequisiteReport` and `buildChannelConnectabilityReport`.
 *
 * Resolves the deployment contract once and threads it through all channel
 * prerequisite checks. Accepts optional webhook URL overrides for
 * callers that have already resolved display URLs.
 */
export async function buildChannelConnectabilityMap(
  request: Request,
  options: {
    webhookUrlOverrides?: Partial<Record<ChannelName, string>>;
    shared?: SharedConnectabilityInputs;
  } = {},
): Promise<Record<ChannelName, ChannelConnectability>> {
  const contractSource = options.shared?.contract ? "shared" : "fresh";
  const contract =
    options.shared?.contract ?? (await buildDeploymentContract({ request }));
  const nextShared: SharedConnectabilityInputs = {
    ...options.shared,
    contract,
  };

  const results = await Promise.all(
    ALL_CHANNELS.map((channel) => {
      const def = CHANNEL_DEFINITIONS[channel];
      // Gateway-native channels have no webhook URL to override or resolve.
      const webhookOverride =
        def.mode === "gateway-native"
          ? undefined
          : options.webhookUrlOverrides?.[channel] ??
            buildChannelDisplayWebhookUrl(channel, request) ??
            undefined;

      return buildChannelPrerequisite(
        channel,
        request,
        webhookOverride,
        nextShared,
      );
    }),
  );

  const map = Object.fromEntries(
    ALL_CHANNELS.map((ch, i) => [ch, results[i]]),
  ) as Record<ChannelName, ChannelConnectability>;

  logDebug("channel_connectability_map.built", {
    contractSource,
    channels: ALL_CHANNELS.map((ch) => `${ch}:${map[ch].status}`),
  });

  return map;
}

/**
 * Config-only prerequisite report for all channels.
 * Used by buildDeployPreflight() — does NOT include launch-verification checks.
 */
export async function buildChannelPrerequisiteReport(
  request: Request,
  shared: SharedConnectabilityInputs = {},
): Promise<Record<ChannelName, ChannelConnectability>> {
  return buildChannelConnectabilityMap(request, { shared });
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

/**
 * Full connectability report for all channels.
 * Delegates to the shared map builder.
 */
export async function buildChannelConnectabilityReport(
  request: Request,
  shared: SharedConnectabilityInputs = {},
): Promise<Record<ChannelName, ChannelConnectability>> {
  return buildChannelConnectabilityMap(request, { shared });
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
