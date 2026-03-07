import { ApiError } from "@/shared/http";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordApplicationIdentity = {
  applicationId: string;
  publicKey: string;
  appName?: string;
  botUsername?: string;
  currentInteractionsEndpointUrl?: string | null;
};

function getFetchFn(fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) {
    return fetchFn;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new ApiError(500, "DISCORD_FETCH_UNAVAILABLE", "Fetch is unavailable in this runtime");
  }

  return globalThis.fetch;
}

function normalizeBotToken(botToken: string): string {
  const trimmed = botToken.trim();
  const normalized = trimmed.replace(/^Bot\s+/i, "").trim();
  if (!normalized) {
    throw new ApiError(400, "DISCORD_INVALID_BOT_TOKEN", "Discord bot token is required");
  }

  return normalized;
}

function mapDiscordTokenError(status: number): ApiError | null {
  if (status === 401 || status === 403) {
    return new ApiError(
      400,
      "DISCORD_INVALID_BOT_TOKEN",
      "Discord rejected this token. Check that it is a valid bot token.",
    );
  }

  if (status === 429) {
    return new ApiError(
      429,
      "DISCORD_RATE_LIMITED",
      "Discord rate limited this request. Retry in a few seconds.",
    );
  }

  if (status >= 500) {
    return new ApiError(
      502,
      "DISCORD_UPSTREAM_ERROR",
      "Discord is temporarily unavailable. Try again shortly.",
    );
  }

  return null;
}

function mapDiscordEndpointPatchError(status: number): ApiError | null {
  if (status === 400) {
    return new ApiError(
      400,
      "DISCORD_ENDPOINT_INVALID",
      "Discord could not verify the endpoint. Ensure the URL is public and responding.",
    );
  }

  return mapDiscordTokenError(status);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function fetchDiscordApplicationIdentity(
  botToken: string,
  fetchFn?: typeof fetch,
): Promise<DiscordApplicationIdentity> {
  const normalizedToken = normalizeBotToken(botToken);
  const runFetch = getFetchFn(fetchFn);
  const response = await runFetch(`${DISCORD_API_BASE}/applications/@me`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${normalizedToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw (
      mapDiscordTokenError(response.status) ??
      new ApiError(
        502,
        "DISCORD_UPSTREAM_ERROR",
        `Discord API request failed with status ${response.status}`,
      )
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const applicationId = toOptionalString(payload.id);
  const publicKey = toOptionalString(payload.verify_key)?.toLowerCase();
  if (!applicationId || !publicKey) {
    throw new ApiError(
      502,
      "DISCORD_UPSTREAM_ERROR",
      "Discord response was missing application identity fields.",
    );
  }

  const bot =
    payload.bot && typeof payload.bot === "object"
      ? (payload.bot as Record<string, unknown>)
      : null;
  const interactionsEndpointRaw = payload.interactions_endpoint_url;
  const currentInteractionsEndpointUrl =
    typeof interactionsEndpointRaw === "string"
      ? interactionsEndpointRaw
      : interactionsEndpointRaw === null
        ? null
        : undefined;

  return {
    applicationId,
    publicKey,
    appName: toOptionalString(payload.name),
    botUsername: toOptionalString(bot?.username),
    currentInteractionsEndpointUrl,
  };
}

export async function patchInteractionsEndpoint(
  botToken: string,
  url: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  const normalizedToken = normalizeBotToken(botToken);
  const runFetch = getFetchFn(fetchFn);
  const response = await runFetch(`${DISCORD_API_BASE}/applications/@me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${normalizedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      interactions_endpoint_url: url,
    }),
  });

  if (!response.ok) {
    throw (
      mapDiscordEndpointPatchError(response.status) ??
      new ApiError(
        502,
        "DISCORD_UPSTREAM_ERROR",
        `Discord API request failed with status ${response.status}`,
      )
    );
  }
}

export function resolveBaseUrl(request: Request): string {
  const configuredDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? process.env.BASE_DOMAIN;
  if (configuredDomain && configuredDomain.trim().length > 0) {
    const trimmed = trimTrailingSlashes(configuredDomain.trim());
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return trimmed;
    }

    return `https://${trimmed}`;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  const hostHeader = request.headers.get("host");
  const host = (forwardedHost ?? hostHeader ?? "").split(",")[0]?.trim();
  if (!host) {
    throw new ApiError(
      500,
      "MISSING_HOST",
      "Cannot determine the external host for Discord webhook URL generation.",
    );
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto = (forwardedProto?.split(",")[0]?.trim() || "https").toLowerCase();
  return `${proto || "https"}://${host}`;
}

export function buildWebhookUrl(baseUrl: string): string {
  return `${trimTrailingSlashes(baseUrl)}/api/channels/discord/webhook`;
}

export function isPublicUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  if (!normalized.startsWith("https://")) {
    return false;
  }

  if (
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes("0.0.0.0")
  ) {
    return false;
  }

  return true;
}
