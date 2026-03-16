/**
 * Auth fixture helpers for tests.
 *
 * Provides pre-built auth artifacts so route-level tests can exercise
 * authenticated paths without real OAuth flows or admin secret setup.
 */

import {
  serializeSessionCookie,
  type AuthSession,
  type SessionUser,
} from "@/server/auth/session";

// ---------------------------------------------------------------------------
// Admin auth constants (used by the harness)
// ---------------------------------------------------------------------------

/** Fixed admin secret used in all test scenarios. */
export const TEST_ADMIN_SECRET = "test-admin-secret-for-scenarios";

/** Fixed session secret used in all test scenarios. */
export const TEST_SESSION_SECRET = "test-session-secret-for-smoke-tests";

// ---------------------------------------------------------------------------
// Defaults for sign-in-with-vercel (optional login method)
// ---------------------------------------------------------------------------

const DEFAULT_USER: SessionUser = {
  sub: "test-user-123",
  email: "dev@example.com",
  name: "Test User",
  preferredUsername: "testuser",
};

const DEFAULT_CLIENT_ID = "oac_test_client_id";
const DEFAULT_CLIENT_SECRET = "test_client_secret";

// ---------------------------------------------------------------------------
// Admin auth helpers
// ---------------------------------------------------------------------------

/**
 * Return headers that authenticate as admin via bearer token.
 * Includes CSRF headers for mutation safety.
 */
export function buildAdminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_ADMIN_SECRET}`,
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
  };
}

/**
 * Return just the bearer token header for admin auth.
 */
export function buildAdminBearerHeader(): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_ADMIN_SECRET}`,
  };
}

// ---------------------------------------------------------------------------
// sign-in-with-vercel helpers (for testing the optional OAuth flow)
// ---------------------------------------------------------------------------

export type SessionCookieOptions = {
  user?: Partial<SessionUser>;
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number;
};

export async function buildSessionCookie(
  options?: SessionCookieOptions,
): Promise<string> {
  const user: SessionUser = { ...DEFAULT_USER, ...options?.user };
  const session: AuthSession = {
    accessToken: options?.accessToken ?? "test-access-token",
    refreshToken: options?.refreshToken ?? "test-refresh-token",
    expiresAt: options?.expiresAt ?? Date.now() + 60 * 60 * 1000,
    user,
  };
  return serializeSessionCookie(session, false);
}

export function setCookieToCookieHeader(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

// ---------------------------------------------------------------------------
// Admin-secret helpers (default auth mode)
// ---------------------------------------------------------------------------

export function buildDeploymentProtectionHeaders(): Record<string, string> {
  return {
    "x-vercel-protection-bypass": "true",
    "x-forwarded-proto": "https",
  };
}

// ---------------------------------------------------------------------------
// Environment variable presets
// ---------------------------------------------------------------------------

/** Env overrides for sign-in-with-vercel mode. */
export const SIGN_IN_ENV: Record<string, string> = {
  VERCEL_AUTH_MODE: "sign-in-with-vercel",
  SESSION_SECRET: TEST_SESSION_SECRET,
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: DEFAULT_CLIENT_ID,
  VERCEL_APP_CLIENT_SECRET: DEFAULT_CLIENT_SECRET,
  ADMIN_SECRET: TEST_ADMIN_SECRET,
};

/** Env overrides for the default admin-secret auth mode. */
export const ADMIN_SECRET_ENV: Record<string, string | undefined> = {
  VERCEL_AUTH_MODE: undefined,
  SESSION_SECRET: TEST_SESSION_SECRET,
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: undefined,
  VERCEL_APP_CLIENT_SECRET: undefined,
  ADMIN_SECRET: TEST_ADMIN_SECRET,
};

/** @deprecated Use ADMIN_SECRET_ENV instead. */
export const DEPLOYMENT_PROTECTION_ENV = ADMIN_SECRET_ENV;
