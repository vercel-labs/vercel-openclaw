import {
  getAuthMode,
  getCronSecretConfig,
  isVercelDeployment,
} from "@/server/env";
import { getConfiguredAdminSecret } from "@/server/auth/admin-secret";
import { isPublicUrl } from "@/server/channels/discord/application";
import { buildChannelPrerequisiteReport } from "@/server/channels/connectability";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { ChannelName } from "@/shared/channels";
import {
  buildDeploymentContract,
  type DeploymentContract,
  type DeploymentRequirement,
} from "@/server/deployment-contract";
import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";
import { logDebug, logInfo } from "@/server/log";
import {
  resolvePublicOrigin,
  type BuiltPublicUrlDiagnostics,
  type PublicOriginResolution,
} from "@/server/public-url";
import {
  buildChannelDisplayWebhookUrl,
  CHANNEL_WEBHOOK_PATHS,
} from "@/server/channels/webhook-urls";

export type PreflightStatus = "pass" | "warn" | "fail";

export type PreflightCheckId =
  | "public-origin"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "openclaw-package-spec"
  | "auth-config"
  | "bootstrap-exposure"
  | "cron-secret";

export type PreflightActionId =
  | "configure-public-origin"
  | "configure-webhook-bypass"
  | "configure-upstash"
  | "configure-ai-gateway-auth"
  | "configure-openclaw-package-spec"
  | "configure-oauth"
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
  webhookBypassRecommended: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  cronSecretExplicitlyConfigured: boolean;
  cronSecretSource: ReturnType<typeof getCronSecretConfig>["source"];
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: PreflightWebhookDiagnostics;
  channels: Record<ChannelName, ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
  nextSteps: PreflightNextStep[];
};

type DisplayWebhookChannel = "slack" | "telegram" | "discord";

function buildDisplayWebhookDiagnostics(
  channel: DisplayWebhookChannel,
  request: Request,
  publicOriginResolution: PublicOriginResolution,
): BuiltPublicUrlDiagnostics | null {
  const url = buildChannelDisplayWebhookUrl(channel, request);
  if (!url) return null;

  return {
    path: CHANNEL_WEBHOOK_PATHS[channel],
    url,
    source: publicOriginResolution.source,
    authMode: publicOriginResolution.authMode,
    bypassEnabled: publicOriginResolution.bypassEnabled,
    bypassApplied: false,
  };
}

function buildWebhookDiagnostics(
  request: Request,
  publicOriginResolution: PublicOriginResolution | null,
): PreflightWebhookDiagnostics {
  if (!publicOriginResolution) {
    return { slack: null, telegram: null, discord: null };
  }

  const slack = buildDisplayWebhookDiagnostics(
    "slack",
    request,
    publicOriginResolution,
  );
  const telegram = buildDisplayWebhookDiagnostics(
    "telegram",
    request,
    publicOriginResolution,
  );
  const discordBase = buildDisplayWebhookDiagnostics(
    "discord",
    request,
    publicOriginResolution,
  );

  logDebug("preflight.webhook_diagnostics_built", {
    slackUrl: slack?.url ?? null,
    telegramUrl: telegram?.url ?? null,
    discordUrl: discordBase?.url ?? null,
    webhookBypassEnabled: publicOriginResolution.bypassEnabled,
    slackBypassApplied: slack?.bypassApplied ?? false,
    telegramBypassApplied: telegram?.bypassApplied ?? false,
    discordBypassApplied: discordBase?.bypassApplied ?? false,
  });

  return {
    slack,
    telegram,
    discord: discordBase
      ? {
          ...discordBase,
          isPublic: isPublicUrl(discordBase.url),
        }
      : null,
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
  webhookBypassRecommended: boolean;
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

  if (input.webhookBypassRecommended && !input.webhookBypassEnabled) {
    actions.push({
      id: "configure-webhook-bypass",
      status: "recommended",
      message:
        "Enable Protection Bypass for Automation and set VERCEL_AUTOMATION_BYPASS_SECRET so Slack and Discord can reach the protected deployment. Telegram does not use the bypass query parameter; use a Deployment Protection Exception or another protection-compatible path for its webhook.",
      remediation:
        "In your Vercel project, go to Settings > Deployment Protection > Protection Bypass for Automation. Enable it and copy the secret into VERCEL_AUTOMATION_BYPASS_SECRET for Slack and Discord. For Telegram, add a Deployment Protection Exception for the webhook endpoint/provider because Telegram cannot preserve the bypass query parameter, then redeploy.",
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

  // Derive cron-secret action from contract requirement
  const contractCronReq = input.contract.requirements.find(
    (r) => r.id === "cron-secret",
  );
  if (contractCronReq && contractCronReq.status !== "pass") {
    actions.push({
      id: "configure-cron-secret",
      status: contractCronReq.status === "fail" ? "required" : "recommended",
      message: contractCronReq.message,
      remediation: contractCronReq.remediation,
      env: contractCronReq.env,
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
  channels: Record<ChannelName, ChannelConnectability>;
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
    [ChannelName, ChannelConnectability]
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
// Bootstrap exposure check — proves /api/setup is sealed on deployed envs.
// ---------------------------------------------------------------------------

async function buildBootstrapExposureCheck(): Promise<PreflightCheck & { details: Record<string, unknown> }> {
  if (isVercelDeployment()) {
    logInfo("deploy_preflight.bootstrap_exposure", {
      deployed: true,
      setupEndpointStatus: 410,
      setupEndpointError: "SETUP_ENDPOINT_SEALED",
    });
    return {
      id: "bootstrap-exposure",
      status: "pass",
      message: "GET /api/setup is sealed on deployed environments.",
      details: {
        deployed: true,
        setupEndpoint: {
          status: 410,
          error: "SETUP_ENDPOINT_SEALED",
        },
      },
    };
  }

  const configured = await getConfiguredAdminSecret();
  logInfo("deploy_preflight.bootstrap_exposure", {
    deployed: false,
    secretSource: configured?.source ?? null,
  });
  return {
    id: "bootstrap-exposure",
    status: "pass",
    message:
      configured?.source === "generated"
        ? "Local development may reveal a generated admin secret when ADMIN_SECRET is unset."
        : "Local development uses ADMIN_SECRET from the environment.",
    details: {
      deployed: false,
      setupEndpoint: {
        status: configured ? 200 : 503,
        source: configured?.source ?? null,
      },
    },
  };
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
  "restorePrepared",
] as const;

export type LaunchVerifySkipPhaseId = (typeof LAUNCH_VERIFY_SKIP_PHASE_IDS)[number];

export type LaunchVerifyBlockingResult = {
  blocking: boolean;
  failingCheckIds: PreflightCheckId[];
  requiredActionIds: PreflightActionId[];
  recommendedActionIds: PreflightActionId[];
  errorMessage: string | null;
  skipPhaseIds: readonly LaunchVerifySkipPhaseId[];
};

/**
 * Determine whether a preflight payload should block launch-verify runtime
 * phases. Both the JSON and NDJSON streaming code paths must use this single
 * helper so that skip behavior is identical.
 */
export function getLaunchVerifyBlocking(
  preflight: PreflightPayload,
): LaunchVerifyBlockingResult {
  const failingChecks = preflight.checks.filter((c) => c.status === "fail");
  const failingCheckIds = failingChecks.map((c) => c.id);

  const requiredActionIds = preflight.actions
    .filter((a) => a.status === "required")
    .map((a) => a.id);

  const recommendedActionIds = preflight.actions
    .filter((a) => a.status === "recommended")
    .map((a) => a.id);

  if (failingChecks.length === 0) {
    logInfo("launch_verify.blocking_check", {
      blocking: false,
      failingCheckIds: [],
      requiredActionIds,
      recommendedActionIds,
      skipPhaseIds: [],
    });

    return {
      blocking: false,
      failingCheckIds: [],
      requiredActionIds,
      recommendedActionIds,
      errorMessage: null,
      skipPhaseIds: [],
    };
  }

  const remediations = preflight.actions
    .filter((a) => a.status === "required")
    .map((a) => a.remediation);

  const errorMessage = `Preflight config checks failed: ${failingCheckIds.join(", ")}. ${remediations.join(" ")}`;

  logInfo("launch_verify.blocking_check", {
    blocking: true,
    failingCheckIds,
    requiredActionIds,
    recommendedActionIds,
    skipPhaseIds: [...LAUNCH_VERIFY_SKIP_PHASE_IDS],
  });

  return {
    blocking: true,
    failingCheckIds,
    requiredActionIds,
    recommendedActionIds,
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
  const webhookBypassRecommended =
    webhookBypassRequirement.recommendation === "recommended";
  const storeBackend = contract.storeBackend;

  const aiGatewayAuth = contract.aiGatewayAuth;

  const cronSecret = getCronSecretConfig();
  const cronSecretConfigured = cronSecret.value !== null;
  const cronSecretExplicitlyConfigured = cronSecret.source === "cron-secret";
  const cronSecretSource = cronSecret.source;
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

  const cronSecretReq = contract.requirements.find(
    (r) => r.id === "cron-secret",
  );

  const bootstrapCheck = await buildBootstrapExposureCheck();

  const checks: PreflightCheck[] = [
    // public-origin — derived from contract (warn locally, fail on Vercel)
    {
      id: "public-origin",
      status: (contractOriginReq?.status ?? "fail") as PreflightStatus,
      message: contractOriginReq?.message ??
        "Could not resolve a canonical public origin. Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN.",
    },
    // webhook-bypass — diagnostic-only, never a hard blocker.
    // A missing bypass secret is a warning (not fail) because admin-secret
    // auth handles webhooks without bypass, and even sign-in-with-vercel
    // deployments can work when Deployment Protection is disabled.
    // This is the single source of truth for webhook-bypass blocking
    // semantics — getLaunchVerifyBlocking() derives skip behavior from
    // check statuses, so "warn" here means launch-verify runtime phases
    // are never skipped solely because of a missing bypass secret.
    {
      id: "webhook-bypass",
      status: webhookBypassRecommended ? "warn" : "pass",
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
    // cron-secret — derived from contract (fail on Vercel when missing, pass otherwise)
    ...(cronSecretReq
      ? [
          {
            id: "cron-secret" as const,
            status: cronSecretReq.status as PreflightStatus,
            message: cronSecretReq.message,
          },
        ]
      : []),
    bootstrapCheck,
  ];

  const actions = buildActions({
    publicOriginResolution,
    webhookBypassEnabled,
    webhookBypassRecommended,
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
    webhookBypassRecommended,
    storeBackend,
    aiGatewayAuth,
    cronSecretConfigured,
    cronSecretExplicitlyConfigured,
    cronSecretSource,
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
    webhookBypassRecommended: payload.webhookBypassRecommended,
    storeBackend: payload.storeBackend,
    aiGatewayAuth: payload.aiGatewayAuth,
    cronSecretConfigured: payload.cronSecretConfigured,
    cronSecretExplicitlyConfigured: payload.cronSecretExplicitlyConfigured,
    cronSecretSource: payload.cronSecretSource,
    actionCount: payload.actions.length,
    consumedContractIds,
  });

  return payload;
}
