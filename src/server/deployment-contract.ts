import {
  getAiGatewayAuthMode,
  getAuthMode,
  getCronSecret,
  getOpenclawPackageSpec,
  getStoreEnv,
  isVercelDeployment,
} from "@/server/env";
import { logDebug, logInfo } from "@/server/log";
import { getProtectionBypassSecret, resolvePublicOrigin } from "@/server/public-url";

// Re-export shared types so existing consumers keep working.
export type {
  DeploymentRequirementId,
  DeploymentRequirementStatus,
} from "@/shared/deployment-requirements";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type {
  DeploymentRequirementId,
  DeploymentRequirementStatus,
} from "@/shared/deployment-requirements";

export type DeploymentRequirement = {
  id: DeploymentRequirementId;
  status: DeploymentRequirementStatus;
  message: string;
  remediation: string;
  env: string[];
};

export type DeploymentContract = {
  ok: boolean;
  authMode: "admin-secret" | "sign-in-with-vercel";
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  openclawPackageSpec: string | null;
  requirements: DeploymentRequirement[];
};

export type BuildDeploymentContractOptions = {
  request?: Request;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PINNED_VERSION_RE = /^[^@]+@\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/**
 * Returns true when the spec is an exact pinned version like `openclaw@1.2.3`
 * or `openclaw@1.0.0-beta.1`. Returns false for ranges, tags (`@latest`),
 * missing specs, etc.
 */
export function isPinnedPackageSpec(
  spec: string | null | undefined,
): boolean {
  if (!spec) return false;
  return PINNED_VERSION_RE.test(spec);
}

// ---------------------------------------------------------------------------
// Requirement builders
// ---------------------------------------------------------------------------

const PUBLIC_ORIGIN_ENV = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_DOMAIN",
  "BASE_DOMAIN",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
];
const CRON_SECRET_ENV = ["CRON_SECRET"];
const CRON_SECRET_REQUIREMENT_ID: DeploymentRequirementId = "cron-secret";

function checkPublicOrigin(
  onVercel: boolean,
  request?: Request,
): DeploymentRequirement {
  try {
    const resolution = resolvePublicOrigin(request);
    return {
      id: "public-origin",
      status: "pass",
      message: `Public origin resolves from ${resolution.source}.`,
      remediation: "",
      env: PUBLIC_ORIGIN_ENV,
    };
  } catch {
    return {
      id: "public-origin",
      status: onVercel ? "fail" : "warn",
      message: onVercel
        ? "Could not resolve a canonical public origin on a Vercel deployment."
        : "Could not resolve a canonical public origin in this environment.",
      remediation:
        "Set NEXT_PUBLIC_APP_URL or NEXT_PUBLIC_BASE_DOMAIN, or rely on Vercel system URL variables in deployed environments.",
      env: PUBLIC_ORIGIN_ENV,
    };
  }
}

/**
 * Diagnostic-only: returns pass or warn, never fail. Preflight computes its
 * own webhook-bypass check via getWebhookBypassRequirement() for richer
 * configured/recommendation/reason semantics. Both surfaces agree that a missing
 * bypass secret is not a deployment blocker.
 */
function checkWebhookBypass(): DeploymentRequirement {
  const configured = Boolean(getProtectionBypassSecret());

  if (configured) {
    return {
      id: "webhook-bypass",
      status: "pass",
      message:
        "Protection bypass secret is configured for protected deployment webhook flows.",
      remediation: "",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    };
  }

  return {
    id: "webhook-bypass",
    status: "warn",
    message:
      "Protection bypass secret is not configured. This is safe only when Deployment Protection is disabled; protected third-party webhooks can be blocked before app auth runs.",
    remediation:
      "If Deployment Protection is enabled, set VERCEL_AUTOMATION_BYPASS_SECRET or use a Deployment Protection Exception for webhook endpoints/providers that cannot preserve the bypass query parameter.",
    env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
  };
}

function checkStore(onVercel: boolean): DeploymentRequirement {
  const configured = Boolean(getStoreEnv());

  if (configured) {
    return {
      id: "store",
      status: "pass",
      message: "Durable store is configured.",
      remediation: "",
      env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    };
  }

  return {
    id: "store",
    status: onVercel ? "fail" : "warn",
    message: onVercel
      ? "Upstash Redis is required on Vercel deployments."
      : "Using in-memory store in a non-Vercel environment.",
    remediation:
      "Add Upstash Redis so sandbox metadata, queue state, and channel/session history survive restarts.",
    env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  };
}

function checkCronSecret(onVercel: boolean): DeploymentRequirement {
  const configured = Boolean(getCronSecret());

  if (configured) {
    return {
      id: CRON_SECRET_REQUIREMENT_ID,
      status: "pass",
      message: "CRON_SECRET is configured.",
      remediation: "",
      env: CRON_SECRET_ENV,
    };
  }

  if (onVercel) {
    return {
      id: CRON_SECRET_REQUIREMENT_ID,
      status: "fail",
      message: "CRON_SECRET is required on Vercel deployments.",
      remediation:
        "Set CRON_SECRET so deployed cron requests can authenticate before waking the sandbox.",
      env: CRON_SECRET_ENV,
    };
  }

  return {
    id: CRON_SECRET_REQUIREMENT_ID,
    status: "pass",
    message: "CRON_SECRET is optional outside Vercel deployments.",
    remediation: "",
    env: CRON_SECRET_ENV,
  };
}

function checkAiGateway(
  onVercel: boolean,
  aiGatewayAuth: "oidc" | "api-key" | "unavailable",
): DeploymentRequirement {
  if (aiGatewayAuth === "unavailable") {
    return {
      id: "ai-gateway",
      status: onVercel ? "fail" : "warn",
      message: onVercel
        ? "OIDC token is not available on this Vercel deployment."
        : "OIDC token is not available. Run `vercel link && vercel env pull` for local dev.",
      remediation: onVercel
        ? "Redeploy the project so the deployment receives its OIDC token."
        : "Run `vercel link && vercel env pull` to pull OIDC credentials for local development.",
      env: [],
    };
  }

  return {
    id: "ai-gateway",
    status: "pass",
    message: aiGatewayAuth === "oidc"
      ? "AI Gateway auth uses OIDC."
      : "AI Gateway auth uses a static API key.",
    remediation: "",
    env: [],
  };
}

function checkOpenclawPackageSpec(
  onVercel: boolean,
): DeploymentRequirement | null {
  if (!onVercel) return null;

  const spec = getOpenclawPackageSpec();

  if (isPinnedPackageSpec(spec)) {
    return {
      id: "openclaw-package-spec",
      status: "pass",
      message: `OPENCLAW_PACKAGE_SPEC is pinned to ${spec}.`,
      remediation: "",
      env: ["OPENCLAW_PACKAGE_SPEC"],
    };
  }

  const missing = !process.env.OPENCLAW_PACKAGE_SPEC?.trim();
  return {
    id: "openclaw-package-spec",
    status: "warn",
    message: missing
      ? "OPENCLAW_PACKAGE_SPEC is not set. Pin to a specific version for deterministic sandbox restores."
      : `OPENCLAW_PACKAGE_SPEC is set to "${spec}" which is not a pinned version. Restores are non-deterministic.`,
    remediation:
      'Set OPENCLAW_PACKAGE_SPEC to a pinned version like "openclaw@1.2.3" for deterministic sandbox restores.',
    env: ["OPENCLAW_PACKAGE_SPEC"],
  };
}

function checkOauthClientId(
  authMode: "admin-secret" | "sign-in-with-vercel",
): DeploymentRequirement | null {
  if (authMode !== "sign-in-with-vercel") return null;

  const clientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim();
  if (!clientId) {
    return {
      id: "oauth-client-id",
      status: "fail",
      message:
        "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID is required for sign-in-with-vercel auth mode.",
      remediation:
        "Set NEXT_PUBLIC_VERCEL_APP_CLIENT_ID to the OAuth application client ID and redeploy.",
      env: ["NEXT_PUBLIC_VERCEL_APP_CLIENT_ID"],
    };
  }

  return {
    id: "oauth-client-id",
    status: "pass",
    message: "OAuth client ID is configured.",
    remediation: "",
    env: ["NEXT_PUBLIC_VERCEL_APP_CLIENT_ID"],
  };
}

function checkOauthClientSecret(
  authMode: "admin-secret" | "sign-in-with-vercel",
): DeploymentRequirement | null {
  if (authMode !== "sign-in-with-vercel") return null;

  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    return {
      id: "oauth-client-secret",
      status: "fail",
      message:
        "VERCEL_APP_CLIENT_SECRET is required for sign-in-with-vercel auth mode.",
      remediation:
        "Set VERCEL_APP_CLIENT_SECRET to the OAuth application secret and redeploy.",
      env: ["VERCEL_APP_CLIENT_SECRET"],
    };
  }

  return {
    id: "oauth-client-secret",
    status: "pass",
    message: "OAuth client secret is configured.",
    remediation: "",
    env: ["VERCEL_APP_CLIENT_SECRET"],
  };
}

function checkSessionSecret(
  authMode: "admin-secret" | "sign-in-with-vercel",
  onVercel: boolean,
): DeploymentRequirement | null {
  if (authMode !== "sign-in-with-vercel") return null;
  if (!onVercel) return null;

  const explicit = process.env.SESSION_SECRET?.trim();
  if (!explicit) {
    return {
      id: "session-secret",
      status: "fail",
      message:
        "SESSION_SECRET is required for deployed sign-in-with-vercel mode.",
      remediation:
        "Set SESSION_SECRET to a random 32+ character string and redeploy. Do not rely on silent derivation from the Upstash token.",
      env: ["SESSION_SECRET"],
    };
  }

  return {
    id: "session-secret",
    status: "pass",
    message: "SESSION_SECRET is explicitly configured.",
    remediation: "",
    env: ["SESSION_SECRET"],
  };
}

// ---------------------------------------------------------------------------
// Contract builder
// ---------------------------------------------------------------------------

export async function buildDeploymentContract(
  options: BuildDeploymentContractOptions = {},
): Promise<DeploymentContract> {
  const onVercel = isVercelDeployment();
  const authMode = getAuthMode();
  const storeEnv = getStoreEnv();
  const storeBackend = storeEnv ? "upstash" : "memory";
  const aiGatewayAuth = await getAiGatewayAuthMode();
  const openclawPackageSpec = getOpenclawPackageSpec();

  const requirements = [
    checkPublicOrigin(onVercel, options.request),
    checkWebhookBypass(),
    checkStore(onVercel),
    checkCronSecret(onVercel),
    checkAiGateway(onVercel, aiGatewayAuth),
    checkOpenclawPackageSpec(onVercel),
    checkOauthClientId(authMode),
    checkOauthClientSecret(authMode),
    checkSessionSecret(authMode, onVercel),
  ].filter((value): value is DeploymentRequirement => value !== null);

  const ok = requirements.every((r) => r.status !== "fail");

  logDebug("deployment_contract.built", {
    ok,
    authMode,
    storeBackend,
    aiGatewayAuth,
    onVercel,
    requirementIds: requirements.map((r) => `${r.id}:${r.status}`),
  });

  return {
    ok,
    authMode,
    storeBackend,
    aiGatewayAuth,
    openclawPackageSpec,
    requirements,
  };
}
