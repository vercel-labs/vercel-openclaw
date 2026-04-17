import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { requireAdminAuth, requireAdminMutationAuth } from "@/server/auth/admin-auth";

type AdminAuthResult = Exclude<
  Awaited<ReturnType<typeof requireAdminAuth>>,
  Response
>;

/**
 * Opt-in local safety switch: when LOCAL_READ_ONLY=1, block every mutation
 * route at the auth boundary. Intended for "pnpm dev against prod env"
 * sessions where the operator wants to tweak UI without risking accidental
 * sandbox stop / reset / snapshot delete / channel re-register against prod.
 */
function localReadOnlyBlocked(): Response | null {
  if (process.env.LOCAL_READ_ONLY?.trim() !== "1") {
    return null;
  }
  return jsonError(
    new ApiError(
      403,
      "LOCAL_READ_ONLY",
      "Mutations are disabled because LOCAL_READ_ONLY=1 is set. Unset it to allow writes.",
    ),
  );
}

/**
 * Require admin auth for JSON API routes.
 * For mutations (POST/PUT/DELETE), also enforces CSRF for cookie sessions.
 */
export async function requireJsonRouteAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  const method = request.method.toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  if (isMutation) {
    const blocked = localReadOnlyBlocked();
    if (blocked) return blocked;
    return requireAdminMutationAuth(request);
  }

  return requireAdminAuth(request);
}

/**
 * Require admin auth + CSRF for mutation routes.
 */
export async function requireMutationAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  const blocked = localReadOnlyBlocked();
  if (blocked) return blocked;
  return requireAdminMutationAuth(request);
}

export function authJsonOk<T>(
  data: T,
  auth: { setCookieHeader: string | null } | null,
  init?: ResponseInit,
): Response {
  const response = jsonOk(data, init);
  if (auth?.setCookieHeader) {
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
