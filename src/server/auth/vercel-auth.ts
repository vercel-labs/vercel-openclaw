import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { ApiError } from "@/shared/http";
import {
  getAuthMode,
  getBaseOrigin,
  getOauthClientId,
  getOauthClientSecret,
} from "@/server/env";
import { logInfo, logWarn } from "@/server/log";

/**
 * In production, deployment-protection mode is only allowed if the deployer
 * explicitly opts in via ALLOW_PLATFORM_ONLY_AUTH=true.  Without it the app
 * refuses to serve authenticated routes, because Vercel's platform-level
 * protection may be absent or misconfigured on forked deploys.
 */
let _productionAuthChecked = false;
function assertProductionAuthSafe(): void {
  if (_productionAuthChecked) return;

  // Skip during next build (prerendering phase)
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  const isProd =
    process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  if (!isProd) {
    _productionAuthChecked = true;
    return;
  }

  if (getAuthMode() === "deployment-protection") {
    if (process.env.ALLOW_PLATFORM_ONLY_AUTH !== "true") {
      throw new Error(
        "deployment-protection auth mode is unsafe for production. " +
          "Either set VERCEL_AUTH_MODE=sign-in-with-vercel (recommended), " +
          "or set ALLOW_PLATFORM_ONLY_AUTH=true if Vercel Deployment Protection " +
          "is confirmed active on this project.",
      );
    }
    logWarn("auth.platform_only", {
      message:
        "Running with deployment-protection auth. " +
        "This relies entirely on Vercel's platform-level protection. " +
        "Ensure Deployment Protection is enabled in your project settings.",
    });
  }

  _productionAuthChecked = true;
}

/** Reset for testing only. */
export function _resetProductionAuthCheck(): void {
  _productionAuthChecked = false;
}
import {
  AuthSession,
  clearCookie,
  getCookieValue,
  isSecureRequest,
  OAUTH_CONTEXT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthContextFromRequest,
  readSessionFromRequest,
  SESSION_COOKIE_NAME,
  serializeCookie,
  serializeOAuthContextCookie,
  serializeSessionCookie,
} from "@/server/auth/session";

const AUTHORIZATION_ENDPOINT = "https://vercel.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.vercel.com/v2/oauth2/token";
const ISSUER = "https://vercel.com";
const JWKS = createRemoteJWKSet(new URL("https://vercel.com/.well-known/jwks"));
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30_000;

type AuthCheckResult = {
  session: AuthSession;
  setCookieHeader: string | null;
};

const refreshPromises = new Map<string, Promise<AuthSession | null>>();

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
};

type IdTokenClaims = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  nonce?: string;
};

export async function requireRouteAuth(
  request: Request,
  options?: { mode?: "redirect" | "json" },
): Promise<AuthCheckResult | Response> {
  assertProductionAuthSafe();
  logInfo("auth.check", { mode: getAuthMode(), responseMode: options?.mode ?? "redirect" });

  if (getAuthMode() === "deployment-protection") {
    return {
      session: {
        accessToken: "",
        refreshToken: null,
        expiresAt: Date.now() + 60_000,
        user: {
          sub: "deployment-protection",
          name: "Protected by Vercel Authentication",
        },
      },
      setCookieHeader: null,
    };
  }

  const session = await readSessionFromRequest(request);
  if (!session) {
    return buildUnauthenticatedResponse(request, options?.mode ?? "redirect");
  }

  if (session.expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return {
      session,
      setCookieHeader: null,
    };
  }

  logInfo("auth.token_refresh", { sub: session.user.sub });
  const refreshed = await refreshAuthSession(session);
  if (!refreshed) {
    const unauthorized = buildUnauthenticatedResponse(
      request,
      options?.mode ?? "redirect",
    );
    unauthorized.headers.append(
      "Set-Cookie",
      clearCookie(SESSION_COOKIE_NAME, isSecureRequest(request)),
    );
    return unauthorized;
  }

  return {
    session: refreshed,
    setCookieHeader: await serializeSessionCookie(
      refreshed,
      isSecureRequest(request),
    ),
  };
}

export async function buildAuthorizeResponse(request: Request): Promise<Response> {
  if (getAuthMode() !== "sign-in-with-vercel") {
    return Response.redirect(new URL("/admin", request.url), 302);
  }

  const nextUrl = new URL(request.url);
  const next = sanitizeNextPath(nextUrl.searchParams.get("next"));
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = sha256Base64Url(codeVerifier);
  const redirectUri = `${getBaseOrigin(request)}/api/auth/callback`;

  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", getOauthClientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  const secure = isSecureRequest(request);
  const response = Response.redirect(url, 302);
  response.headers.append(
    "Set-Cookie",
    serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      maxAge: 5 * 60,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
  );
  response.headers.append(
    "Set-Cookie",
    await serializeOAuthContextCookie(
      {
        codeVerifier,
        nonce,
        next,
      },
      secure,
    ),
  );
  return response;
}

export async function buildCallbackResponse(request: Request): Promise<Response> {
  if (getAuthMode() !== "sign-in-with-vercel") {
    return Response.redirect(new URL("/admin", request.url), 302);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const stateCookie = getCookieValue(request, OAUTH_STATE_COOKIE_NAME);
  const secure = isSecureRequest(request);

  if (!code) {
    throw new ApiError(400, "OAUTH_CODE_MISSING", "Authorization code missing.");
  }

  if (!state || !stateCookie || !timingSafeStringEqual(state, stateCookie)) {
    throw new ApiError(403, "OAUTH_STATE_INVALID", "OAuth state validation failed.");
  }

  const oauthContext = await readOAuthContextFromRequest(request);
  if (!oauthContext) {
    throw new ApiError(
      400,
      "OAUTH_CONTEXT_MISSING",
      "OAuth verifier context is missing or expired.",
    );
  }

  const tokenResponse = await exchangeToken({
    grantType: "authorization_code",
    code,
    codeVerifier: oauthContext.codeVerifier,
    redirectUri: `${getBaseOrigin(request)}/api/auth/callback`,
  });
  const session = await buildSessionFromTokenResponse(
    tokenResponse,
    oauthContext.nonce,
  );
  logInfo("auth.session_created", { sub: session.user.sub });

  const response = Response.redirect(
    new URL(oauthContext.next || "/admin", request.url),
    302,
  );
  response.headers.append(
    "Set-Cookie",
    clearCookie(OAUTH_STATE_COOKIE_NAME, secure),
  );
  response.headers.append(
    "Set-Cookie",
    clearCookie(OAUTH_CONTEXT_COOKIE_NAME, secure),
  );
  response.headers.append(
    "Set-Cookie",
    await serializeSessionCookie(session, secure),
  );
  return response;
}

export async function buildSignoutResponse(request: Request): Promise<Response> {
  logInfo("auth.session_destroyed");
  const response = Response.redirect(new URL("/", request.url), 302);
  const secure = isSecureRequest(request);
  response.headers.append("Set-Cookie", clearCookie(SESSION_COOKIE_NAME, secure));
  response.headers.append(
    "Set-Cookie",
    clearCookie(OAUTH_STATE_COOKIE_NAME, secure),
  );
  response.headers.append(
    "Set-Cookie",
    clearCookie(OAUTH_CONTEXT_COOKIE_NAME, secure),
  );
  return response;
}

async function refreshAuthSession(
  session: AuthSession,
): Promise<AuthSession | null> {
  if (!session.refreshToken) {
    return null;
  }

  const key = session.user.sub;
  const existing = refreshPromises.get(key);
  if (existing) {
    return existing;
  }

  const promise = doRefreshAuthSession(session).finally(() => {
    refreshPromises.delete(key);
  });
  refreshPromises.set(key, promise);

  return promise;
}

async function doRefreshAuthSession(
  session: AuthSession,
): Promise<AuthSession | null> {
  const refreshToken = session.refreshToken;
  if (!refreshToken) {
    return null;
  }

  try {
    const tokenResponse = await exchangeToken({
      grantType: "refresh_token",
      refreshToken,
    });
    const next = await buildSessionFromTokenResponse(tokenResponse, undefined, session);
    return next;
  } catch (error) {
    logWarn("auth.refresh_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function exchangeToken(
  input:
    | {
        grantType: "authorization_code";
        code: string;
        codeVerifier: string;
        redirectUri: string;
      }
    | {
        grantType: "refresh_token";
        refreshToken: string;
      },
): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set("client_id", getOauthClientId());
  body.set("client_secret", getOauthClientSecret());

  if (input.grantType === "authorization_code") {
    body.set("grant_type", "authorization_code");
    body.set("code", input.code);
    body.set("redirect_uri", input.redirectUri);
    body.set("code_verifier", input.codeVerifier);
  } else {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", input.refreshToken);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Token exchange failed with status ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as TokenResponse;
}

async function buildSessionFromTokenResponse(
  tokenResponse: TokenResponse,
  expectedNonce?: string,
  previous?: AuthSession,
): Promise<AuthSession> {
  let user = previous?.user;
  if (tokenResponse.id_token) {
    user = await verifyIdToken(tokenResponse.id_token, expectedNonce);
  }

  if (!user) {
    throw new Error("Token response did not include a verifiable id_token.");
  }

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    user,
  };
}

async function verifyIdToken(
  idToken: string,
  expectedNonce?: string,
): Promise<AuthSession["user"]> {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ISSUER,
    audience: getOauthClientId(),
  });

  const claims = payload as IdTokenClaims;
  if (!claims.sub) {
    throw new Error("Verified ID token is missing sub.");
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new Error("Verified ID token nonce did not match.");
  }

  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    preferredUsername: claims.preferred_username,
  };
}

function buildUnauthenticatedResponse(
  request: Request,
  mode: "redirect" | "json",
): Response {
  if (mode === "json") {
    const authorizeUrl = `/api/auth/authorize?next=${encodeURIComponent(
      new URL(request.url).pathname,
    )}`;
    return Response.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required.",
        authorizeUrl,
      },
      { status: 401 },
    );
  }

  const next = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  const redirectUrl = new URL("/api/auth/authorize", request.url);
  redirectUrl.searchParams.set("next", next);
  return Response.redirect(redirectUrl, 302);
}

export function sanitizeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/")) {
    return "/admin";
  }

  // Reject protocol-relative paths and backslash variants (open redirect)
  // Check both raw and percent-decoded forms
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return "/admin";
  }

  if (
    /^\/[/\\]/.test(next) ||
    /^\/[/\\]/.test(decoded) ||
    // Reject paths with control characters
    /[\x00-\x1f]/.test(decoded)
  ) {
    return "/admin";
  }

  return next;
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
