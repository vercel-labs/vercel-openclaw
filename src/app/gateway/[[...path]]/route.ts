import { after } from "next/server";

import { requireAdminAuth } from "@/server/auth/admin-auth";
import { getPublicOrigin } from "@/server/public-url";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { injectWrapperScript } from "@/server/proxy/htmlInjection";
import { buildGatewayPendingResponse } from "@/server/proxy/pending-response";
import {
  buildSafeProxyHeaders,
  buildSandboxTargetUrl,
  buildTokenHtmlHeaders,
  isInvalidProxyTargetPath,
  normalizeProxyTargetPath,
  sanitizeProxyQueryParams,
  stripProxyResponseHeaders,
} from "@/server/proxy/proxy-route-utils";
import {
  ensureFreshGatewayToken,
  ensureSandboxRunning,
  getSandboxDomain,
  reconcileSandboxHealth,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";

export const maxDuration = 300;

const NO_BODY_RESPONSE_STATUSES = new Set([204, 304]);

type Params = Promise<{ path?: string[] }>;

function buildTargetPath(path?: string[]): string {
  return normalizeProxyTargetPath(`/${path?.join("/") ?? ""}`);
}

function withSetCookie(response: Response, setCookieHeader: string | null): Response {
  if (setCookieHeader) {
    response.headers.append("Set-Cookie", setCookieHeader);
  }
  return response;
}

async function handleProxy(request: Request, path: string): Promise<Response> {
  const requestId = extractRequestId(request);
  const reqCtx: Record<string, unknown> = { path, method: request.method };
  if (requestId) reqCtx.requestId = requestId;

  if (isInvalidProxyTargetPath(path)) {
    logWarn("gateway.invalid_path", reqCtx);
    return new Response("Invalid path", { status: 400 });
  }

  const auth = await requireAdminAuth(request);
  if (auth instanceof Response) {
    logWarn("gateway.auth_failure", { ...reqCtx, status: auth.status });
    return auth;
  }

  const ensure = await ensureSandboxRunning({
    origin: getPublicOrigin(request),
    reason: "gateway.request",
    schedule: after,
  });
  const returnPath = `/gateway${path === "/" ? "" : path}`;

  if (ensure.state !== "running") {
    logInfo("gateway.pending", { ...reqCtx, sandboxStatus: ensure.meta.status });
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: ensure.meta.status,
      setCookieHeader: auth.setCookieHeader,
    });
  }

  // Proactively refresh the OIDC token if stale (throttled to every 5 min).
  await ensureFreshGatewayToken();

  const meta = await touchRunningSandbox();
  if (!meta.sandboxId || !meta.gatewayToken) {
    logWarn("gateway.missing_credentials", {
      ...reqCtx,
      sandboxStatus: meta.status,
      hasSandboxId: Boolean(meta.sandboxId),
      hasGatewayToken: Boolean(meta.gatewayToken),
    });
    // Trigger restore in background so the waiting page has something
    // to poll for (touchRunningSandbox may have just marked the sandbox
    // unavailable after detecting it was auto-suspended).
    const reEnsure = await ensureSandboxRunning({
      origin: getPublicOrigin(request),
      reason: "gateway.sandbox_lost_after_touch",
      schedule: after,
    });
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: reEnsure.meta.status,
      setCookieHeader: auth.setCookieHeader,
    });
  }

  const routeUrl = await getSandboxDomain();
  const queryString = sanitizeProxyQueryParams(new URL(request.url).searchParams);
  const targetUrl = buildSandboxTargetUrl(routeUrl, path, queryString);
  const headers = buildSafeProxyHeaders(request, targetUrl.toString(), {
    authorization: `Bearer ${meta.gatewayToken}`,
  });

  // Buffer the request body so we can replay it on 401 retry.
  let bodyBytes: ArrayBuffer | null = null;
  if (request.body && !["GET", "HEAD"].includes(request.method)) {
    bodyBytes = await request.arrayBuffer();
  }

  function buildFetchInit(body: ArrayBuffer | null): RequestInit {
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(maxDuration * 1000),
    };
    if (body) {
      init.body = body;
    }
    return init;
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, buildFetchInit(bodyBytes));
  } catch (err) {
    logError("gateway.upstream_fetch_failed", {
      ...reqCtx,
      error: err instanceof Error ? err.message : String(err),
    });
    return withSetCookie(
      new Response("Bad Gateway", { status: 502 }),
      auth.setCookieHeader,
    );
  }

  // 401 from upstream means the OIDC token expired inside the sandbox.
  // The proxy Authorization header (meta.gatewayToken) authenticates us to the
  // sandbox gateway — that token is unchanged. The expired token is the OIDC
  // credential the sandbox gateway uses to call the Vercel AI Gateway.
  // ensureFreshGatewayToken writes a fresh OIDC token to the sandbox filesystem
  // and restarts the gateway process, so the retry uses the same proxy headers.
  if (upstream.status === 401) {
    logWarn("gateway.upstream_401_token_expired", reqCtx);
    try {
      await ensureFreshGatewayToken({ force: true });
      upstream = await fetch(targetUrl, buildFetchInit(bodyBytes));
      logInfo("gateway.upstream_401_retry_succeeded", {
        ...reqCtx,
        retryStatus: upstream.status,
      });
    } catch (retryErr) {
      logError("gateway.upstream_401_retry_failed", {
        ...reqCtx,
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
      // Fall through with the original 401 response — it's already in `upstream`.
    }
  }

  if (upstream.status === 410) {
    logWarn("gateway.upstream_410", reqCtx);
    await reconcileSandboxHealth({
      origin: getPublicOrigin(request),
      reason: "gateway.410",
      schedule: after,
    });
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: "restoring",
      setCookieHeader: auth.setCookieHeader,
    });
  }

  const responseHeaders = stripProxyResponseHeaders(upstream.headers, [meta.gatewayToken]);
  const locationHeader = responseHeaders.get("location");
  if (locationHeader) {
    const proxyOrigin = new URL(request.url).origin;
    if (locationHeader.startsWith("//")) {
      responseHeaders.delete("location");
      return withSetCookie(
        new Response(
          `<!DOCTYPE html><html><body><h1>Redirect blocked</h1><p><a href="${proxyOrigin}">Return</a></p></body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store, private",
            },
          },
        ),
        auth.setCookieHeader,
      );
    }

    try {
      const redirectUrl = new URL(locationHeader);
      if (redirectUrl.host === targetUrl.host) {
        responseHeaders.set(
          "location",
          `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`,
        );
      } else {
        responseHeaders.delete("location");
      }
    } catch {
      // Ignore relative redirects.
    }
  }

  if (responseHeaders.has("location")) {
    return withSetCookie(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
      auth.setCookieHeader,
    );
  }

  if (NO_BODY_RESPONSE_STATUSES.has(upstream.status)) {
    return withSetCookie(
      new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
      auth.setCookieHeader,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    logInfo("gateway.html_injection", { ...reqCtx, upstreamStatus: upstream.status });
    const html = await upstream.text();
    const sandboxOrigin = new URL(routeUrl).origin;
    const modifiedHtml = injectWrapperScript(html, {
      sandboxOrigin,
      gatewayToken: meta.gatewayToken,
    });

    return withSetCookie(
      new Response(modifiedHtml, {
        status: upstream.status,
        headers: buildTokenHtmlHeaders(meta.gatewayToken, {
          sandboxOrigin,
          proxyOrigin: new URL(request.url).origin,
          upstreamHeaders: upstream.headers,
        }),
      }),
      auth.setCookieHeader,
    );
  }

  return withSetCookie(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
    auth.setCookieHeader,
  );
}

export async function GET(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function POST(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function PUT(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function DELETE(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function HEAD(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function OPTIONS(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}
