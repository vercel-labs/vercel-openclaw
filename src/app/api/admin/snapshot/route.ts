import { jsonError } from "@/shared/http";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { snapshotSandbox } from "@/server/sandbox/lifecycle";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await snapshotSandbox();
    const response = Response.json({
      status: meta.status,
      snapshotId: meta.snapshotId,
    });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
