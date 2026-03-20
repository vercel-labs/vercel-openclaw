import { extractRequestId, logInfo } from "@/server/log";

export type DebugGuardContext = {
  routeSource?: string;
};

/**
 * Check whether debug routes are explicitly enabled.
 *
 * Only "1", "true", "yes", and "on" count as enabled.
 */
export function isDebugRoutesEnabled(
  raw: string | undefined = process.env.ENABLE_DEBUG_ROUTES,
): boolean {
  switch (raw?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

/**
 * Gate debug routes behind the ENABLE_DEBUG_ROUTES env var.
 * Returns a 404 response when disabled, or null to proceed.
 */
export function requireDebugEnabled(
  request?: Request,
  context: DebugGuardContext = {},
): Response | null {
  if (isDebugRoutesEnabled()) {
    return null;
  }

  const path = request ? new URL(request.url).pathname : undefined;
  const method = request?.method;
  const requestId = request ? extractRequestId(request) : undefined;

  logInfo("debug_guard.blocked", {
    code: "DEBUG_ROUTES_DISABLED",
    reason: "debug_routes_disabled",
    path,
    method,
    requestId,
    routeSource: context.routeSource ?? "debug-route",
  });

  return Response.json({ error: "Not found" }, { status: 404 });
}
