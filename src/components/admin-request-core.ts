/**
 * Shared admin read (GET) helper for panels.
 *
 * Centralises auth-expiry handling, error surfacing, and read lifecycle logging
 * so that Logs, Firewall, Snapshots, and future read-only admin surfaces
 * all behave consistently.
 */

import {
  createAdminActionRequestId,
  emitAdminActionEvent,
} from "@/components/admin-action-core";

export type ReadJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null };

export type ReadJsonDeps = {
  setStatus: (status: null) => void;
  toastError: (message: string) => void;
  fetchFn?: typeof fetch;
};

export type ReadJsonOptions = {
  toastError?: boolean;
};

function logAdminReadError(payload: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event: "admin.read.error", ...payload }));
}

/**
 * Fetch a JSON admin GET endpoint with shared auth/error handling.
 *
 * - 401 clears auth state via `deps.setStatus(null)` and toasts.
 * - Non-401 errors surface visible panel error state.
 * - Emits `admin.read.error` for auth / HTTP / network failures.
 * - Keeps successful reads quiet in the browser console so `/api/status`
 *   polling does not flood operator devtools.
 */
export async function fetchAdminJsonCore<T>(
  action: string,
  deps: ReadJsonDeps,
  options: ReadJsonOptions = {},
): Promise<ReadJsonResult<T>> {
  const requestId = createAdminActionRequestId();
  const doFetch = deps.fetchFn ?? fetch;
  const shouldToastError = options.toastError !== false;

  try {
    const response = await doFetch(action, {
      cache: "no-store" as RequestCache,
      headers: { accept: "application/json" },
    });

    if (response.status === 401) {
      deps.setStatus(null);
      const error = "Session expired. Sign in again.";
      emitAdminActionEvent({
        event: "admin.read.error",
        requestId,
        action,
        status: 401,
        code: "unauthorized",
        error,
      });
      logAdminReadError({
        requestId,
        action,
        status: 401,
        code: "unauthorized",
        error,
      });
      if (shouldToastError) {
        deps.toastError(error);
      }
      return { ok: false, error, status: 401 };
    }

    if (!response.ok) {
      const error = `Request failed (HTTP ${response.status})`;
      emitAdminActionEvent({
        event: "admin.read.error",
        requestId,
        action,
        status: response.status,
        code: "http-error",
        error,
      });
      logAdminReadError({
        requestId,
        action,
        status: response.status,
        code: "http-error",
        error,
      });
      if (shouldToastError) {
        deps.toastError(error);
      }
      return { ok: false, error, status: response.status };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    emitAdminActionEvent({
      event: "admin.read.error",
      requestId,
      action,
      status: null,
      code: "network-error",
      error,
    });
    logAdminReadError({
      requestId,
      action,
      status: null,
      code: "network-error",
      error,
    });
    if (shouldToastError) {
      deps.toastError(error);
    }
    return { ok: false, error, status: null };
  }
}
