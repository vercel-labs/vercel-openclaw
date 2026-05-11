import { getPublicOrigin } from "@/server/public-url";
import { logWarn } from "@/server/log";

/**
 * Verify that a state-changing request originated from this application.
 *
 * Checks (in order):
 * 1. If the `Origin` header is present it must match the deployment host.
 * 2. Otherwise the request must include `X-Requested-With: XMLHttpRequest`
 *    (a custom header that browsers block on cross-origin form posts).
 *
 * GET and HEAD requests are exempt — CSRF only targets mutations.
 *
 * Returns `null` when the check passes, or a 403 `Response` to return to
 * the caller.
 */
export function verifyCsrf(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return null;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const originNormalized = normalizeOrigin(origin);
    const requestOrigin = new URL(request.url).origin;
    const publicOrigin = getPublicOrigin(request);
    const allowedOrigins = new Set([
      normalizeOrigin(requestOrigin),
      normalizeOrigin(publicOrigin),
    ]);

    if (allowedOrigins.has(originNormalized)) {
      return null;
    }

    logWarn("auth.csrf_origin_mismatch", {
      method: request.method,
      url: request.url,
      origin: originNormalized,
      requestOrigin: normalizeOrigin(requestOrigin),
      publicOrigin: normalizeOrigin(publicOrigin),
    });

    return Response.json(
      { error: "CSRF_ORIGIN_MISMATCH", message: "Cross-origin request blocked." },
      { status: 403 },
    );
  }

  // No Origin header — fall back to custom-header check.
  // Browsers never send custom headers cross-origin without a preflight that
  // the server would deny (no CORS configured), so requiring this header is
  // sufficient.
  if (request.headers.get("x-requested-with") === "XMLHttpRequest") {
    return null;
  }

  return Response.json(
    { error: "CSRF_HEADER_MISSING", message: "Missing Origin or X-Requested-With header." },
    { status: 403 },
  );
}

function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    // If it's already just an origin string (scheme://host[:port])
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}
