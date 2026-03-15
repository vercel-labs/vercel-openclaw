import {
  authJsonError,
  authJsonOk,
  requireJsonRouteAuth,
} from "@/server/auth/route-auth";
import { buildDeployPreflight } from "@/server/deploy-preflight";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const payload = await buildDeployPreflight(request);
    return authJsonOk(payload, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
