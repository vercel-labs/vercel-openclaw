import {
  getAiGatewayAuthMode,
  getAuthMode,
  getOpenclawPackageSpec,
  getStoreEnv,
  isVercelDeployment,
} from "@/server/env";

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
  authMode: "deployment-protection" | "sign-in-with-vercel";
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  openclawPackageSpec: string | null;
  requirements: DeploymentRequirement[];
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

function checkOpenclawPackageSpec(
  onVercel: boolean,
): DeploymentRequirement | null {
  const spec = getOpenclawPackageSpec();

  if (!onVercel) {
    // Local dev — anything goes (including null, which resolves to @latest).
    return null;
  }

  if (!spec) {
    return {
      id: "openclaw-package-spec",
      status: "fail",
      message:
        "OPENCLAW_PACKAGE_SPEC is required on Vercel deployments.",
      remediation:
        "Set OPENCLAW_PACKAGE_SPEC to a pinned version such as openclaw@1.2.3 and redeploy.",
      env: ["OPENCLAW_PACKAGE_SPEC"],
    };
  }

  if (!isPinnedPackageSpec(spec)) {
    return {
      id: "openclaw-package-spec",
      status: "fail",
      message: `OPENCLAW_PACKAGE_SPEC must be a pinned version on Vercel (got "${spec}").`,
      remediation:
        "Set OPENCLAW_PACKAGE_SPEC to a pinned version such as openclaw@1.2.3 and redeploy.",
      env: ["OPENCLAW_PACKAGE_SPEC"],
    };
  }

  return {
    id: "openclaw-package-spec",
    status: "pass",
    message: `OPENCLAW_PACKAGE_SPEC is pinned to ${spec}.`,
    remediation: "",
    env: ["OPENCLAW_PACKAGE_SPEC"],
  };
}

function checkOauthClientId(
  authMode: "deployment-protection" | "sign-in-with-vercel",
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
  authMode: "deployment-protection" | "sign-in-with-vercel",
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
  authMode: "deployment-protection" | "sign-in-with-vercel",
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

export async function buildDeploymentContract(): Promise<DeploymentContract> {
  const onVercel = isVercelDeployment();
  const authMode = getAuthMode();
  const storeEnv = getStoreEnv();
  const storeBackend = storeEnv ? "upstash" : "memory";
  const aiGatewayAuth = await getAiGatewayAuthMode();
  const openclawPackageSpec = getOpenclawPackageSpec();

  const requirements: DeploymentRequirement[] = [];

  const checks = [
    checkOpenclawPackageSpec(onVercel),
    checkOauthClientId(authMode),
    checkOauthClientSecret(authMode),
    checkSessionSecret(authMode, onVercel),
  ];

  for (const check of checks) {
    if (check) {
      requirements.push(check);
    }
  }

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
