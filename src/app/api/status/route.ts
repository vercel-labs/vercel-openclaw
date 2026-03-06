import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { getAuthMode } from "@/server/env";
import { ingestLearningFromSandbox } from "@/server/firewall/state";
import { probeGatewayReady, touchRunningSandbox } from "@/server/sandbox/lifecycle";
import { getStore, getInitializedMeta } from "@/server/store/store";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const includeHealth = url.searchParams.get("health") === "1";
  await ingestLearningFromSandbox();
  const meta = await getInitializedMeta();
  const gatewayReady =
    meta.status === "running"
      ? includeHealth
        ? await probeGatewayReady()
        : true
      : includeHealth
        ? await probeGatewayReady()
        : false;

  const response = Response.json({
    authMode: getAuthMode(),
    storeBackend: getStore().name,
    persistentStore: getStore().name !== "memory",
    status: meta.status,
    sandboxId: meta.sandboxId,
    snapshotId: meta.snapshotId,
    gatewayReady,
    gatewayUrl: "/gateway",
    lastError: meta.lastError,
    firewall: meta.firewall,
    user: auth.session.user,
  });

  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await touchRunningSandbox();
  const response = Response.json({
    ok: true,
    status: meta.status,
  });
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
