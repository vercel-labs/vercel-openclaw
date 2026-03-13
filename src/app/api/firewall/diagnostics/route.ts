import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { getFirewallDiagnostics } from "@/server/firewall/state";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const diagnostics = await getFirewallDiagnostics();
  const response = Response.json(diagnostics);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
