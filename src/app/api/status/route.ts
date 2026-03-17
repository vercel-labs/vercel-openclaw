import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getPublicChannelState, buildTelegramWebhookUrl } from "@/server/channels/state";
import { setWebhook } from "@/server/channels/telegram/bot-api";
import { getAuthMode } from "@/server/env";
import { computeWouldBlock } from "@/server/firewall/state";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { probeGatewayReady, touchRunningSandbox } from "@/server/sandbox/lifecycle";
import { getStore, getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

const TELEGRAM_WEBHOOK_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let lastTelegramWebhookReconcileAt = 0;

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const url = new URL(request.url);
    const includeHealth = url.searchParams.get("health") === "1";
    const meta = await getInitializedMeta();
    const gatewayReady =
      meta.status === "running"
        ? includeHealth
          ? (await probeGatewayReady()).ready
          : true
        : includeHealth
          ? (await probeGatewayReady()).ready
          : false;

    // Re-register Telegram webhook periodically so Telegram resumes
    // delivery after errors (deployments, OIDC expiry, etc.).
    // Fire-and-forget — don't block the status response.
    const now = Date.now();
    if (
      meta.channels.telegram &&
      now - lastTelegramWebhookReconcileAt > TELEGRAM_WEBHOOK_RECONCILE_INTERVAL_MS
    ) {
      lastTelegramWebhookReconcileAt = now;
      const tg = meta.channels.telegram;
      void (async () => {
        try {
          const webhookUrl = buildTelegramWebhookUrl(request);
          await setWebhook(tg.botToken, webhookUrl, tg.webhookSecret);
          logInfo("status.telegram_webhook_reconciled", {});
        } catch (err) {
          logWarn("status.telegram_webhook_reconcile_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

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
      firewall: { ...meta.firewall, wouldBlock: computeWouldBlock(meta.firewall) },
      channels: await getPublicChannelState(request, meta),
      user: { sub: "admin", name: "Admin" },
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
  const auth = await requireJsonRouteAuth(request);
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
