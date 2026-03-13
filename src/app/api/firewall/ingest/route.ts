import { authJsonError, authJsonOk, requireMutationAuth } from "@/server/auth/route-auth";
import { getFirewallDiagnostics, ingestLearningFromSandbox } from "@/server/firewall/state";
import { extractRequestId } from "@/server/log";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const result = await ingestLearningFromSandbox(false, { requestId });
    const diagnostics = await getFirewallDiagnostics();
    return authJsonOk({ result, diagnostics }, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
