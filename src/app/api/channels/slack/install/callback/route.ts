import { requireAdminAuth } from "@/server/auth/admin-auth";
import {
  clearCookie,
  getCookieValue,
  isSecureRequest,
} from "@/server/auth/session";
import { applyChannelConfigChange } from "@/server/channels/admin/apply-channel-config-change";
import { fetchSlackAuthIdentity } from "@/server/channels/slack/auth";
import { getSlackInstallConfig } from "@/server/channels/slack/install-config";
import { setSlackChannelConfig } from "@/server/channels/state";
import { logInfo, logWarn } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  SLACK_OAUTH_CTX_COOKIE,
  SLACK_OAUTH_STATE_COOKIE,
  readSlackOAuthContextFromRequest,
  timingSafeStringEqual,
} from "@/app/api/channels/slack/install/route";

type SlackOAuthV2Response = {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  team?: { id?: string; name?: string };
  bot_user_id?: string;
  authed_user?: { id?: string };
};

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAdminAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const secure = isSecureRequest(request);

  // Slack returns ?error= when the user denies or something goes wrong
  const slackError = url.searchParams.get("error");
  if (slackError) {
    logWarn("slack_install.callback_error", { error: slackError });
    return redirectToAdmin(request, slackError, secure);
  }

  // Validate state
  const state = url.searchParams.get("state")?.trim();
  const stateCookie = getCookieValue(request, SLACK_OAUTH_STATE_COOKIE);
  if (!state || !stateCookie || !timingSafeStringEqual(state, stateCookie)) {
    logWarn("slack_install.state_mismatch");
    return redirectToAdmin(request, "state_mismatch", secure);
  }

  // Read and validate context cookie
  const ctx = await readSlackOAuthContextFromRequest(request);
  if (!ctx) {
    logWarn("slack_install.context_missing");
    return redirectToAdmin(request, "context_expired", secure);
  }

  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    logWarn("slack_install.code_missing");
    return redirectToAdmin(request, "code_missing", secure);
  }

  const installConfig = await getSlackInstallConfig();
  if (!installConfig.enabled) {
    logWarn("slack_install.credentials_missing_at_callback");
    return redirectToAdmin(request, "missing_app_credentials", secure);
  }

  // Exchange authorization code for bot token
  const redirectUri = `${getPublicOrigin(request)}/api/channels/slack/install/callback`;
  let tokenResponse: SlackOAuthV2Response;
  try {
    const body = new URLSearchParams();
    body.set("client_id", installConfig.clientId!);
    body.set("client_secret", installConfig.clientSecret!);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);

    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    tokenResponse = (await res.json()) as SlackOAuthV2Response;
  } catch (error) {
    logWarn("slack_install.token_exchange_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return redirectToAdmin(request, "token_exchange_failed", secure);
  }

  if (!tokenResponse.ok || !tokenResponse.access_token) {
    logWarn("slack_install.token_exchange_rejected", {
      error: tokenResponse.error,
    });
    return redirectToAdmin(
      request,
      tokenResponse.error ?? "token_exchange_failed",
      secure,
    );
  }

  const botToken = tokenResponse.access_token;

  // Validate token and get identity (same as manual flow)
  let authIdentity: { team: string; user: string; botId: string };
  try {
    authIdentity = await fetchSlackAuthIdentity(botToken);
  } catch (error) {
    logWarn("slack_install.auth_test_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return redirectToAdmin(request, "auth_test_failed", secure);
  }

  // Persist config — intentionally overwrites existing Slack config (single-instance)
  await setSlackChannelConfig({
    signingSecret: installConfig.signingSecret!,
    botToken,
    configuredAt: Date.now(),
    team: authIdentity.team,
    user: authIdentity.user,
    botId: authIdentity.botId,
  });

  logInfo("slack_install.connected", {
    team: authIdentity.team,
    botId: authIdentity.botId,
  });

  // Post-mutation: delegate to the shared channel config apply helper
  const { liveConfigSync } = await applyChannelConfigChange({
    channel: "slack",
    operation: "oauth-install",
  });

  // Clear OAuth cookies and redirect to admin
  const next = ctx.next || "/admin";
  const redirectUrl = new URL(next, request.url);
  if (
    liveConfigSync.outcome === "degraded" ||
    liveConfigSync.outcome === "failed"
  ) {
    redirectUrl.searchParams.set("slack_install_warning", liveConfigSync.outcome);
    redirectUrl.searchParams.set(
      "slack_install_reason",
      liveConfigSync.reason,
    );
    if (liveConfigSync.operatorMessage) {
      redirectUrl.searchParams.set(
        "slack_install_message",
        liveConfigSync.operatorMessage,
      );
    }
    logWarn("slack_install.operator_warning_redirect", {
      outcome: liveConfigSync.outcome,
      reason: liveConfigSync.reason,
    });
  } else {
    logInfo("slack_install.redirect_ready", {
      outcome: liveConfigSync.outcome,
    });
  }
  const headers = new Headers({ Location: redirectUrl.toString() });
  headers.append("Set-Cookie", clearCookie(SLACK_OAUTH_STATE_COOKIE, secure));
  headers.append("Set-Cookie", clearCookie(SLACK_OAUTH_CTX_COOKIE, secure));
  return new Response(null, { status: 302, headers });
}

function redirectToAdmin(
  request: Request,
  error: string,
  secure: boolean,
): Response {
  const url = new URL("/admin", request.url);
  url.searchParams.set("slack_install_error", error);
  const headers = new Headers({ Location: url.toString() });
  // Always clear OAuth cookies on error to prevent stale state
  headers.append("Set-Cookie", clearCookie(SLACK_OAUTH_STATE_COOKIE, secure));
  headers.append("Set-Cookie", clearCookie(SLACK_OAUTH_CTX_COOKIE, secure));
  return new Response(null, { status: 302, headers });
}
