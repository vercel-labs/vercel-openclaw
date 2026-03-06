import { jsonError } from "@/shared/http";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  promoteLearnedDomainsToEnforcing,
  syncFirewallPolicyIfRunning,
} from "@/server/firewall/state";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const firewall = await promoteLearnedDomainsToEnforcing();
    const policy = await syncFirewallPolicyIfRunning();
    const response = Response.json({ firewall, policy });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
