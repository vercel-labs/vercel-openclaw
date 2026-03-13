import { jsonError } from "@/shared/http";
import { verifyCsrf } from "@/server/auth/csrf";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  promoteLearnedDomainsToEnforcing,
} from "@/server/firewall/state";
import { extractRequestId, logInfo } from "@/server/log";

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    logInfo("firewall.promote_requested", { operation: "promote", requestId });
    const firewall = await promoteLearnedDomainsToEnforcing({ requestId });
    const response = Response.json({ firewall });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
