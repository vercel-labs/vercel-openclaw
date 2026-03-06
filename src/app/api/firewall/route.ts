import { jsonError } from "@/shared/http";
import { isFirewallMode } from "@/shared/types";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  getFirewallState,
  ingestLearningFromSandbox,
  setFirewallMode,
  syncFirewallPolicyIfRunning,
} from "@/server/firewall/state";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  await ingestLearningFromSandbox();
  const firewall = await getFirewallState();
  const response = Response.json(firewall);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = (await request.json()) as { mode?: unknown };
    if (!isFirewallMode(body.mode)) {
      throw new Error("Invalid firewall mode.");
    }

    const firewall = await setFirewallMode(body.mode);
    const policy = await syncFirewallPolicyIfRunning();
    const response = Response.json({
      firewall,
      policy,
    });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
