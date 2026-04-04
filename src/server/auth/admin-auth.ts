import { timingSafeEqual } from "node:crypto";

import { logDebug, logWarn } from "@/server/log";
import { verifyCsrf } from "@/server/auth/csrf";
import {
  getCookieValue,
  decryptPayload,
  encryptPayload,
  serializeCookie,
  clearCookie,
} from "@/server/auth/session";
import { getConfiguredAdminSecret } from "@/server/auth/admin-secret";

export const ADMIN_SESSION_COOKIE_NAME = "openclaw_admin";

type AdminAuthResult = {
  authenticated: true;
  setCookieHeader: string | null;
};

type AdminSessionPayload = {
  admin: true;
  iat?: number;
};

type AdminCredentialKind = "bearer" | "session";

function unauthorizedResponse(): Response {
  return Response.json(
    { error: "UNAUTHORIZED", message: "Authentication required." },
    { status: 401 },
  );
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

async function readAdminSession(
  request: Request,
): Promise<AdminSessionPayload | null> {
  const raw = getCookieValue(request, ADMIN_SESSION_COOKIE_NAME);
  if (!raw) return null;

  const payload = await decryptPayload<AdminSessionPayload>(raw);
  if (!payload?.admin) return null;

  return payload;
}

/**
 * Resolve admin credentials from the request.
 *
 * Checks (in order):
 * 1. Bearer token — returns "bearer" on match, 401 on mismatch
 * 2. Session cookie — optionally enforces CSRF before decryption
 *
 * Returns the credential kind on success, or a Response on failure.
 */
async function resolveAdminCredential(
  request: Request,
  options: { requireCsrfForSession: boolean },
): Promise<AdminCredentialKind | Response> {
  const configured = await getConfiguredAdminSecret();
  if (!configured) {
    logWarn("auth.admin_secret_unavailable");
    return unauthorizedResponse();
  }

  // Bearer token path — no CSRF needed
  const bearerToken = extractBearerToken(request);
  if (bearerToken) {
    if (timingSafeStringEqual(bearerToken, configured.secret)) {
      return "bearer";
    }
    return unauthorizedResponse();
  }

  // Cookie path — check cookie presence before CSRF
  const hasSessionCookie =
    getCookieValue(request, ADMIN_SESSION_COOKIE_NAME) !== null;
  if (!hasSessionCookie) {
    if (options.requireCsrfForSession) {
      logDebug("auth.csrf_skipped_no_session_cookie", {
        method: request.method,
        url: request.url,
      });
    }
    return unauthorizedResponse();
  }

  // CSRF enforcement for cookie-based mutations
  if (options.requireCsrfForSession) {
    const csrfBlock = verifyCsrf(request);
    if (csrfBlock) {
      logWarn("auth.csrf_blocked", {
        method: request.method,
        url: request.url,
      });
      return csrfBlock;
    }
  }

  // Decrypt and validate the session
  const session = await readAdminSession(request);
  if (!session) {
    return unauthorizedResponse();
  }

  return "session";
}

function authSuccess(kind: AdminCredentialKind): AdminAuthResult {
  logDebug(
    kind === "bearer" ? "auth.admin_bearer_ok" : "auth.admin_session_ok",
  );
  return { authenticated: true, setCookieHeader: null };
}

/**
 * Check whether a request carries a valid admin session cookie.
 * Does not check bearer tokens — intended for SSR page rendering
 * where only cookies are available.
 */
export async function hasAdminSession(request: Request): Promise<boolean> {
  const session = await readAdminSession(request);
  return session !== null;
}

/**
 * Require admin authentication.
 *
 * Checks (in order):
 * 1. `Authorization: Bearer <admin-secret>` header
 * 2. Encrypted admin session cookie
 *
 * Returns an auth result on success, or a 401 Response on failure.
 */
export async function requireAdminAuth(
  request: Request,
): Promise<AdminAuthResult | Response> {
  const credential = await resolveAdminCredential(request, {
    requireCsrfForSession: false,
  });
  if (credential instanceof Response) {
    return credential;
  }
  return authSuccess(credential);
}

/**
 * Require admin auth with CSRF verification for mutation methods.
 * CSRF is only enforced for cookie-based sessions (browsers).
 * Bearer token requests skip CSRF since browsers don't auto-attach them.
 */
export async function requireAdminMutationAuth(
  request: Request,
): Promise<AdminAuthResult | Response> {
  const credential = await resolveAdminCredential(request, {
    requireCsrfForSession: true,
  });
  if (credential instanceof Response) {
    return credential;
  }
  return authSuccess(credential);
}

/**
 * Validate an admin secret and return a Set-Cookie header for the session.
 */
export async function loginWithAdminSecret(
  secret: string,
  secure: boolean,
): Promise<{ setCookieHeader: string } | null> {
  const configured = await getConfiguredAdminSecret();
  if (!configured) return null;

  if (!timingSafeStringEqual(secret, configured.secret)) {
    return null;
  }

  const token = await encryptPayload(
    { admin: true } as AdminSessionPayload,
    "7d",
  );
  const setCookieHeader = serializeCookie(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
    sameSite: "Lax",
    secure,
  });

  return { setCookieHeader };
}

/**
 * Build a Set-Cookie header that clears the admin session.
 */
export function clearAdminSession(secure: boolean): string {
  return clearCookie(ADMIN_SESSION_COOKIE_NAME, secure);
}
