import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { getCronSecret } from "@/server/env";
import { runSandboxWatchdog } from "@/server/watchdog/run";

function isAuthorized(request: Request): boolean {
  const configured = getCronSecret();
  if (!configured) {
    return process.env.NODE_ENV !== "production";
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const headerSecret = request.headers.get("x-cron-secret")?.trim() ?? "";

  return bearer === configured || headerSecret === configured;
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonError(new ApiError(401, "UNAUTHORIZED", "Unauthorized"));
  }

  const report = await runSandboxWatchdog({ request });
  return jsonOk({ ok: report.status !== "failed", report });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
