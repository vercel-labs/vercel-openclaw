import {
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { readWatchdogReport } from "@/server/watchdog/state";
import { runSandboxWatchdog } from "@/server/watchdog/run";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const report = await readWatchdogReport();
  return authJsonOk({ ok: true, report }, auth);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const report = await runSandboxWatchdog({ request });
  return authJsonOk({ ok: report.status !== "failed", report }, auth);
}
