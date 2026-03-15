import { getVercelOidcToken } from "@vercel/oidc";

export type AuthMode = "deployment-protection" | "sign-in-with-vercel";

export function getAuthMode(): AuthMode {
  return process.env.VERCEL_AUTH_MODE === "sign-in-with-vercel"
    ? "sign-in-with-vercel"
    : "deployment-protection";
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

  // Derive from the Upstash token — available on every Vercel deployment that
  // has the Upstash integration, so this is effectively zero-config.
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

export function getBaseOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    return new URL(configured).origin;
  }

  if (isProduction()) {
    throw new Error("NEXT_PUBLIC_APP_URL is required in production.");
  }

  return new URL(request.url).origin;
}

export function getCronSecret(): string | null {
  const secret = process.env.CRON_SECRET?.trim();
  return secret || null;
}

let _aiGatewayTokenOverride: string | undefined | null = null;

export function _setAiGatewayTokenOverrideForTesting(value: string | undefined | null): void {
  _aiGatewayTokenOverride = value;
}

/**
 * Resolve an AI Gateway bearer token using the OIDC-first strategy:
 *
 * 1. `VERCEL_OIDC_TOKEN` — automatically provided by Vercel at runtime when
 *    the project has OIDC federation enabled. Retrieved via `@vercel/oidc`.
 *    This is the preferred path on Vercel deployments.
 * 2. `AI_GATEWAY_API_KEY` — explicit static key fallback for local development
 *    or environments where OIDC is unavailable.
 *
 * Returns `undefined` when neither source yields a token.
 */
export async function getAiGatewayBearerTokenOptional(): Promise<string | undefined> {
  if (_aiGatewayTokenOverride !== null) {
    return _aiGatewayTokenOverride;
  }

  try {
    const oidcToken = await getVercelOidcToken();
    if (oidcToken) {
      return oidcToken;
    }
  } catch {
    // Fall through to explicit override/local-dev key.
  }

  const staticKey = process.env.AI_GATEWAY_API_KEY?.trim();
  return staticKey || undefined;
}
