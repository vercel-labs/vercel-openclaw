import { jsonError } from "@/shared/http";
import { verifyCsrf } from "@/server/auth/csrf";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { dismissLearnedDomains } from "@/server/firewall/state";
import { extractRequestId } from "@/server/log";

type DomainBody = {
  domains?: string[];
};

export async function DELETE(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const body = (await request.json()) as DomainBody;
    const firewall = await dismissLearnedDomains(body.domains ?? [], { requestId });
    const response = Response.json({ firewall });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
