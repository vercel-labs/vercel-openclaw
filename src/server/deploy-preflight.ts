import {
  getAuthMode,
} from "@/server/env";
import { isPublicUrl } from "@/server/channels/discord/application";
import { buildChannelPrerequisiteReport } from "@/server/channels/connectability";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import {
  buildDeploymentContract,
  type DeploymentContract,
  type DeploymentRequirement,
} from "@/server/deployment-contract";
import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";
import { logInfo } from "@/server/log";
import {
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
  | "drain-recovery"
  | "openclaw-package-spec"
  | "auth-config";

export type PreflightActionId =
  | "configure-public-origin"
  | "configure-webhook-bypass"
  | "configure-upstash"
  | "configure-ai-gateway-auth"
  | "configure-openclaw-package-spec"
  | "configure-oauth";

export type PreflightCheck = {
  id: PreflightCheckId;
  status: PreflightStatus;
  message: string;
};

export type PreflightAction = {
  id: PreflightActionId;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

export type PreflightNextStep = {
  id: string;
  label: string;
  description: string;
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
  webhookBypassRequired: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: PreflightWebhookDiagnostics;
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
  nextSteps: PreflightNextStep[];
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

function contractRequirementToAction(
  req: DeploymentRequirement,
): PreflightAction | null {
  if (req.status === "pass") return null;

  const idMap: Partial<Record<string, PreflightActionId>> = {
    "openclaw-package-spec": "configure-openclaw-package-spec",
    "oauth-client-id": "configure-oauth",
    "oauth-client-secret": "configure-oauth",
    "session-secret": "configure-oauth",
  };
  const actionId = idMap[req.id];
  if (!actionId) return null;

  return {
    id: actionId,
    status: req.status === "fail" ? "required" : "recommended",
    message: req.message,
    remediation: req.remediation,
    env: req.env,
  };
}

function buildActions(input: {
  publicOriginResolution: PublicOriginResolution | null;
  webhookBypassEnabled: boolean;
  webhookBypassRequired: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: PreflightPayload["aiGatewayAuth"];
  contract: DeploymentContract;
}): PreflightAction[] {
  const actions: PreflightAction[] = [];

  // Derive public-origin action severity from contract requirement
  const contractOriginReq = input.contract.requirements.find(
    (r) => r.id === "public-origin",
  );
  if (contractOriginReq && contractOriginReq.status !== "pass") {
    actions.push({
      id: "configure-public-origin",
      status: contractOriginReq.status === "fail" ? "required" : "recommended",
      message: contractOriginReq.message,
      remediation: contractOriginReq.remediation,
      env: contractOriginReq.env,
    });
  }

  if (input.webhookBypassRequired && !input.webhookBypassEnabled) {
    actions.push({
      id: "configure-webhook-bypass",
      status: "required",
      message:
        "Enable Protection Bypass for Automation and set VERCEL_AUTOMATION_BYPASS_SECRET so Slack, Telegram, and Discord can reach the protected deployment.",
      remediation:
        "In your Vercel project, go to Settings > Deployment Protection > Protection Bypass for Automation. Enable it and copy the secret into the VERCEL_AUTOMATION_BYPASS_SECRET environment variable, then redeploy.",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    });
  }

  // Derive store action severity from contract requirement
  const contractStoreReq = input.contract.requirements.find(
    (r) => r.id === "store",
  );
  if (contractStoreReq && contractStoreReq.status !== "pass") {
    actions.push({
      id: "configure-upstash",
      status: contractStoreReq.status === "fail" ? "required" : "recommended",
      message: contractStoreReq.message,
      remediation: contractStoreReq.remediation,
      env: contractStoreReq.env,
    });
  }

  // Derive ai-gateway action severity from contract requirement
  const contractGatewayReq = input.contract.requirements.find(
    (r) => r.id === "ai-gateway",
  );
  if (contractGatewayReq && contractGatewayReq.status !== "pass") {
    actions.push({
      id: "configure-ai-gateway-auth",
      status: contractGatewayReq.status === "fail" ? "required" : "recommended",
      message: contractGatewayReq.message,
      remediation: contractGatewayReq.remediation,
      env: contractGatewayReq.env,
    });
  }

  // Translate contract requirements into actions (openclaw-package-spec, oauth)
  const seenActionIds = new Set<PreflightActionId>();
  for (const req of input.contract.requirements) {
    const action = contractRequirementToAction(req);
    if (action && !seenActionIds.has(action.id)) {
      seenActionIds.add(action.id);
      actions.push(action);
    }
  }

  return actions;
}

function buildNextSteps(input: {
  ok: boolean;
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
}): PreflightNextStep[] {
  const steps: PreflightNextStep[] = [];

  if (!input.ok) {
    const requiredActions = input.actions.filter((a) => a.status === "required");
    if (requiredActions.length > 0) {
      steps.push({
        id: "resolve-blockers",
        label: "Resolve deployment blockers",
        description: `Fix ${requiredActions.length} required action${requiredActions.length > 1 ? "s" : ""} before connecting channels: ${requiredActions.map((a) => a.id).join(", ")}.`,
      });
    }
    return steps;
  }

  steps.push({
    id: "ensure-sandbox",
    label: "Start the sandbox",
    description:
      "Open the admin panel and click Ensure Running, or visit /gateway to auto-start the sandbox.",
  });

  const channelEntries = Object.entries(input.channels) as Array<
    ["slack" | "telegram" | "discord", ChannelConnectability]
  >;
  const connectable = channelEntries.filter(([, ch]) => ch.canConnect);

  if (connectable.length > 0) {
    steps.push({
      id: "connect-channels",
      label: "Connect a channel",
      description:
        "Go to the Channels tab in the admin panel. Each channel has a step-by-step wizard: Slack (paste signing secret + bot token), Telegram (paste bot token from @BotFather), Discord (paste bot token — endpoint and /ask command are configured automatically).",
    });
  }

  const recommendedActions = input.actions.filter(
    (a) => a.status === "recommended",
  );
  if (recommendedActions.length > 0) {
    steps.push({
      id: "recommended-setup",
      label: "Recommended improvements",
      description: recommendedActions.map((a) => a.message).join(" "),
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Launch-verify blocking helper — canonical source of truth for deciding
// which preflight failures abort runtime phases.
// ---------------------------------------------------------------------------

/** Phase IDs that are skipped when preflight is blocking. */
export const LAUNCH_VERIFY_SKIP_PHASE_IDS = [
  "queuePing",
  "ensureRunning",
  "chatCompletions",
  "wakeFromSleep",
] as const;

export type LaunchVerifyBlockingResult =
  | { blocking: true; failingCheckIds: PreflightCheckId[]; errorMessage: string; skipPhaseIds: readonly string[] }
  | { blocking: false };

/**
 * Determine whether a preflight payload should block launch-verify runtime
 * phases. Both the JSON and NDJSON streaming code paths must use this single
 * helper so that skip behavior is identical.
 */
export function getLaunchVerifyBlocking(
  preflight: PreflightPayload,
): LaunchVerifyBlockingResult {
  const failingChecks = preflight.checks.filter((c) => c.status === "fail");

  if (failingChecks.length === 0) {
    logInfo("launch_verify.blocking_check", { blocking: false, failingCheckIds: [] });
    return { blocking: false };
  }

  const failingCheckIds = failingChecks.map((c) => c.id);
  const remediations = preflight.actions
    .filter((a) => a.status === "required")
    .map((a) => a.remediation);
  const errorMessage = `Preflight config checks failed: ${failingCheckIds.join(", ")}. ${remediations.join(" ")}`;

  logInfo("launch_verify.blocking_check", {
    blocking: true,
    failingCheckIds,
    skipPhaseIds: [...LAUNCH_VERIFY_SKIP_PHASE_IDS],
  });

  return {
    blocking: true,
    failingCheckIds,
    errorMessage,
    skipPhaseIds: LAUNCH_VERIFY_SKIP_PHASE_IDS,
  };
}

export async function buildDeployPreflight(
  request: Request,
): Promise<PreflightPayload> {
  const authMode = getAuthMode();

  // Build the deployment contract once — single source of truth for
  // openclaw-package-spec, oauth, and session-secret requirements.
  const contract = await buildDeploymentContract({ request });

  let publicOriginResolution: PublicOriginResolution | null = null;
  try {
    publicOriginResolution = resolvePublicOrigin(request);
  } catch {
    publicOriginResolution = null;
  }

  const publicOrigin = publicOriginResolution?.origin ?? null;
  const webhookBypassRequirement = getWebhookBypassRequirement();
  const webhookBypassEnabled = webhookBypassRequirement.configured;
  const storeBackend = contract.storeBackend;

  const aiGatewayAuth = contract.aiGatewayAuth;

  const cronSecretConfigured = Boolean(
    process.env.CRON_SECRET?.trim(),
  );
  const webhookDiagnostics = buildWebhookDiagnostics(
    request,
    publicOriginResolution,
  );

  const channels = await buildChannelPrerequisiteReport(request, { contract });

  // ---------------------------------------------------------------------------
  // Derive preflight checks from the deployment contract — single source of
  // truth for pass/warn/fail decisions on public-origin, store, ai-gateway,
  // openclaw-package-spec, and auth config.
  // ---------------------------------------------------------------------------

  const contractOriginReq = contract.requirements.find(
    (r) => r.id === "public-origin",
  );
  const contractStoreReq = contract.requirements.find(
    (r) => r.id === "store",
  );
  const contractGatewayReq = contract.requirements.find(
    (r) => r.id === "ai-gateway",
  );
  const packageSpecReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  const authReqs = contract.requirements.filter(
    (r) =>
      r.id === "oauth-client-id" ||
      r.id === "oauth-client-secret" ||
      r.id === "session-secret",
  );
  const authConfigStatus: PreflightStatus = authReqs.some(
    (r) => r.status === "fail",
  )
    ? "fail"
    : authReqs.some((r) => r.status === "warn")
      ? "warn"
      : "pass";

  const checks: PreflightCheck[] = [
    // public-origin — derived from contract (warn locally, fail on Vercel)
    {
      id: "public-origin",
      status: (contractOriginReq?.status ?? "fail") as PreflightStatus,
      message: contractOriginReq?.message ??
        "Could not resolve a canonical public origin. Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN.",
    },
    // webhook-bypass — diagnostic-only concern, not a contract requirement.
    // The contract returns null for webhook-bypass; preflight owns this as a
    // non-blocking diagnostic check. It always passes because admin-secret
    // auth handles webhooks without bypass.
    {
      id: "webhook-bypass",
      status:
        !webhookBypassRequirement.required || webhookBypassRequirement.configured
          ? "pass"
          : "fail",
      message: getWebhookBypassStatusMessage(webhookBypassRequirement),
    },
    // store — derived from contract (warn locally, fail on Vercel)
    {
      id: "store",
      status: (contractStoreReq?.status ?? "warn") as PreflightStatus,
      message: contractStoreReq?.message ??
        "Using in-memory state. Channel reliability requires Upstash in production.",
    },
    // ai-gateway — derived from contract (warn locally, fail on Vercel)
    {
      id: "ai-gateway",
      status: (contractGatewayReq?.status ?? "fail") as PreflightStatus,
      message: contractGatewayReq?.message ??
        "OIDC token is not available.",
    },
    {
      id: "drain-recovery",
      status: "pass",
      message: cronSecretConfigured
        ? "Channel delivery uses Vercel Queues as the primary mechanism. /api/cron/drain-channels is available as a diagnostic backstop."
        : "Channel delivery uses Vercel Queues as the primary mechanism. Set CRON_SECRET to enable /api/cron/drain-channels as an optional diagnostic backstop.",
    },
    // Contract-derived checks
    ...(packageSpecReq
      ? [
          {
            id: "openclaw-package-spec" as const,
            status: packageSpecReq.status as PreflightStatus,
            message: packageSpecReq.message,
          },
        ]
      : []),
    ...(authReqs.length > 0
      ? [
          {
            id: "auth-config" as const,
            status: authConfigStatus,
            message:
              authConfigStatus === "pass"
                ? "Auth configuration is complete."
                : authReqs
                    .filter((r) => r.status === "fail")
                    .map((r) => r.message)
                    .join(" "),
          },
        ]
      : []),
  ];

  const actions = buildActions({
    publicOriginResolution,
    webhookBypassEnabled,
    webhookBypassRequired: webhookBypassRequirement.required,
    storeBackend,
    aiGatewayAuth,
    contract,
  });

  const ok =
    checks.every((check) => check.status !== "fail") &&
    Object.values(channels).every((ch) => ch.status !== "fail");

  const nextSteps = buildNextSteps({ ok, channels, actions });

  const payload: PreflightPayload = {
    ok,
    authMode,
    publicOrigin,
    webhookBypassEnabled,
    webhookBypassRequired: webhookBypassRequirement.required,
    storeBackend,
    aiGatewayAuth,
    cronSecretConfigured,
    publicOriginResolution,
    webhookDiagnostics,
    channels,
    actions,
    checks,
    nextSteps,
  };

  // Log which contract requirement IDs this surface consumed so drift is inspectable.
  const consumedContractIds = contract.requirements
    .filter((r) => r.status !== "pass")
    .map((r) => `${r.id}:${r.status}`);

  logInfo("deploy_preflight.built", {
    ok: payload.ok,
    authMode: payload.authMode,
    publicOrigin: payload.publicOrigin,
    webhookBypassEnabled: payload.webhookBypassEnabled,
    webhookBypassRequired: payload.webhookBypassRequired,
    storeBackend: payload.storeBackend,
    aiGatewayAuth: payload.aiGatewayAuth,
    cronSecretConfigured: payload.cronSecretConfigured,
    actionCount: payload.actions.length,
    consumedContractIds,
  });

  return payload;
}
