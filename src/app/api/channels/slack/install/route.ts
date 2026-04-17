import { randomBytes, timingSafeEqual } from "node:crypto";

import { requireAdminAuth } from "@/server/auth/admin-auth";
import {
  encryptPayload,
  getCookieValue,
  isSecureRequest,
  serializeCookie,
  decryptPayload,
} from "@/server/auth/session";
import { buildChannelConnectability } from "@/server/channels/connectability";
import { consumeSlackInstallToken } from "@/server/channels/slack/app-config";
import { SLACK_BOT_SCOPES } from "@/server/channels/slack/app-definition";
import { getSlackInstallConfig } from "@/server/channels/slack/install-config";
import { logInfo, logWarn } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";

export const SLACK_OAUTH_STATE_COOKIE = "slack_oauth_state";
export const SLACK_OAUTH_CTX_COOKIE = "slack_oauth_ctx";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export type SlackOAuthContext = {
  next: string;
};

export async function GET(request: Request): Promise<Response> {
  // Accept EITHER an admin session/bearer OR a one-time install_token minted
  // by POST /api/channels/slack/app. The latter is what `vclaw create --slack`
  // opens in the browser so the operator doesn't have to sign into the
  // admin panel just to start the OAuth install.
  const url = new URL(request.url);
  const installTokenParam = url.searchParams.get("install_token")?.trim();
  const userAgent = request.headers.get("user-agent") ?? "";
  const clientKind = classifyInstallCaller(userAgent);
  let usedInstallToken = false;
  if (installTokenParam) {
    // Log BEFORE consuming so we can attribute a later consume_miss to the
    // exact caller that burned the token. If this log shows a non-browser
    // UA (node-fetch, undici, curl, go-http-client, …) between mint and
    // the browser arriving, something is pre-consuming one-time tokens —
    // that was the `provisionSlack.installUrl.probe` bug in vclaw < 0.2.1.
    logInfo("slack_install.request_received", {
      tokenPrefix: installTokenParam.slice(0, 6),
      clientKind,
      userAgent: userAgent.slice(0, 160),
      referer: request.headers.get("referer")?.slice(0, 160) ?? null,
    });
    usedInstallToken = await consumeSlackInstallToken(installTokenParam);
    if (!usedInstallToken) {
      logWarn("slack_install.install_token_invalid", {
        tokenPrefix: installTokenParam.slice(0, 6),
        clientKind,
        userAgent: userAgent.slice(0, 160),
      });
      return redirectToAdmin(request, "install_token_invalid");
    }
    logInfo("slack_install.install_token_consumed", {
      tokenPrefix: installTokenParam.slice(0, 6),
      clientKind,
    });
  } else {
    const auth = await requireAdminAuth(request);
    if (auth instanceof Response) {
      return auth;
    }
  }

  const installConfig = await getSlackInstallConfig();
  if (!installConfig.enabled) {
    logWarn("slack_install.missing_app_credentials");
    return redirectToAdmin(request, "missing_app_credentials");
  }

  const connectability = await buildChannelConnectability("slack", request);
  if (!connectability.canConnect) {
    logWarn("slack_install.connect_blocked", {
      issues: connectability.issues.map((i) => i.id),
    });
    return redirectToAdmin(request, "connect_blocked");
  }

  const state = randomBytes(24).toString("base64url");
  const secure = isSecureRequest(request);
  const redirectUri = `${getPublicOrigin(request)}/api/channels/slack/install/callback`;

  const authorizeUrl = new URL(SLACK_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", installConfig.clientId!);
  authorizeUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  logInfo("slack_install.authorize_redirect", { redirectUri, usedInstallToken });

  const headers = new Headers({ Location: authorizeUrl.toString() });
  headers.append(
    "Set-Cookie",
    serializeCookie(SLACK_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: 5 * 60,
      path: "/",
      sameSite: "Lax",
      secure,
    }),
  );
  headers.append(
    "Set-Cookie",
    await serializeSlackOAuthContextCookie({ next: "/admin" }, secure),
  );

  return new Response(null, { status: 302, headers });
}

function redirectToAdmin(request: Request, error: string): Response {
  const url = new URL("/admin", request.url);
  url.searchParams.set("slack_install_error", error);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

/**
 * Classify the HTTP client based on User-Agent so a `consume_miss` can be
 * attributed to the exact caller that burned the token first.
 */
function classifyInstallCaller(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari") || ua.includes("firefox") || ua.includes("edge")) {
    return "browser";
  }
  if (ua.includes("node") || ua.includes("undici")) return "node-fetch";
  if (ua.includes("curl")) return "curl";
  if (ua.includes("wget")) return "wget";
  if (ua.includes("go-http-client")) return "go-http";
  if (ua.includes("python")) return "python";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "bot";
  return "other";
}

// ── Cookie helpers ──

export async function serializeSlackOAuthContextCookie(
  value: SlackOAuthContext,
  secure: boolean,
): Promise<string> {
  const encrypted = await encryptPayload({ next: value.next }, "5m");
  return serializeCookie(SLACK_OAUTH_CTX_COOKIE, encrypted, {
    httpOnly: true,
    maxAge: 5 * 60,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

export async function readSlackOAuthContextFromRequest(
  request: Request,
): Promise<SlackOAuthContext | null> {
  const raw = getCookieValue(request, SLACK_OAUTH_CTX_COOKIE);
  if (!raw) return null;

  const payload = await decryptPayload<{ next?: string }>(raw);
  if (!payload || typeof payload.next !== "string") return null;

  return { next: payload.next };
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
