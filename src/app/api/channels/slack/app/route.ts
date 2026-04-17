import { ApiError } from "@/shared/http";
import {
  authJsonError,
  authJsonOk,
  requireJsonRouteAuth,
} from "@/server/auth/route-auth";
import {
  createSlackInstallToken,
  deleteSlackAppConfig,
  setSlackAppConfig,
  type StoredSlackAppConfig,
} from "@/server/channels/slack/app-config";
import { buildSlackManifest } from "@/server/channels/slack/app-definition";
import {
  createSlackAppFromManifest,
  rotateSlackConfigToken,
  SlackManifestApiError,
} from "@/server/channels/slack/manifest-api";
import { logInfo, logWarn } from "@/server/log";
import { buildPublicUrl, getPublicOrigin } from "@/server/public-url";

/**
 * POST /api/channels/slack/app
 *
 * Creates a brand-new Slack app via `apps.manifest.create`, persists the
 * returned credentials to Redis, and mints a one-time `installToken` that
 * lets the operator start the OAuth install flow without an admin cookie.
 *
 * Request body:
 *   {
 *     configToken:   string             // Slack App Configuration Token
 *     refreshToken?: string             // optional; used to auto-rotate on expiry
 *     appName?:      string             // optional display name override
 *   }
 *
 * Response:
 *   {
 *     appId:          string
 *     appName:        string
 *     installUrl:     string            // absolute URL to open in a browser
 *     installToken:   string            // 5-min TTL, single use
 *     oauthAuthorizeUrl: string         // Slack-hosted alternative to installUrl
 *     credentialsSource: "redis"
 *     tokenRotated:   boolean           // true when we refreshed the config token
 *   }
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const body = (await request.json().catch(() => null)) as
      | { configToken?: unknown; refreshToken?: unknown; appName?: unknown }
      | null;
    if (!body) {
      throw new ApiError(400, "INVALID_BODY", "Request body must be JSON.");
    }
    const configToken = parseNonEmptyString(body.configToken, "configToken");
    const refreshToken = parseOptionalString(body.refreshToken);
    const appName = parseOptionalString(body.appName);

    const webhookUrl = buildPublicUrl("/api/channels/slack/webhook", request);
    const redirectUrl = `${getPublicOrigin(request)}/api/channels/slack/install/callback`;
    const manifest = buildSlackManifest({ webhookUrl, redirectUrl, appName });

    const { result, tokenRotated, activeConfigToken, activeRefreshToken, configTokenExpiresAt } =
      await createWithAutoRotate({
        configToken,
        refreshToken,
        manifest,
      });

    const stored: StoredSlackAppConfig = {
      appId: result.appId,
      appName: appName ?? "VClaw",
      clientId: result.credentials.clientId,
      clientSecret: result.credentials.clientSecret,
      signingSecret: result.credentials.signingSecret,
      verificationToken: result.credentials.verificationToken,
      configToken: activeConfigToken,
      refreshToken: activeRefreshToken,
      configTokenExpiresAt,
      createdAt: Date.now(),
    };

    await setSlackAppConfig(stored);

    const installToken = await createSlackInstallToken();
    const installUrl = `${getPublicOrigin(request)}/api/channels/slack/install?install_token=${installToken}`;

    logInfo("slack_app.created", {
      appId: stored.appId,
      appName: stored.appName,
      tokenRotated,
    });

    return authJsonOk(
      {
        appId: stored.appId,
        appName: stored.appName,
        installUrl,
        installToken,
        oauthAuthorizeUrl: result.oauthAuthorizeUrl,
        credentialsSource: "redis" as const,
        tokenRotated,
      },
      auth,
    );
  } catch (error) {
    if (error instanceof SlackManifestApiError) {
      logWarn("slack_app.create_rejected", { code: error.code });
      return authJsonError(
        new ApiError(
          error.status >= 400 && error.status < 600 ? error.status : 400,
          error.code.toUpperCase(),
          error.message,
        ),
        auth,
      );
    }
    return authJsonError(error, auth);
  }
}

/**
 * DELETE /api/channels/slack/app — wipe the stored app credentials.
 * Use when the operator wants to start over (mint a new app).
 * Does NOT touch the Slack app itself; that requires a separate
 * apps.manifest.delete call.
 */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  try {
    await deleteSlackAppConfig();
    logInfo("slack_app.deleted");
    return authJsonOk({ ok: true }, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

async function createWithAutoRotate(args: {
  configToken: string;
  refreshToken: string | undefined;
  manifest: Record<string, unknown>;
}): Promise<{
  result: Awaited<ReturnType<typeof createSlackAppFromManifest>>;
  tokenRotated: boolean;
  activeConfigToken: string;
  activeRefreshToken: string | undefined;
  configTokenExpiresAt: number | undefined;
}> {
  let activeConfigToken = args.configToken;
  let activeRefreshToken = args.refreshToken;
  let configTokenExpiresAt: number | undefined;
  let tokenRotated = false;

  try {
    const result = await createSlackAppFromManifest({
      configToken: activeConfigToken,
      manifest: args.manifest,
    });
    return {
      result,
      tokenRotated,
      activeConfigToken,
      activeRefreshToken,
      configTokenExpiresAt,
    };
  } catch (error) {
    const isExpired =
      error instanceof SlackManifestApiError && error.code === "token_expired";
    if (!isExpired || !activeRefreshToken) throw error;

    logInfo("slack_app.rotating_config_token");
    const rotated = await rotateSlackConfigToken({
      refreshToken: activeRefreshToken,
    });
    activeConfigToken = rotated.configToken;
    activeRefreshToken = rotated.refreshToken;
    configTokenExpiresAt = rotated.configTokenExpiresAt;
    tokenRotated = true;

    const result = await createSlackAppFromManifest({
      configToken: activeConfigToken,
      manifest: args.manifest,
    });
    return {
      result,
      tokenRotated,
      activeConfigToken,
      activeRefreshToken,
      configTokenExpiresAt,
    };
  }
}

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
