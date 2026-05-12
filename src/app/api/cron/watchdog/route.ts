import { timingSafeEqual } from "node:crypto";

import { after } from "next/server";
import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { getCronSecret } from "@/server/env";
import { runSandboxWatchdog } from "@/server/watchdog/run";

// Constant-time string comparison. Matches the pattern used by the other
// secret checks in the repo (admin-auth.ts, slack/install/route.ts,
// vercel-auth.ts, and the channel adapters): `===` would leak the secret
// byte-by-byte to a timing attacker since the cron secret is the same on
// every successful request.
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

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

  return (
    timingSafeStringEqual(bearer, configured) ||
    timingSafeStringEqual(headerSecret, configured)
  );
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonError(new ApiError(401, "UNAUTHORIZED", "Unauthorized"));
  }

  const report = await runSandboxWatchdog({ request, schedule: after });
  return jsonOk({ ok: report.status !== "failed", report });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
