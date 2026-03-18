import { logInfo, logWarn } from "@/server/log";

/**
 * Shared auth-recovery helper for gateway requests.
 *
 * Used by channel delivery, launch-verify, and any path that calls the
 * OpenClaw gateway and needs to self-heal on stale/expired AI Gateway tokens.
 */

const AUTH_FAILURE_BODY_PATTERNS = [
  "expired",
  "invalid_token",
  "unauthorized",
  "forbidden",
] as const;

/**
 * Returns true when the HTTP response looks like an auth failure that
 * could be recovered by refreshing the AI Gateway token.
 *
 * Matches:
 *  - 401, 403, 410 (explicit auth / gone)
 *  - 5xx that may wrap upstream auth errors
 *  - Any status where the body contains auth-related keywords
 */
export function isGatewayAuthFailure(
  status: number,
  bodyText?: string,
): boolean {
  if (status === 401 || status === 403 || status === 410) {
    return true;
  }

  if (status >= 500 && status < 600) {
    // 5xx may wrap upstream auth errors — check body for hints
    if (bodyText) {
      const lower = bodyText.toLowerCase();
      return AUTH_FAILURE_BODY_PATTERNS.some((p) => lower.includes(p));
    }
    // Bare 5xx without body text is ambiguous — treat as potential auth failure
    // only for the "retry with refresh" path (callers still get one retry)
    return true;
  }

  // Non-auth status codes can still carry auth error bodies (e.g. 400 with
  // "expired" or "invalid_token" from the upstream provider).
  if (bodyText) {
    const lower = bodyText.toLowerCase();
    return AUTH_FAILURE_BODY_PATTERNS.some((p) => lower.includes(p));
  }

  return false;
}

export type CallGatewayWithAuthRecoveryOptions<T> = {
  /** Human-readable label for log lines (e.g. "channel:telegram", "launch-verify"). */
  label: string;

  /** The sandbox ID, used for logging context. */
  sandboxId: string;

  /** Execute the gateway HTTP request. Called once, and again after refresh if needed. */
  makeRequest: () => Promise<Response>;

  /** Parse a successful response into the caller's result type. */
  parseResponse: (response: Response) => Promise<T>;

  /**
   * Force-refresh the AI Gateway token on the sandbox.
   * Returns true if refresh succeeded, false otherwise.
   */
  onRefreshNeeded: () => Promise<boolean>;
};

export type CallGatewaySuccessResult<T> = {
  ok: true;
  result: T;
  refreshed: boolean;
};

export type CallGatewayFailureResult = {
  ok: false;
  error: string;
  retryable: boolean;
  /** HTTP status code from the gateway, if available. */
  status?: number;
  /** Retry-After value from the response, in seconds. */
  retryAfterSeconds?: number;
};

export type CallGatewayResult<T> =
  | CallGatewaySuccessResult<T>
  | CallGatewayFailureResult;

/**
 * Attempt a gateway request with automatic auth recovery.
 *
 * 1. Calls `makeRequest()`.
 * 2. If the response indicates an auth failure (via `isGatewayAuthFailure`),
 *    calls `onRefreshNeeded()` to force-refresh the token, then retries
 *    `makeRequest()` exactly once.
 * 3. If refresh or retry fails, returns a retryable error so the caller's
 *    queue infrastructure can schedule another attempt.
 */
export async function callGatewayWithAuthRecovery<T>(
  opts: CallGatewayWithAuthRecoveryOptions<T>,
): Promise<CallGatewayResult<T>> {
  const { label, sandboxId, makeRequest, parseResponse, onRefreshNeeded } = opts;

  // --- First attempt ---
  let response: Response;
  try {
    response = await makeRequest();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("gateway.auth_recovery.request_failed", {
      label,
      sandboxId,
      attempt: 1,
      error: message,
    });
    return { ok: false, error: message, retryable: true };
  }

  // Happy path — no auth failure
  if (response.ok) {
    try {
      const result = await parseResponse(response);
      return { ok: true, result, refreshed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `parse_error: ${message}`, retryable: false };
    }
  }

  // Read body for auth-failure detection
  const bodyText = await response.text().catch(() => "");
  const status = response.status;

  if (!isGatewayAuthFailure(status, bodyText)) {
    // Not an auth failure.  5xx is inherently transient — always retryable
    // at the queue level even when it is not an auth problem.
    const retryable = status >= 500 && status < 600;
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    const errorMsg = retryable
      ? `gateway_retryable_${status}`
      : `gateway_failed_${status}`;
    return { ok: false, error: errorMsg, retryable, status, retryAfterSeconds: (retryAfterSeconds && !isNaN(retryAfterSeconds)) ? retryAfterSeconds : undefined };
  }

  // --- Auth failure detected — attempt refresh + retry ---
  logInfo("gateway.auth_recovery.auth_failure_detected", {
    label,
    sandboxId,
    status,
    bodySnippet: bodyText.slice(0, 200),
  });

  let refreshed = false;
  try {
    refreshed = await onRefreshNeeded();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("gateway.auth_recovery.refresh_failed", {
      label,
      sandboxId,
      error: message,
    });
    // Refresh failed — return retryable so the queue can try again later
    // when OIDC may be available.
    return {
      ok: false,
      error: `auth_refresh_failed: ${message}`,
      retryable: true,
    };
  }

  if (!refreshed) {
    logWarn("gateway.auth_recovery.refresh_unavailable", {
      label,
      sandboxId,
    });
    return {
      ok: false,
      error: "auth_refresh_unavailable",
      retryable: true,
    };
  }

  logInfo("gateway.auth_recovery.retrying_after_refresh", {
    label,
    sandboxId,
  });

  // --- Retry after refresh ---
  let retryResponse: Response;
  try {
    retryResponse = await makeRequest();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("gateway.auth_recovery.retry_request_failed", {
      label,
      sandboxId,
      error: message,
    });
    return { ok: false, error: `retry_failed: ${message}`, retryable: true };
  }

  if (retryResponse.ok) {
    try {
      const result = await parseResponse(retryResponse);
      logInfo("gateway.auth_recovery.retry_succeeded", {
        label,
        sandboxId,
      });
      return { ok: true, result, refreshed: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `retry_parse_error: ${message}`, retryable: false };
    }
  }

  // Retry also failed
  const retryBody = await retryResponse.text().catch(() => "");
  const retryErrorMsg = retryBody.length > 0
    ? `gateway_retry_failed status=${retryResponse.status} body=${retryBody.slice(0, 300)}`
    : `gateway_retry_failed status=${retryResponse.status}`;

  logWarn("gateway.auth_recovery.retry_failed_response", {
    label,
    sandboxId,
    status: retryResponse.status,
    bodySnippet: retryBody.slice(0, 200),
  });

  return { ok: false, error: retryErrorMsg, retryable: true };
}
