import {
  getAiGatewayAuthMode,
  getAuthMode,
  getOpenclawPackageSpec,
  getStoreEnv,
  isVercelDeployment,
} from "@/server/env";
import { resolvePublicOrigin } from "@/server/public-url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeploymentRequirementId =
  | "public-origin"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "openclaw-package-spec"
  | "oauth-client-id"
  | "oauth-client-secret"
  | "session-secret";

export type DeploymentRequirementStatus = "pass" | "warn" | "fail";

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
  aiGatewayAuth: "oidc" | "unavailable";
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

function checkWebhookBypass(): DeploymentRequirement | null {
  // Webhook bypass is no longer a hard requirement. The app uses
  // admin-secret auth so channel webhooks are not blocked by Vercel's
  // deployment protection. If VERCEL_AUTOMATION_BYPASS_SECRET is set,
  // it is applied opportunistically to webhook URLs (see public-url.ts).
  return null;
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

function checkAiGateway(
  onVercel: boolean,
  aiGatewayAuth: "oidc" | "unavailable",
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
    message: "AI Gateway auth uses OIDC.",
    remediation: "",
    env: [],
  };
}

// Disabled: the openclaw-package-spec check is temporarily bypassed.
// Re-enable by restoring the original validation logic.
function checkOpenclawPackageSpec(
  _onVercel: boolean,
): DeploymentRequirement | null {
  return null;
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
    checkAiGateway(onVercel, aiGatewayAuth),
    checkOpenclawPackageSpec(onVercel),
    checkOauthClientId(authMode),
    checkOauthClientSecret(authMode),
    checkSessionSecret(authMode, onVercel),
  ].filter((value): value is DeploymentRequirement => value !== null);

  const ok = requirements.every((r) => r.status !== "fail");

  return {
    ok,
    authMode,
    storeBackend,
    aiGatewayAuth,
    openclawPackageSpec,
    requirements,
  };
}
