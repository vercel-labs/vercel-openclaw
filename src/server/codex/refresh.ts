import type { CodexCredentials, SingleMeta } from "@/shared/types";
import { decodeJwtExp } from "@/server/env";
import { logInfo, logWarn } from "@/server/log";
import { codexTokenRefreshLockKey } from "@/server/store/keyspace";
import {
  getInitializedMeta,
  getStore,
  mutateMeta,
  wait,
} from "@/server/store/store";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

const CODEX_ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";

const DEFAULT_BUFFER_MS = 10 * 60 * 1000;

const LOCK_TTL_SECONDS = 60;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 500;

export function isCodexActive(meta: SingleMeta): boolean {
  const candidate = meta.codexCredentials;
  return (
    candidate != null &&
    typeof candidate.refresh === "string" &&
    candidate.refresh.length > 0
  );
}

export type RefreshCodexResult = {
  access: string;
  refresh: string;
  expires: number;
  idToken?: string;
  accountId?: string | null;
};

export type RefreshIfExpiringResult = {
  refreshed: boolean;
  skippedReason?: string;
  error?: string;
};

/**
 * Decode a named string claim from a JWT without verification.
 * Returns `null` if the token cannot be parsed or the claim is missing.
 */
function decodeJwtStringClaim(token: string, claim: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

type OAuthTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
};

function isNumericFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export class CodexRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodexRefreshError";
  }
}

/**
 * POST to the OpenAI token endpoint to exchange a refresh token for a new
 * access token. Returns the refreshed token material and the derived expiry
 * timestamp (ms since epoch) along with the rotated refresh token.
 *
 * Throws `CodexRefreshError` on non-2xx responses; `retryable=true` for 5xx.
 */
export async function refreshCodexCredentials(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshCodexResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetchImpl(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryable = response.status >= 500;
    throw new CodexRefreshError(
      `Codex token refresh failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
      response.status,
      retryable,
    );
  }

  const payload = (await response.json().catch(() => null)) as OAuthTokenResponse | null;
  if (!payload) {
    throw new CodexRefreshError("Codex token refresh returned invalid JSON", null, true);
  }

  const access = typeof payload.access_token === "string" ? payload.access_token : "";
  const refresh =
    typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  if (!access || !refresh) {
    throw new CodexRefreshError(
      "Codex token refresh response missing access_token or refresh_token",
      null,
      false,
    );
  }

  // Prefer the embedded JWT `exp` claim when present; fall back to
  // `expires_in`. `expires` is stored as ms since epoch.
  const nowMs = Date.now();
  const jwtExpSeconds = decodeJwtExp(access);
  let expiresMs: number;
  if (isNumericFinite(jwtExpSeconds)) {
    expiresMs = jwtExpSeconds * 1000;
  } else if (isNumericFinite(payload.expires_in)) {
    expiresMs = nowMs + payload.expires_in * 1000;
  } else {
    throw new CodexRefreshError(
      "Codex token refresh response missing expiry information",
      null,
      false,
    );
  }

  const idToken =
    typeof payload.id_token === "string" && payload.id_token.length > 0
      ? payload.id_token
      : undefined;

  const accountId = decodeJwtStringClaim(access, CODEX_ACCOUNT_ID_CLAIM);

  return {
    access,
    refresh,
    expires: expiresMs,
    idToken,
    accountId,
  };
}

export type RefreshIfExpiringOptions = {
  meta: SingleMeta;
  bufferMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
};

/**
 * Refresh Codex credentials when the current access token is within `bufferMs`
 * of expiry. Skips when Codex is inactive or the token still has headroom.
 *
 * Acquires a distributed lock to coalesce concurrent refresh attempts across
 * serverless invocations. On refresh failure the existing credentials are
 * preserved — callers decide whether to fail the restore.
 */
export async function refreshCodexCredentialsIfExpiring(
  options: RefreshIfExpiringOptions,
): Promise<RefreshIfExpiringResult> {
  const { meta } = options;
  const bufferMs = options.bufferMs ?? DEFAULT_BUFFER_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();

  const current = meta.codexCredentials;
  if (!current || !current.refresh) {
    return { refreshed: false, skippedReason: "no-codex-active" };
  }

  if (current.expires - now > bufferMs) {
    return { refreshed: false, skippedReason: "still-valid" };
  }

  const store = getStore();
  const lockKey = codexTokenRefreshLockKey();
  let lockToken = await store.acquireLock(lockKey, LOCK_TTL_SECONDS);

  if (!lockToken) {
    const waitStart = Date.now();
    while (Date.now() - waitStart < LOCK_WAIT_MS) {
      await wait(LOCK_POLL_MS);
      lockToken = await store.acquireLock(lockKey, LOCK_TTL_SECONDS);
      if (lockToken) break;
    }
    if (!lockToken) {
      logInfo("codex.refresh.lock_contended", {});
      return { refreshed: false, skippedReason: "lock-contended" };
    }
  }

  try {
    // Re-read the latest credentials inside the lock — another invocation may
    // have already refreshed while we were contending.
    const freshMeta = await getInitializedMeta();
    const freshCurrent = freshMeta.codexCredentials;
    if (!freshCurrent) {
      return { refreshed: false, skippedReason: "no-codex-active" };
    }
    if (freshCurrent.expires - now > bufferMs) {
      return { refreshed: false, skippedReason: "still-valid-after-lock" };
    }

    try {
      const refreshed = await refreshCodexCredentials(freshCurrent.refresh, fetchImpl);
      await mutateMeta((m) => {
        const next: CodexCredentials = {
          access: refreshed.access,
          refresh: refreshed.refresh,
          expires: refreshed.expires,
          accountId: refreshed.accountId ?? freshCurrent.accountId ?? null,
          updatedAt: now,
        };
        m.codexCredentials = next;
      });
      logInfo("codex.refresh.succeeded", {
        expiresIn: Math.max(0, refreshed.expires - now),
        rotatedRefreshToken: refreshed.refresh !== freshCurrent.refresh,
      });
      return { refreshed: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof CodexRefreshError ? err.status ?? null : null;
      const retryable =
        err instanceof CodexRefreshError ? err.retryable : true;
      logWarn("codex.refresh.failed", {
        status,
        retryable,
        error: errorMsg,
      });
      return { refreshed: false, error: errorMsg };
    }
  } finally {
    await store.releaseLock(lockKey, lockToken).catch((err) => {
      logWarn("codex.refresh.lock_release_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
