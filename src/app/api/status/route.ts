import { requireRouteAuth } from "@/server/auth/vercel-auth";
import { verifyCsrf } from "@/server/auth/csrf";
import { getPublicChannelState } from "@/server/channels/state";
import { getAuthMode } from "@/server/env";
import { ingestLearningFromSandbox } from "@/server/firewall/state";
import { extractRequestId, logError } from "@/server/log";
import { probeGatewayReady, touchRunningSandbox } from "@/server/sandbox/lifecycle";
import { getStore, getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
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
      channels: await getPublicChannelState(request, meta),
      user: auth.session.user,
    });

    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (requestId) ctx.requestId = requestId;
    logError("status.get_failed", ctx);
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = verifyCsrf(request);
  if (csrfBlock) return csrfBlock;

  const auth = await requireRouteAuth(request, { mode: "json" });
  if (auth instanceof Response) {
    return auth;
  }

  const heartbeatRequestId = extractRequestId(request);

  try {
    const meta = await touchRunningSandbox();
    const response = Response.json({
      ok: true,
      status: meta.status,
    });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (heartbeatRequestId) ctx.requestId = heartbeatRequestId;
    logError("status.heartbeat_failed", ctx);
    return jsonError(error);
  }
}
