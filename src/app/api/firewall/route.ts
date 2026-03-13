import { ApiError, jsonError } from "@/shared/http";
import { isFirewallMode } from "@/shared/types";
import { verifyCsrf } from "@/server/auth/csrf";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  getFirewallState,
  setFirewallMode,
} from "@/server/firewall/state";
import { extractRequestId } from "@/server/log";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const firewall = await getFirewallState();
  const response = Response.json(firewall);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export async function PUT(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const body = (await request.json()) as { mode?: unknown };
    if (!isFirewallMode(body.mode)) {
      throw new ApiError(400, "INVALID_MODE", "Invalid firewall mode.");
    }

    const firewall = await setFirewallMode(body.mode, { requestId });
    const response = Response.json({ firewall });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
