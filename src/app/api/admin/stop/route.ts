import { jsonError } from "@/shared/http";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { stopSandbox } from "@/server/sandbox/lifecycle";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await stopSandbox();
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
