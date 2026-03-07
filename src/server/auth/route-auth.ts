import { jsonError, jsonOk } from "@/shared/http";
import { verifyCsrf } from "@/server/auth/csrf";
import { logWarn } from "@/server/log";
import { requireRouteAuth } from "@/server/auth/vercel-auth";

type RouteAuthResult = Exclude<Awaited<ReturnType<typeof requireRouteAuth>>, Response>;

/**
 * Require JSON-mode auth **and** CSRF verification for mutation methods.
 * Used by channel config and other JSON API routes.
 */
export async function requireJsonRouteAuth(
  request: Request,
): Promise<Response | RouteAuthResult> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) {
    logWarn("auth.csrf_blocked", { method: request.method, url: request.url });
    return csrfBlock;
  }

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  return auth;
}

/**
 * Require auth + CSRF for admin mutation routes that call requireRouteAuth
 * directly.  Returns a 403 Response for CSRF failures, delegates to
 * requireRouteAuth for auth failures.
 */
export async function requireMutationAuth(
  request: Request,
): Promise<Response | RouteAuthResult> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  return auth;
}

export function authJsonOk<T>(
  data: T,
  auth: { setCookieHeader: string | null },
  init?: ResponseInit,
): Response {
  const response = jsonOk(data, init);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export function authJsonError(
  error: unknown,
  auth: { setCookieHeader: string | null } | null = null,
  init?: ResponseInit,
): Response {
  const response = jsonError(error, init);
  if (auth?.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
