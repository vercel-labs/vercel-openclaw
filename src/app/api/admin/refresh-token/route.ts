import { authJsonError, authJsonOk, requireMutationAuth } from "@/server/auth/route-auth";
import { extractRequestId, logInfo } from "@/server/log";
import { ensureFreshGatewayToken } from "@/server/sandbox/lifecycle";

/**
 * Force-refresh the AI Gateway OIDC token on the running sandbox by re-applying
 * the firewall network policy with a fresh Authorization-header transform rule.
 *
 * This is the operator escape hatch for the exact production failure mode where
 * the sandbox keeps running past the ~1h OIDC token TTL and every completion
 * returns HTTP 401 from ai-gateway.vercel.sh. It avoids a stop/restore cycle.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const result = await ensureFreshGatewayToken({ force: true });
    logInfo("admin.refresh_token", {
      refreshed: result.refreshed,
      reason: result.reason,
      source: result.credential?.source ?? null,
      expiresAt: result.credential?.expiresAt ?? null,
      requestId,
    });
    return authJsonOk(
      {
        refreshed: result.refreshed,
        reason: result.reason,
        source: result.credential?.source ?? null,
        expiresAt: result.credential?.expiresAt ?? null,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
