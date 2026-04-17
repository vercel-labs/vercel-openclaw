import { createHash } from "node:crypto";

import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

import { resolveSessionSecret } from "@/server/auth/session-secret";

export const SESSION_COOKIE_NAME = "openclaw_session";
export const OAUTH_STATE_COOKIE_NAME = "vercel_oauth_state";
export const OAUTH_CONTEXT_COOKIE_NAME = "vercel_oauth_ctx";

export type SessionUser = {
  sub: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  user: SessionUser;
};

export type OAuthContext = {
  codeVerifier: string;
  nonce: string;
  next: string;
};

async function getEncryptionKey(): Promise<Uint8Array> {
  const secret = await resolveSessionSecret();
  return createHash("sha256").update(secret).digest();
}

export async function encryptPayload(
  payload: JWTPayload,
  expirationTime: string,
): Promise<string> {
  const key = await getEncryptionKey();
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .encrypt(key);
}

export async function decryptPayload<T extends JWTPayload>(
  token: string,
): Promise<T | null> {
  try {
    const key = await getEncryptionKey();
    const { payload } = await jwtDecrypt(token, key);
    return payload as T;
  } catch {
    return null;
  }
}

export async function serializeSessionCookie(
  session: AuthSession,
  secure: boolean,
): Promise<string> {
  const value = await encryptPayload(
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      user: session.user,
    },
    "7d",
  );
  return serializeCookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

export async function readSessionFromRequest(
  request: Request,
): Promise<AuthSession | null> {
  const raw = getCookieValue(request, SESSION_COOKIE_NAME);
  if (!raw) {
    return null;
  }

  const payload = await decryptPayload<{
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: number;
    user?: SessionUser;
  }>(raw);

  if (
    !payload?.accessToken ||
    typeof payload.expiresAt !== "number" ||
    !payload.user?.sub
  ) {
    return null;
  }

  return {
    accessToken: payload.accessToken,
    refreshToken:
      typeof payload.refreshToken === "string" ? payload.refreshToken : null,
    expiresAt: payload.expiresAt,
    user: payload.user,
  };
}

export async function serializeOAuthContextCookie(
  value: OAuthContext,
  secure: boolean,
): Promise<string> {
  const encrypted = await encryptPayload(
    {
      codeVerifier: value.codeVerifier,
      nonce: value.nonce,
      next: value.next,
    },
    "5m",
  );

  return serializeCookie(OAUTH_CONTEXT_COOKIE_NAME, encrypted, {
    httpOnly: true,
    maxAge: 5 * 60,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

export async function readOAuthContextFromRequest(
  request: Request,
): Promise<OAuthContext | null> {
  const raw = getCookieValue(request, OAUTH_CONTEXT_COOKIE_NAME);
  if (!raw) {
    return null;
  }

  const payload = await decryptPayload<{
    codeVerifier?: string;
    nonce?: string;
    next?: string;
  }>(raw);

  if (
    !payload?.codeVerifier ||
    !payload.nonce ||
    typeof payload.next !== "string"
  ) {
    return null;
  }

  return {
    codeVerifier: payload.codeVerifier,
    nonce: payload.nonce,
    next: payload.next,
  };
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

export function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }

  return new URL(request.url).protocol === "https:";
}

export function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const pieces = cookieHeader.split(";");
  for (const piece of pieces) {
    const [rawName, ...valueParts] = piece.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
