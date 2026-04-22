import type { CodexCredentials, SingleMeta } from "@/shared/types";

/**
 * Pure-functions module for OpenClaw `openai-codex` OAuth credentials.
 *
 * This file MUST stay free of `@vercel/sandbox`, Next.js server-only APIs,
 * and any I/O so it can be safely imported from both server routes and
 * (eventually) shared admin UI for type narrowing. It only handles
 * parsing, shape normalization, and redaction.
 *
 * The presence of `meta.codexCredentials != null` is the single data-driven
 * feature flag that activates Codex mode — when active, the sandbox uses
 * ChatGPT backend inference and skips the AI Gateway credential transform.
 */

/** OpenClaw's auth-profiles.json key for the default Codex profile. */
export const CODEX_AUTH_PROFILE_KEY = "openai-codex:default";

/**
 * Redacted Codex credential shape safe to surface in admin JSON.
 *
 * Never exposes raw `access` / `refresh` tokens. UI should treat `connected`
 * as the display toggle and `expires` for staleness hints.
 */
export type RedactedCodexCredentials = {
  connected: true;
  expires: number;
  accountId?: string | null;
  updatedAt: number;
};

/** Read Codex credentials from metadata. Returns null when Codex is inactive. */
export function readCodexCredentials(meta: SingleMeta): CodexCredentials | null {
  return meta.codexCredentials ?? null;
}

/** `true` when Codex mode is currently active. */
export function isCodexActive(meta: SingleMeta): boolean {
  return readCodexCredentials(meta) !== null;
}

/**
 * Redact credentials for admin-visible surfaces. Guarantees `access` and
 * `refresh` are NEVER present in the returned object.
 */
export function redactCodexCredentials(
  creds: CodexCredentials,
): RedactedCodexCredentials {
  const redacted: RedactedCodexCredentials = {
    connected: true,
    expires: creds.expires,
    updatedAt: creds.updatedAt,
  };
  if (creds.accountId !== undefined) {
    redacted.accountId = creds.accountId;
  }
  return redacted;
}

/**
 * Serialize credentials into the JSON string OpenClaw expects at
 * `${OPENCLAW_STATE_DIR}/agents/main/agent/auth-profiles.json`.
 *
 * Pretty-printed with 2-space indent for diffing; no trailing newline so
 * callers can choose their own line-ending policy.
 */
export function buildAuthProfilesJson(creds: CodexCredentials): string {
  const entry = {
    type: "oauth" as const,
    provider: "openai-codex" as const,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    ...(creds.accountId !== undefined && creds.accountId !== null
      ? { accountId: creds.accountId }
      : {}),
  };
  return JSON.stringify({ [CODEX_AUTH_PROFILE_KEY]: entry }, null, 2);
}

/**
 * Parse a string pasted by an operator into `CodexCredentials`. Accepts
 * three shapes so operators can drop in whichever artifact they have:
 *
 *   1. Raw `~/.codex/auth.json` — `{ tokens: { access_token, refresh_token,
 *      account_id }, last_refresh?, expires? }`.
 *   2. A single entry — `{ access, refresh, expires, accountId? }` or the
 *      snake_case equivalent.
 *   3. A full `auth-profiles.json` map — the `openai-codex:default` entry
 *      is extracted.
 *
 * Throws `Error` on malformed input.
 */
export function parsePastedCodexPayload(raw: string): CodexCredentials {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Codex credential payload is empty.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Codex credential payload is not valid JSON: ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex credential payload must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;

  // Shape (3): full auth-profiles.json map — extract the default entry.
  if (CODEX_AUTH_PROFILE_KEY in obj) {
    const entry = obj[CODEX_AUTH_PROFILE_KEY];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `auth-profiles entry "${CODEX_AUTH_PROFILE_KEY}" must be an object.`,
      );
    }
    return normalizeCodexCredentialsForStorage(entry as Record<string, unknown>);
  }

  // Shape (1): raw ~/.codex/auth.json with a nested `tokens` object.
  if (obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)) {
    const tokens = obj.tokens as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...tokens };
    if (obj.expires !== undefined) merged.expires = obj.expires;
    if (obj.last_refresh !== undefined) merged.last_refresh = obj.last_refresh;
    return normalizeCodexCredentialsForStorage(merged);
  }

  // Shape (2): flat object with access/refresh/expires (or snake_case).
  return normalizeCodexCredentialsForStorage(obj);
}

/**
 * Normalize a record with either camelCase or snake_case keys into the
 * canonical `CodexCredentials` shape, setting `updatedAt` to `Date.now()`.
 *
 * Accepted aliases:
 *   - `access` ← `access_token`
 *   - `refresh` ← `refresh_token`
 *   - `accountId` ← `account_id`
 *   - `expires` ← `expires_at` ← derived from `last_refresh` + a 1h window
 *     when no explicit expiry is present (matches the typical Codex refresh
 *     lifetime; callers are expected to refresh well before the next use).
 *
 * Throws `Error` when required fields are missing or malformed.
 */
export function normalizeCodexCredentialsForStorage(
  input: Record<string, unknown>,
): CodexCredentials {
  const access = pickString(input, ["access", "access_token"]);
  if (!access) {
    throw new Error("Codex credential payload is missing access token.");
  }

  const refresh = pickString(input, ["refresh", "refresh_token"]);
  if (!refresh) {
    throw new Error("Codex credential payload is missing refresh token.");
  }

  const accountId = pickOptionalString(input, ["accountId", "account_id"]);
  const expires = resolveExpires(input);
  if (expires === null) {
    throw new Error(
      "Codex credential payload is missing a valid expires / expires_at / last_refresh timestamp.",
    );
  }

  return {
    access,
    refresh,
    expires,
    ...(accountId !== undefined ? { accountId } : {}),
    updatedAt: Date.now(),
  };
}

/** One hour in ms — the fallback access-token lifetime when only a `last_refresh` is known. */
const CODEX_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

function resolveExpires(input: Record<string, unknown>): number | null {
  const direct = input.expires ?? input.expires_at;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === "string") {
    const parsed = parseTimestamp(direct);
    if (parsed !== null) return parsed;
  }

  const lastRefresh = input.last_refresh;
  if (typeof lastRefresh === "number" && Number.isFinite(lastRefresh)) {
    return lastRefresh + CODEX_DEFAULT_TOKEN_LIFETIME_MS;
  }
  if (typeof lastRefresh === "string") {
    const parsed = parseTimestamp(lastRefresh);
    if (parsed !== null) return parsed + CODEX_DEFAULT_TOKEN_LIFETIME_MS;
  }

  return null;
}

function parseTimestamp(value: string): number | null {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(value);
  return Number.isFinite(asDate) ? asDate : null;
}

function pickString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickOptionalString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | null | undefined {
  for (const key of keys) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) return null;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
