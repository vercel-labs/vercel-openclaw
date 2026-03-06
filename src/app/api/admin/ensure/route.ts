import { after } from "next/server";

import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { getBaseOrigin } from "@/server/env";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

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
}
