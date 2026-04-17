/**
 * Shared admin mutation (non-GET) helper and action-event plumbing.
 *
 * Centralises request id minting, CustomEvent dispatch, CSRF header
 * injection, 401 handling, and live-config-sync detection so the
 * root admin UI (`designs/command-shell`), the read helper in
 * `admin-request-core`, and any future admin client surface share
 * one implementation.
 */

import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import {
  LIVE_CONFIG_SYNC_OUTCOME_HEADER,
  LIVE_CONFIG_SYNC_MESSAGE_HEADER,
} from "@/shared/live-config-sync";
import type {
  ActionResult,
  AdminActionEvent,
  LiveConfigSyncPayload,
} from "@/components/admin-types";

export function createAdminActionRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `admin-${crypto.randomUUID()}`;
  }
  return `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type AdminActionEventInput = {
  [K in AdminActionEvent["event"]]: Omit<
    Extract<AdminActionEvent, { event: K }>,
    "source" | "ts"
  >;
}[AdminActionEvent["event"]];

export function emitAdminActionEvent(event: AdminActionEventInput): void {
  const payload = {
    source: "admin-shell" as const,
    ts: new Date().toISOString(),
    ...event,
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("openclaw:admin-action", { detail: payload }),
    );
  }
}

export type RequestJsonDeps = {
  setPendingAction: (label: string | null) => void;
  setStatus: (status: null) => void;
  refreshPassive: () => Promise<void>;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
  fetchFn?: typeof fetch;
};

function extractLiveConfigSync(
  payload: unknown,
): LiveConfigSyncPayload | null {
  if (
    payload != null &&
    typeof payload === "object" &&
    "liveConfigSync" in payload
  ) {
    const sync = (payload as Record<string, unknown>).liveConfigSync;
    if (
      sync != null &&
      typeof sync === "object" &&
      "outcome" in sync &&
      typeof (sync as Record<string, unknown>).outcome === "string"
    ) {
      return sync as LiveConfigSyncPayload;
    }
  }
  return null;
}

export type RequestJsonInput = RequestInit & {
  label: string;
  refreshAfter?: boolean;
  toastSuccess?: boolean;
  toastError?: boolean;
  trackPending?: boolean;
};

export async function requestJsonCore<T>(
  action: string,
  input: RequestJsonInput,
  deps: RequestJsonDeps,
): Promise<ActionResult<T>> {
  const requestId = createAdminActionRequestId();
  const refreshAfter = input.refreshAfter !== false;
  const shouldToastSuccess = input.toastSuccess !== false;
  const shouldToastError = input.toastError !== false;
  const trackPending = input.trackPending !== false;
  const method =
    typeof input.method === "string" && input.method.trim().length > 0
      ? input.method.toUpperCase()
      : "GET";
  const doFetch = deps.fetchFn ?? fetch;

  if (trackPending) {
    deps.setPendingAction(input.label);
  }
  emitAdminActionEvent({
    event: "admin.action.start",
    requestId,
    action,
    label: input.label,
    method,
    refreshAfter,
  });

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(input.headers as Record<string, string> ?? {}),
    };
    if (
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS" &&
      !headers["x-requested-with"]
    ) {
      headers["x-requested-with"] = "XMLHttpRequest";
    }
    const response = await doFetch(action, {
      ...input,
      headers,
    });

    if (response.status === 401) {
      deps.setStatus(null);
      const result: ActionResult<T> = {
        ok: false,
        error: "Session expired. Sign in again.",
        meta: {
          requestId,
          action,
          label: input.label,
          status: 401,
          code: "unauthorized",
          retryable: false,
        },
      };
      emitAdminActionEvent({
        event: "admin.action.error",
        ...result.meta,
        error: result.error,
      });
      if (shouldToastError) {
        deps.toastError(result.error);
      }
      return result;
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | JsonRouteErrorPayload
        | null;

      const message = buildJsonRouteErrorMessage(payload, `${input.label} failed`);
      const result: ActionResult<T> = {
        ok: false,
        error: message,
        meta: {
          requestId,
          action,
          label: input.label,
          status: response.status,
          code: "http-error",
          retryable: response.status >= 500,
        },
      };
      emitAdminActionEvent({
        event: "admin.action.error",
        ...result.meta,
        error: result.error,
      });
      if (shouldToastError) {
        deps.toastError(message);
      }
      return result;
    }

    const payload = (await response.json().catch(() => null)) as T | null;

    // Detect degraded/failed live config sync from response body or headers
    const bodySync = extractLiveConfigSync(payload);
    const headerOutcome = response.headers.get(LIVE_CONFIG_SYNC_OUTCOME_HEADER);
    const headerMessage = response.headers.get(LIVE_CONFIG_SYNC_MESSAGE_HEADER);

    // Prefer structured body payload; fall back to headers for backward compat
    const syncOutcome = bodySync?.outcome ?? headerOutcome;
    const syncMessage = bodySync?.operatorMessage ?? headerMessage;
    const hasSyncWarning = syncOutcome === "degraded" || syncOutcome === "failed";

    if (refreshAfter || hasSyncWarning) {
      await deps.refreshPassive();
    }
    const result: ActionResult<T> = {
      ok: true,
      data: payload,
      meta: {
        requestId,
        action,
        label: input.label,
        status: response.status,
        refreshed: refreshAfter || hasSyncWarning,
        liveConfigSync: bodySync ?? undefined,
      },
    };
    emitAdminActionEvent({
      event: "admin.action.success",
      ...result.meta,
    });
    if (hasSyncWarning) {
      emitAdminActionEvent({
        event: "admin.action.live-config-warning",
        requestId,
        action,
        label: input.label,
        status: response.status,
        outcome: syncOutcome!,
        reason: bodySync?.reason ?? null,
      });
      if (syncMessage && shouldToastError) {
        deps.toastError(syncMessage);
      }
    } else if (shouldToastSuccess) {
      deps.toastSuccess(input.label);
    }
    return result;
  } catch (nextError) {
    const message =
      nextError instanceof Error
        ? nextError.message
        : `${input.label} failed`;
    const result: ActionResult<T> = {
      ok: false,
      error: message,
      meta: {
        requestId,
        action,
        label: input.label,
        status: null,
        code: "network-error",
        retryable: true,
      },
    };
    emitAdminActionEvent({
      event: "admin.action.error",
      ...result.meta,
      error: result.error,
    });
    if (shouldToastError) {
      deps.toastError(message);
    }
    return result;
  } finally {
    if (trackPending) {
      deps.setPendingAction(null);
    }
  }
}
