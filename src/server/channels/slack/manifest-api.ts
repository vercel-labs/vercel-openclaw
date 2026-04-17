/**
 * HTTP client for Slack's app-configuration API.
 *
 *   apps.manifest.create   — create a brand-new app from a manifest
 *   tooling.tokens.rotate  — refresh a 12h App Configuration Token
 *
 * The config token (prefix `xoxe.xoxp-`) must be minted once by a workspace
 * admin at https://api.slack.com/apps → "Your App Configuration Tokens".
 * Slack has no API to mint it programmatically — that's the one paste we
 * can't design away.
 */

const MANIFEST_CREATE_URL = "https://slack.com/api/apps.manifest.create";
const TOKENS_ROTATE_URL = "https://slack.com/api/tooling.tokens.rotate";
const SLACK_API_TIMEOUT_MS = 20_000;

export type SlackManifestCredentials = {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  verificationToken?: string;
};

export type SlackManifestCreateResult = {
  appId: string;
  credentials: SlackManifestCredentials;
  oauthAuthorizeUrl: string;
};

export type SlackTokenRotateResult = {
  configToken: string;
  refreshToken: string;
  /** Unix-epoch ms when the new config token expires. */
  configTokenExpiresAt: number;
};

export class SlackManifestApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function createSlackAppFromManifest(args: {
  configToken: string;
  manifest: Record<string, unknown>;
  fetchFn?: typeof fetch;
}): Promise<SlackManifestCreateResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch;

  const body = new URLSearchParams();
  body.set("manifest", JSON.stringify(args.manifest));

  const response = await fetchFn(MANIFEST_CREATE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.configToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });

  type ManifestCreateResponse = {
    ok?: boolean;
    error?: string;
    app_id?: string;
    credentials?: {
      client_id?: string;
      client_secret?: string;
      signing_secret?: string;
      verification_token?: string;
    };
    oauth_authorize_url?: string;
  };

  const payload = (await response.json().catch(() => null)) as
    | ManifestCreateResponse
    | null;

  if (!payload || payload.ok !== true) {
    const code = payload?.error ?? `status_${response.status}`;
    throw new SlackManifestApiError(
      code,
      describeManifestError(code),
      response.status,
    );
  }

  const {
    app_id: appId,
    credentials,
    oauth_authorize_url: oauthAuthorizeUrl,
  } = payload;

  if (
    typeof appId !== "string" ||
    !credentials ||
    typeof credentials.client_id !== "string" ||
    typeof credentials.client_secret !== "string" ||
    typeof credentials.signing_secret !== "string" ||
    typeof oauthAuthorizeUrl !== "string"
  ) {
    throw new SlackManifestApiError(
      "malformed_response",
      "Slack apps.manifest.create returned an incomplete response.",
      502,
    );
  }

  return {
    appId,
    credentials: {
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      signingSecret: credentials.signing_secret,
      verificationToken:
        typeof credentials.verification_token === "string"
          ? credentials.verification_token
          : undefined,
    },
    oauthAuthorizeUrl,
  };
}

export async function rotateSlackConfigToken(args: {
  refreshToken: string;
  fetchFn?: typeof fetch;
}): Promise<SlackTokenRotateResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch;

  const body = new URLSearchParams();
  body.set("refresh_token", args.refreshToken);

  const response = await fetchFn(TOKENS_ROTATE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });

  type RotateResponse = {
    ok?: boolean;
    error?: string;
    token?: string;
    refresh_token?: string;
    iat?: number;
    exp?: number;
  };

  const payload = (await response.json().catch(() => null)) as
    | RotateResponse
    | null;

  if (!payload || payload.ok !== true) {
    const code = payload?.error ?? `status_${response.status}`;
    throw new SlackManifestApiError(
      code,
      describeRotateError(code),
      response.status,
    );
  }

  if (
    typeof payload.token !== "string" ||
    typeof payload.refresh_token !== "string"
  ) {
    throw new SlackManifestApiError(
      "malformed_response",
      "Slack tooling.tokens.rotate returned an incomplete response.",
      502,
    );
  }

  const expSeconds = typeof payload.exp === "number" ? payload.exp : null;

  return {
    configToken: payload.token,
    refreshToken: payload.refresh_token,
    configTokenExpiresAt:
      expSeconds !== null ? expSeconds * 1000 : Date.now() + 12 * 60 * 60 * 1000,
  };
}

function describeManifestError(code: string): string {
  switch (code) {
    case "token_expired":
      return "Slack configuration token expired. Rotate with tooling.tokens.rotate or mint a new one at https://api.slack.com/apps.";
    case "invalid_auth":
    case "not_authed":
      return "Slack configuration token was rejected. Mint a fresh one at https://api.slack.com/apps → Your App Configuration Tokens.";
    case "invalid_manifest":
      return "Slack rejected the manifest as invalid. Check scopes, event subscriptions, and URL fields.";
    case "url_verification_failed":
      return "Slack could not verify the Event Subscriptions Request URL. Confirm the deployment is live and /api/channels/slack/webhook is reachable without deployment protection.";
    default:
      return `Slack apps.manifest.create rejected the request (${code}).`;
  }
}

function describeRotateError(code: string): string {
  switch (code) {
    case "invalid_refresh_token":
    case "token_revoked":
      return "Slack refresh token is no longer valid. Mint a new configuration token at https://api.slack.com/apps.";
    default:
      return `Slack tooling.tokens.rotate rejected the request (${code}).`;
  }
}
