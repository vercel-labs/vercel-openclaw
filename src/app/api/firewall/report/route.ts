import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { getFirewallReport } from "@/server/firewall/state";
import { extractRequestId, logInfo } from "@/server/log";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);
  const report = await getFirewallReport();
  logInfo("firewall.report_generated", {
    operation: "report",
    policyHash: report.policyHash,
    mode: report.state.mode,
    allowlistCount: report.state.allowlist.length,
    learnedCount: report.state.learned.length,
    wouldBlockCount: report.wouldBlock.length,
    requestId,
  });
  const response = Response.json(report);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
