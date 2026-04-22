/**
 * Admin endpoint for pasting, inspecting, and clearing OpenClaw
 * `openai-codex` provider credentials.
 *
 * - PUT    — accept a pasted `auth-profiles.json` map, a single entry,
 *            or a `~/.codex/auth.json` payload. Normalise and persist.
 * - GET    — report whether codex is configured (never returns tokens).
 * - DELETE — remove the stored credentials. Idempotent.
 *
 * Raw `access` and `refresh` values are never returned in any response,
 * nor included in info logs — only `accountId`, `expires`, and
 * `updatedAt` are operator-visible.
 *
 * @note `CodexCredentials` is currently re-exported from
 * `@/shared/types`. Once Unit 1 lands `src/server/codex/credentials.ts`
 * as the canonical home, the parsing helper here will be deleted in
 * favour of `parsePastedCodexPayload()` from that module.
 */

import {
  authJsonError,
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { logInfo } from "@/server/log";
import { ApiError, jsonError } from "@/shared/http";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import type { CodexCredentials } from "@/shared/types";

// ---------------------------------------------------------------------------
// Inline payload parser (mirrors Unit 1's parsePastedCodexPayload)
// ---------------------------------------------------------------------------

/** Result of parsing an inbound codex payload into store-ready shape. */
type ParsedCodexPayload = Omit<CodexCredentials, "updatedAt">;

const ONE_HOUR_MS = 60 * 60 * 1000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function coerceAccountId(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
}

function parseLastRefreshIso(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise one `auth-profiles.json` entry (or a raw single entry).
 */
function parseAuthProfileEntry(entry: unknown): ParsedCodexPayload | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;

  // Only look at codex entries; caller handles the "no match" case.
  if (obj.provider !== undefined && obj.provider !== "openai-codex") {
    return null;
  }

  const access =
    (isNonEmptyString(obj.access) && obj.access) ||
    (isNonEmptyString(obj.access_token) && obj.access_token) ||
    null;
  const refresh =
    (isNonEmptyString(obj.refresh) && obj.refresh) ||
    (isNonEmptyString(obj.refresh_token) && obj.refresh_token) ||
    null;
  if (!access || !refresh) return null;

  let expires: number | null = null;
  if (typeof obj.expires === "number" && Number.isFinite(obj.expires)) {
    expires = obj.expires;
  } else if (typeof obj.expires_at === "number" && Number.isFinite(obj.expires_at)) {
    expires = obj.expires_at;
  }
  if (expires === null) {
    // `~/.codex/auth.json` shape falls back to last_refresh + 1h.
    const refreshedAt = parseLastRefreshIso(obj.last_refresh);
    expires = (refreshedAt ?? Date.now()) + ONE_HOUR_MS;
  }

  const accountId =
    coerceAccountId(obj.accountId) ??
    coerceAccountId(obj.account_id);

  return {
    access,
    refresh,
    expires,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

/**
 * Parse a pasted codex payload. Accepts:
 * 1. A full `auth-profiles.json` map (e.g. `{ "openai-codex:default": {...} }`).
 * 2. A single entry, with either camelCase or snake_case field names.
 * 3. A raw `~/.codex/auth.json` with `tokens: { access_token, ... }` and
 *    optional `last_refresh` timestamp.
 */
function parsePastedCodexPayload(raw: unknown): ParsedCodexPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(
      400,
      "INVALID_PAYLOAD",
      "Request body must be a JSON object.",
    );
  }
  const obj = raw as Record<string, unknown>;

  // Shape 3: ~/.codex/auth.json — flatten tokens + last_refresh into one entry.
  if (obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)) {
    const synthesised: Record<string, unknown> = {
      ...(obj.tokens as Record<string, unknown>),
    };
    if (obj.last_refresh !== undefined) {
      synthesised.last_refresh = obj.last_refresh;
    }
    const parsed = parseAuthProfileEntry(synthesised);
    if (parsed) return parsed;
  }

  // Shape 2: a single entry
  const direct = parseAuthProfileEntry(obj);
  if (direct) return direct;

  // Shape 1: `auth-profiles.json` map. Try openai-codex-prefixed keys first,
  // then any other entry, so pasted maps of mixed providers still resolve.
  const entries = Object.entries(obj);
  const prioritised = entries
    .filter(([key]) => key.startsWith("openai-codex"))
    .concat(entries.filter(([key]) => !key.startsWith("openai-codex")));
  for (const [, value] of prioritised) {
    const parsed = parseAuthProfileEntry(value);
    if (parsed) return parsed;
  }

  throw new ApiError(
    400,
    "INVALID_PAYLOAD",
    "Could not find openai-codex credentials in the request body.",
  );
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

/**
 * Build the operator-visible view of a credential record. Never includes
 * `access` or `refresh`. Pass `withExpiresIn: true` on reads so clients
 * can display a countdown without recomputing from a separate timestamp.
 */
function buildRedactedPayload(
  creds: CodexCredentials,
  withExpiresIn = false,
): {
  connected: true;
  expires: number;
  accountId: string | null;
  updatedAt: number;
  expiresIn?: number;
} {
  return {
    connected: true,
    expires: creds.expires,
    accountId: creds.accountId ?? null,
    updatedAt: creds.updatedAt,
    ...(withExpiresIn ? { expiresIn: creds.expires - Date.now() } : {}),
  };
}

// ---------------------------------------------------------------------------
// PUT — upsert credentials
// ---------------------------------------------------------------------------

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let rawInput: unknown;
  try {
    rawInput = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  let parsed: ParsedCodexPayload;
  try {
    parsed = parsePastedCodexPayload(rawInput);
  } catch (error) {
    if (error instanceof ApiError) {
      return authJsonError(error, auth);
    }
    throw error;
  }

  const updatedAt = Date.now();
  const next: CodexCredentials = {
    access: parsed.access,
    refresh: parsed.refresh,
    expires: parsed.expires,
    ...(parsed.accountId !== undefined ? { accountId: parsed.accountId } : {}),
    updatedAt,
  };

  await mutateMeta((meta) => {
    meta.codexCredentials = next;
  });

  // Only surface non-secret fields in logs.
  logInfo("admin.codex_credentials_saved", {
    accountId: next.accountId ?? null,
    expires: next.expires,
    updatedAt: next.updatedAt,
  });

  return authJsonOk(buildRedactedPayload(next), auth);
}

// ---------------------------------------------------------------------------
// GET — report status (redacted)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();
  const creds = meta.codexCredentials ?? null;
  if (!creds) {
    return authJsonOk({ connected: false }, auth);
  }

  return authJsonOk(buildRedactedPayload(creds, true), auth);
}

// ---------------------------------------------------------------------------
// DELETE — clear credentials (idempotent)
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  await mutateMeta((meta) => {
    meta.codexCredentials = null;
  });

  logInfo("admin.codex_credentials_cleared");

  return new Response(null, {
    status: 204,
    ...(auth.setCookieHeader
      ? { headers: { "Set-Cookie": auth.setCookieHeader } }
      : {}),
  });
}
