import { getVercelOidcToken } from "@vercel/oidc";
import {
  DEFAULT_OPENCLAW_INSTANCE_ID,
  INSTANCE_ID_OVERRIDE_GLOBAL_KEY,
  resolveOpenclawInstanceId,
} from "@/shared/types";
import { logWarn } from "@/server/log";

export type AuthMode = "admin-secret" | "sign-in-with-vercel";

export type AiGatewayCredentialSource = "oidc" | "api-key";

export type AiGatewayCredential = {
  token: string;
  source: AiGatewayCredentialSource;
  expiresAt: number | null;
};

export function getAuthMode(): AuthMode {
  return process.env.VERCEL_AUTH_MODE === "sign-in-with-vercel"
    ? "sign-in-with-vercel"
    : "admin-secret";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Session encryption key used for cookie encryption.
 * In production without an env var, a deterministic fallback derived from
 * UPSTASH_REDIS_REST_TOKEN is used so the key survives cold starts without
 * extra configuration. Local dev uses a static placeholder.
 */
export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }

  // Deployed sign-in-with-vercel mode requires an explicit session secret.
  // Do not silently derive from the Upstash token — the deployment contract
  // hard-fails this scenario, and runtime must agree.
  if (getAuthMode() === "sign-in-with-vercel" && isVercelDeployment()) {
    throw new Error(
      "SESSION_SECRET is required for deployed sign-in-with-vercel mode.",
    );
  }

  // Derive from the Upstash token for admin-secret mode or local dev.
  const upstashToken =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
    process.env.KV_REST_API_TOKEN?.trim();
  if (upstashToken) {
    return `openclaw-session-derived-${upstashToken}`;
  }

  if (isProduction()) {
    throw new Error(
      "SESSION_SECRET or UPSTASH_REDIS_REST_TOKEN is required in production.",
    );
  }

  return "openclaw-single-local-session-secret-change-me";
}

export function getOauthClientId(): string {
  const clientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("NEXT_PUBLIC_VERCEL_APP_CLIENT_ID is required.");
  }
  return clientId;
}

export function getOauthClientSecret(): string {
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error("VERCEL_APP_CLIENT_SECRET is required.");
  }
  return clientSecret;
}

export function getStoreEnv():
  | { url: string; token: string }
  | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL?.trim() ??
    process.env.KV_REST_API_URL?.trim() ??
    "";
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
    process.env.KV_REST_API_TOKEN?.trim() ??
    "";

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

let _instanceIdOverrideForTesting: string | null = null;

function readInstanceIdOverrideFromGlobal(): string | null | undefined {
  return (
    globalThis as typeof globalThis & {
      [INSTANCE_ID_OVERRIDE_GLOBAL_KEY]?: string | null;
    }
  )[INSTANCE_ID_OVERRIDE_GLOBAL_KEY];
}

export function getOpenclawInstanceId(): string {
  return resolveOpenclawInstanceId(
    _instanceIdOverrideForTesting ??
      readInstanceIdOverrideFromGlobal() ??
      process.env.OPENCLAW_INSTANCE_ID ??
      process.env.VERCEL_PROJECT_ID,
  );
}

export { DEFAULT_OPENCLAW_INSTANCE_ID };

export function _setInstanceIdOverrideForTesting(id: string | null): void {
  _instanceIdOverrideForTesting = id;
  (
    globalThis as typeof globalThis & {
      [INSTANCE_ID_OVERRIDE_GLOBAL_KEY]?: string | null;
    }
  )[INSTANCE_ID_OVERRIDE_GLOBAL_KEY] = id;
}

export type CronSecretSource = "cron-secret" | "admin-secret" | "missing";

export type CronSecretConfig = {
  value: string | null;
  source: CronSecretSource;
};

export function getCronSecretConfig(): CronSecretConfig {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    return { value: cronSecret, source: "cron-secret" };
  }
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (adminSecret) {
    return { value: adminSecret, source: "admin-secret" };
  }
  return { value: null, source: "missing" };
}

export function getCronSecret(): string | null {
  return getCronSecretConfig().value;
}

let _aiGatewayTokenOverride: string | undefined | null = null;

export function _setAiGatewayTokenOverrideForTesting(value: string | undefined | null): void {
  _aiGatewayTokenOverride = value;
}

let _aiGatewayCredentialOverride: AiGatewayCredential | null | undefined;

export function _setAiGatewayCredentialOverrideForTesting(cred: AiGatewayCredential | null): void {
  _aiGatewayCredentialOverride = cred === null ? undefined : cred;
}

/**
 * Decode the `exp` claim from a JWT without verification.
 * Returns the numeric Unix epoch seconds, or `null` on any parse error.
 */
export function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve an AI Gateway credential with source tracking and TTL info.
 *
 * Priority in tests:
 *  1. Explicit test overrides
 *  2. Static `AI_GATEWAY_API_KEY` env var
 *  3. Never fetch OIDC
 *
 * Priority on Vercel deployments:
 *  1. Vercel OIDC token (`@vercel/oidc`)
 *  2. Static `AI_GATEWAY_API_KEY` env var (fallback)
 *
 * Priority elsewhere:
 *  1. Static `AI_GATEWAY_API_KEY` env var
 *  2. Vercel OIDC token (when available, e.g. `vercel env pull`)
 *
 * Returns `null` or `undefined` when no credential is available.
 */
export async function resolveAiGatewayCredentialOptional(): Promise<AiGatewayCredential | null | undefined> {
  // Test credential override takes highest priority.
  if (_aiGatewayCredentialOverride !== undefined) {
    return _aiGatewayCredentialOverride;
  }

  // Legacy token override for existing tests.
  if (_aiGatewayTokenOverride !== null) {
    if (_aiGatewayTokenOverride === undefined) return null;
    return { token: _aiGatewayTokenOverride, source: "oidc", expiresAt: decodeJwtExp(_aiGatewayTokenOverride) };
  }

  // Skip real OIDC lookups in tests. Use the static key when provided.
  if (process.env.NODE_ENV === "test") {
    const staticKey = process.env.AI_GATEWAY_API_KEY?.trim();
    if (staticKey) {
      return { token: staticKey, source: "api-key", expiresAt: null };
    }
    return undefined;
  }

  const onVercel = isVercelDeployment();

  // On Vercel: try OIDC first.
  if (onVercel) {
    try {
      const oidcToken = await getVercelOidcToken();
      if (oidcToken) {
        return { token: oidcToken, source: "oidc", expiresAt: decodeJwtExp(oidcToken) };
      }
    } catch {
      // OIDC unavailable.
    }
  }

  // Static API key.
  const staticKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (staticKey) {
    return { token: staticKey, source: "api-key", expiresAt: null };
  }

  // Non-Vercel: try OIDC as fallback (e.g. `vercel env pull`).
  if (!onVercel) {
    try {
      const oidcToken = await getVercelOidcToken();
      if (oidcToken) {
        return { token: oidcToken, source: "oidc", expiresAt: decodeJwtExp(oidcToken) };
      }
    } catch {
      // OIDC unavailable.
    }
  }

  return null;
}

/**
 * Resolve an AI Gateway bearer token.
 *
 * Returns `undefined` when no credential is available.
 */
export async function getAiGatewayBearerTokenOptional(): Promise<string | undefined> {
  const cred = await resolveAiGatewayCredentialOptional();
  return cred?.token;
}

export function isVercelDeployment(): boolean {
  return Boolean(
    process.env.VERCEL?.trim() ||
      process.env.VERCEL_ENV?.trim() ||
      process.env.VERCEL_URL?.trim() ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(),
  );
}

/**
 * Single shared rule: durable store (Upstash) is required on Vercel deployments.
 * Consumed by both runtime (getStore) and preflight (store check).
 */
export function requiresDurableStore(): boolean {
  return isVercelDeployment();
}

/**
 * Resolve the openclaw npm package spec to install in the sandbox.
 *
 * Resolution order:
 * 1. `OPENCLAW_PACKAGE_SPEC` env var (e.g. "openclaw@1.2.3", "openclaw@latest")
 * 2. Falls back to a known-good pinned version when unset (all environments).
 *
 * The fallback is pinned rather than "openclaw@latest" because upstream
 * releases can ship broken dependencies (e.g. 2026.3.31 — see
 * openclaw/openclaw#59081).  On Vercel deployments the fallback is also
 * logged as a warning because it may drift from the intended version.
 */
const OPENCLAW_DEFAULT_PACKAGE_SPEC = "openclaw@2026.4.12";

export type OpenclawPackageSpecSource = "explicit" | "fallback";

export type OpenclawPackageSpecConfig = {
  value: string;
  source: OpenclawPackageSpecSource;
};

export function getOpenclawPackageSpecConfig(): OpenclawPackageSpecConfig {
  const explicit = process.env.OPENCLAW_PACKAGE_SPEC?.trim();
  if (explicit) {
    return { value: explicit, source: "explicit" };
  }
  if (isVercelDeployment()) {
    logWarn("env.openclaw_package_spec_fallback", {
      resolved: OPENCLAW_DEFAULT_PACKAGE_SPEC,
      reason: "OPENCLAW_PACKAGE_SPEC is not set on a Vercel deployment",
    });
  }
  return { value: OPENCLAW_DEFAULT_PACKAGE_SPEC, source: "fallback" };
}

export function getOpenclawPackageSpec(): string {
  return getOpenclawPackageSpecConfig().value;
}

export async function getAiGatewayAuthMode(): Promise<"oidc" | "api-key" | "unavailable"> {
  const cred = await resolveAiGatewayCredentialOptional();
  if (!cred) return "unavailable";
  return cred.source;
}
