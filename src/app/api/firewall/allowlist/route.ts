import { jsonError } from "@/shared/http";
import { verifyCsrf } from "@/server/auth/csrf";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  approveDomains,
  removeDomains,
  syncFirewallPolicyIfRunning,
} from "@/server/firewall/state";

type DomainBody = {
  domains?: string[];
};

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = (await request.json()) as DomainBody;
    const firewall = await approveDomains(body.domains ?? []);
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

export async function DELETE(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = (await request.json()) as DomainBody;
    const firewall = await removeDomains(body.domains ?? []);
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
