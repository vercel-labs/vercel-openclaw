"use client";

import Link from "next/link";
import { useCallback, startTransition, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Tabs } from "@/components/ui/tabs";
import { BrandIcon } from "@/components/ui/brand-icon";
import { StatusPanel } from "@/components/panels/status-panel";
import { FirewallPanel } from "@/components/panels/firewall-panel";
import { ChannelsPanel } from "@/components/panels/channels-panel";
import { SshPanel } from "@/components/panels/ssh-panel";
import { LogsPanel } from "@/components/panels/logs-panel";
import { SnapshotsPanel } from "@/components/panels/snapshots-panel";
import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import {
  LIVE_CONFIG_SYNC_OUTCOME_HEADER,
  LIVE_CONFIG_SYNC_MESSAGE_HEADER,
} from "@/shared/live-config-sync";
import type {
  StatusPayload,
  ActionResult,
  AdminActionEvent,
  LiveConfigSyncPayload,
} from "@/components/admin-types";
import {
  fetchAdminJsonCore,
  type ReadJsonDeps,
} from "@/components/admin-request-core";

// Verification stays inside the Channels surface.
// Do not add a separate launch/verification tab or card.
const TABS = [
  { id: "status", label: "Status" },
  { id: "firewall", label: "Firewall" },
  { id: "channels", label: "Channels" },
  { id: "terminal", label: "Terminal" },
  { id: "logs", label: "Logs" },
  { id: "snapshots", label: "Snapshots" },
] as const;

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

const TRANSITIONAL_STATUSES = new Set([
  "creating",
  "setup",
  "booting",
  "restoring",
]);

export function AdminShell({
  initialStatus = null,
}: {
  initialStatus?: StatusPayload | null;
}) {
  const [status, setStatus] = useState<StatusPayload | null>(initialStatus);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [loginSecret, setLoginSecret] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const readDeps = useMemo<ReadJsonDeps>(
    () => ({
      setStatus: () => setStatus(null),
      toastError: (message) => toast.error(message),
    }),
    [],
  );

  const fetchStatus = useCallback(async () => {
    const result = await fetchAdminJsonCore<StatusPayload>(
      "/api/status",
      readDeps,
    );
    if (result.ok) {
      setStatus(result.data);
    }
  }, [readDeps]);

  const refreshPassive = useCallback(async () => {
    await fetchStatus();
  }, [fetchStatus]);

  const ingestFirewallLearning = useCallback(async () => {
    await requestJsonCore<null>(
      "/api/firewall/ingest",
      {
        label: "Ingest firewall learning",
        method: "POST",
        refreshAfter: false,
        toastSuccess: false,
        toastError: false,
        trackPending: false,
      },
      {
        setPendingAction,
        setStatus: () => setStatus(null),
        refreshPassive,
        toastSuccess: (message) => toast.success(message),
        toastError: (message) => toast.error(message),
      },
    );
  }, [refreshPassive, setPendingAction]);

  const shouldPollFirewallIngest =
    status?.firewall.mode === "learning" && status.status === "running";

  const pollStatus = useCallback(async () => {
    if (shouldPollFirewallIngest) {
      await ingestFirewallLearning();
    }

    await refreshPassive();
  }, [ingestFirewallLearning, refreshPassive, shouldPollFirewallIngest]);

  useEffect(() => {
    startTransition(() => {
      void pollStatus();
    });

    const pollIntervalMs = status && TRANSITIONAL_STATUSES.has(status.status)
      ? 2000
      : 5000;
    const interval = window.setInterval(() => {
      void pollStatus();
    }, pollIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [pollStatus, status]);

  async function requestJson<T>(
    action: string,
    input: RequestInit & { label: string; refreshAfter?: boolean },
  ): Promise<ActionResult<T>> {
    return requestJsonCore<T>(action, { ...input, toastSuccess: false }, {
      setPendingAction,
      setStatus: () => setStatus(null),
      refreshPassive,
      toastSuccess: () => {},
      toastError: (msg) => toast.error(msg),
    });
  }

  async function runAction(
    action: string,
    input: RequestInit & { label: string },
  ): Promise<boolean> {
    const result = await requestJson(action, input);
    return result.ok;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const secret = loginSecret.trim();
    if (!secret) return;

    setLoginBusy(true);
    setLoginError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ secret }),
      });

      if (response.ok) {
        setLoginSecret("");
        await refreshPassive();
      } else {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        setLoginError(body?.message ?? "Invalid admin secret.");
      }
    } catch {
      setLoginError("Network error. Please try again.");
    } finally {
      setLoginBusy(false);
    }
  };

  if (!status) {
    return (
      <main className="shell">
        <section className="hero-card">
          <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <BrandIcon size={40} />
            VClaw Sandbox
          </h1>
          <p className="lede">
            Manage one persistent VClaw sandbox with on-demand restore,
            firewall controls, and channel entry points behind admin auth.
          </p>
          <form onSubmit={handleLogin} className="login-form" autoComplete="off">
            <div className="login-field">
              <label className="field-label" htmlFor="admin-secret">
                Admin secret
              </label>
              <input
                id="admin-secret"
                className="text-input"
                type="password"
                placeholder="Paste admin secret"
                value={loginSecret}
                onChange={(e) => { setLoginSecret(e.target.value); setLoginError(null); }}
                disabled={loginBusy}
                autoFocus
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
            </div>
            {loginError && <p className="login-error">{loginError}</p>}
            <div className="hero-actions">
              <button className="button primary" type="submit" disabled={loginBusy || !loginSecret.trim()}>
                {loginBusy ? "Signing in\u2026" : "Sign in"}
              </button>
              <Link className="button ghost" href="/api/health">
                Health check
              </Link>
            </div>
            <p className="muted-copy">
              Enter the admin secret configured for this deployment.
            </p>
          </form>
        </section>
      </main>
    );
  }

  const busy = pendingAction !== null;

  return (
    <main className="shell">
      <section className="hero-card">
        <div className="hero-header">
          <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <BrandIcon size={40} />
            VClaw Sandbox
          </h1>
          <div className="auth-chip">
            <span>
              {status.user?.name ?? status.user?.email ?? "Protected viewer"}
            </span>
            <a href="/api/auth/signout">Sign out</a>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <Tabs tabs={[...TABS]} defaultTab="status" ariaLabel="Admin panels">
          {({ activeTab, isMounted, getPanelProps }) => (
            <>
              {isMounted("status") && (
                <section {...getPanelProps("status")}>
                  <StatusPanel
                    status={status}
                    busy={busy}
                    pendingAction={pendingAction}
                    runAction={runAction}
                  />
                </section>
              )}
              {isMounted("firewall") && (
                <section {...getPanelProps("firewall")}>
                  <FirewallPanel
                    active={activeTab === "firewall"}
                    status={status}
                    busy={busy}
                    requestJson={requestJson}
                    refresh={refreshPassive}
                    readDeps={readDeps}
                  />
                </section>
              )}
              {isMounted("channels") && (
                <section {...getPanelProps("channels")}>
                  <ChannelsPanel
                    active={activeTab === "channels"}
                    status={status}
                    busy={busy}
                    runAction={runAction}
                    requestJson={requestJson}
                    refresh={refreshPassive}
                  />
                </section>
              )}
              {isMounted("terminal") && (
                <section {...getPanelProps("terminal")}>
                  <SshPanel
                    status={status}
                    busy={busy}
                    requestJson={requestJson}
                  />
                </section>
              )}
              {isMounted("logs") && (
                <section {...getPanelProps("logs")}>
                  <LogsPanel active={activeTab === "logs"} status={status} readDeps={readDeps} />
                </section>
              )}
              {isMounted("snapshots") && (
                <section {...getPanelProps("snapshots")}>
                  <SnapshotsPanel
                    active={activeTab === "snapshots"}
                    status={status}
                    busy={busy}
                    runAction={runAction}
                    requestJson={requestJson}
                    readDeps={readDeps}
                  />
                </section>
              )}
            </>
          )}
        </Tabs>
      </section>
    </main>
  );
}
