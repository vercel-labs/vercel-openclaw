import {
  getAiGatewayBearerTokenOptional,
  getAuthMode,
  getCronSecret,
  getStoreEnv,
} from "@/server/env";
import { isPublicUrl } from "@/server/channels/discord/application";
import { buildChannelConnectabilityReport } from "@/server/channels/connectability";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import { logInfo } from "@/server/log";
import {
  getProtectionBypassSecret,
  getPublicUrlDiagnostics,
  resolvePublicOrigin,
  type BuiltPublicUrlDiagnostics,
  type PublicOriginResolution,
} from "@/server/public-url";

export type PreflightStatus = "pass" | "warn" | "fail";

export type PreflightCheckId =
  | "public-origin"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "drain-recovery";

export type PreflightActionId =
  | "configure-public-origin"
  | "configure-webhook-bypass"
  | "configure-upstash"
  | "configure-ai-gateway-auth"
  | "configure-cron-secret";

export type PreflightCheck = {
  id: PreflightCheckId;
  status: PreflightStatus;
  message: string;
};

export type PreflightAction = {
  id: PreflightActionId;
  status: "required" | "recommended";
  message: string;
  env: string[];
};

export type PreflightWebhookDiagnostics = {
  slack: BuiltPublicUrlDiagnostics | null;
  telegram: BuiltPublicUrlDiagnostics | null;
  discord: (BuiltPublicUrlDiagnostics & { isPublic: boolean }) | null;
};

export type PreflightPayload = {
  ok: boolean;
  authMode: ReturnType<typeof getAuthMode>;
  publicOrigin: string | null;
  webhookBypassEnabled: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: PreflightWebhookDiagnostics;
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
};

function buildWebhookDiagnostics(
  request: Request,
  publicOriginResolution: PublicOriginResolution | null,
): PreflightWebhookDiagnostics {
  if (!publicOriginResolution) {
    return { slack: null, telegram: null, discord: null };
  }

  const slack = getPublicUrlDiagnostics(
    "/api/channels/slack/webhook",
    request,
  );
  const telegram = getPublicUrlDiagnostics(
    "/api/channels/telegram/webhook",
    request,
  );
  const discordBase = getPublicUrlDiagnostics(
    "/api/channels/discord/webhook",
    request,
  );

  return {
    slack,
    telegram,
    discord: {
      ...discordBase,
      isPublic: isPublicUrl(discordBase.url),
    },
  };
}

function buildActions(input: {
  authMode: ReturnType<typeof getAuthMode>;
  publicOriginResolution: PublicOriginResolution | null;
  webhookBypassEnabled: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: PreflightPayload["aiGatewayAuth"];
  cronSecretConfigured: boolean;
}): PreflightAction[] {
  const actions: PreflightAction[] = [];

  if (!input.publicOriginResolution) {
    actions.push({
      id: "configure-public-origin",
      status: "required",
      message:
        "Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN so webhook URLs and OAuth callbacks resolve to one canonical public origin.",
      env: ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_DOMAIN", "BASE_DOMAIN"],
    });
  }

  if (
    input.authMode === "deployment-protection" &&
    !input.webhookBypassEnabled
  ) {
    actions.push({
      id: "configure-webhook-bypass",
      status: "required",
      message:
        "Enable Protection Bypass for Automation and set VERCEL_AUTOMATION_BYPASS_SECRET so Slack, Telegram, and Discord can reach the protected deployment.",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    });
  }

  if (input.storeBackend === "memory") {
    actions.push({
      id: "configure-upstash",
      status: "recommended",
      message:
        "Configure Upstash so channel queues, sandbox metadata, and recovery state survive cold starts.",
      env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    });
  }

  if (input.aiGatewayAuth === "unavailable") {
    actions.push({
      id: "configure-ai-gateway-auth",
      status: "required",
      message:
        "AI Gateway auth is unavailable. On Vercel this should come from OIDC; for local development provide AI_GATEWAY_API_KEY.",
      env: ["AI_GATEWAY_API_KEY"],
    });
  }

  if (!input.cronSecretConfigured) {
    actions.push({
      id: "configure-cron-secret",
      status: "recommended",
      message:
        "Set CRON_SECRET so /api/cron/drain-channels can be called safely by Vercel Cron or another scheduler.",
      env: ["CRON_SECRET"],
    });
  }

  return actions;
}

export async function buildDeployPreflight(
  request: Request,
): Promise<PreflightPayload> {
  const authMode = getAuthMode();

  let publicOriginResolution: PublicOriginResolution | null = null;
  try {
    publicOriginResolution = resolvePublicOrigin(request);
  } catch {
    publicOriginResolution = null;
  }

  const publicOrigin = publicOriginResolution?.origin ?? null;
  const webhookBypassEnabled = Boolean(getProtectionBypassSecret());
  const storeBackend = getStoreEnv() ? "upstash" : "memory";

  const staticKey = process.env.AI_GATEWAY_API_KEY?.trim() || "";
  const resolvedGatewayToken = await getAiGatewayBearerTokenOptional();
  const aiGatewayAuth: PreflightPayload["aiGatewayAuth"] =
    !resolvedGatewayToken
      ? "unavailable"
      : staticKey && resolvedGatewayToken === staticKey
        ? "api-key"
        : "oidc";

  const cronSecretConfigured = Boolean(getCronSecret());
  const webhookDiagnostics = buildWebhookDiagnostics(
    request,
    publicOriginResolution,
  );

  const channels = buildChannelConnectabilityReport(request);

  const checks: PreflightCheck[] = [
    {
      id: "public-origin",
      status: publicOriginResolution ? "pass" : "fail",
      message: publicOriginResolution
        ? `Resolved public origin from ${publicOriginResolution.source}: ${publicOriginResolution.origin}`
        : "Could not resolve a canonical public origin. Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN.",
    },
    {
      id: "webhook-bypass",
      status:
        authMode !== "deployment-protection"
          ? "pass"
          : webhookBypassEnabled
            ? "pass"
            : "fail",
      message:
        authMode !== "deployment-protection"
          ? "Webhook bypass is not required in sign-in-with-vercel mode."
          : webhookBypassEnabled
            ? "Webhook URLs will include x-vercel-protection-bypass."
            : "Deployment Protection is enabled but VERCEL_AUTOMATION_BYPASS_SECRET is missing. Slack, Telegram, and Discord webhooks will be blocked.",
    },
    {
      id: "store",
      status: storeBackend === "upstash" ? "pass" : "warn",
      message:
        storeBackend === "upstash"
          ? "Durable Upstash-backed state is configured."
          : "Using in-memory state. Queue and lifecycle data will be lost on cold starts. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    },
    {
      id: "ai-gateway",
      status: aiGatewayAuth === "unavailable" ? "fail" : "pass",
      message:
        aiGatewayAuth === "oidc"
          ? "AI Gateway will use a Vercel OIDC token."
          : aiGatewayAuth === "api-key"
            ? "AI Gateway will use AI_GATEWAY_API_KEY."
            : "No AI Gateway credential is available.",
    },
    {
      id: "drain-recovery",
      status: cronSecretConfigured ? "pass" : "warn",
      message: cronSecretConfigured
        ? "CRON_SECRET is configured for /api/cron/drain-channels."
        : "CRON_SECRET is missing. Queue replay depends on manual or platform-specific cron wiring.",
    },
  ];

  const actions = buildActions({
    authMode,
    publicOriginResolution,
    webhookBypassEnabled,
    storeBackend,
    aiGatewayAuth,
    cronSecretConfigured,
  });

  const payload: PreflightPayload = {
    ok:
      checks.every((check) => check.status !== "fail") &&
      Object.values(channels).every((ch) => ch.status !== "fail"),
    authMode,
    publicOrigin,
    webhookBypassEnabled,
    storeBackend,
    aiGatewayAuth,
    cronSecretConfigured,
    publicOriginResolution,
    webhookDiagnostics,
    channels,
    actions,
    checks,
  };

  logInfo("deploy_preflight.built", {
    ok: payload.ok,
    authMode: payload.authMode,
    publicOrigin: payload.publicOrigin,
    webhookBypassEnabled: payload.webhookBypassEnabled,
    storeBackend: payload.storeBackend,
    aiGatewayAuth: payload.aiGatewayAuth,
    cronSecretConfigured: payload.cronSecretConfigured,
    actionCount: payload.actions.length,
  });

  return payload;
}
