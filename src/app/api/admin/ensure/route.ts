import { after } from "next/server";

import { requireMutationAuth } from "@/server/auth/route-auth";
import { getBaseOrigin } from "@/server/env";
import { extractRequestId, logError } from "@/server/log";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";
import { jsonError } from "@/shared/http";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const result = await ensureSandboxRunning({
      origin: getBaseOrigin(request),
      reason: "admin.ensure",
      schedule: after,
    });

    const response = Response.json(
      {
        state: result.state,
        status: result.meta.status,
        sandboxId: result.meta.sandboxId,
      },
      { status: result.state === "running" ? 200 : 202 },
    );
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (requestId) ctx.requestId = requestId;
    logError("admin.ensure_failed", ctx);
    return jsonError(error);
  }
}
