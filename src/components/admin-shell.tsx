"use client";

import Link from "next/link";
import { useCallback, startTransition, useEffect, useState } from "react";
import { toast } from "sonner";
import { Tabs } from "@/components/ui/tabs";
import { BrandIcon } from "@/components/ui/brand-icon";
import { StatusPanel } from "@/components/panels/status-panel";
import { FirewallPanel } from "@/components/panels/firewall-panel";
import { ChannelsPanel } from "@/components/panels/channels-panel";
import { LaunchPanel } from "@/components/panels/launch-panel";
import { SshPanel } from "@/components/panels/ssh-panel";
import { LogsPanel } from "@/components/panels/logs-panel";
import { SnapshotsPanel } from "@/components/panels/snapshots-panel";
import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import type {
  StatusPayload,
} from "@/components/admin-types";

const TABS = [
  { id: "status", label: "Status" },
  { id: "firewall", label: "Firewall" },
  { id: "channels", label: "Channels" },
  { id: "terminal", label: "Terminal" },
  { id: "logs", label: "Logs" },
  { id: "snapshots", label: "Snapshots" },
] as const;

const CHECK_HEALTH_PENDING_ACTION = "Check health";
const TRANSITIONAL_STATUSES = new Set([
  "creating",
  "setup",
  "booting",
  "restoring",
]);

export function getStatusRequestPath(health = false): string {
  return health ? "/api/status?health=1" : "/api/status";
}

export function AdminShell({
  initialStatus = null,
}: {
  initialStatus?: StatusPayload | null;
}) {
  const [status, setStatus] = useState<StatusPayload | null>(initialStatus);
  const [statusVersion, setStatusVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [loginSecret, setLoginSecret] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const fetchStatus = useCallback(async ({
    health = false,
    userInitiated = false,
  }: {
    health?: boolean;
    userInitiated?: boolean;
  } = {}) => {
    try {
      const response = await fetch(getStatusRequestPath(health), {
        cache: "no-store",
        headers: { accept: "application/json" },
      });

      if (response.status === 401) {
        setStatus(null);
        return;
      }

      if (!response.ok) {
        throw new Error(`Status request failed with ${response.status}`);
      }

      const payload = (await response.json()) as StatusPayload;
      setStatus(payload);
      setStatusVersion((current) => current + 1);
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException) {
        if (userInitiated) {
          toast.error("Unable to reach the status endpoint");
        }
        return; // Network-level failure; next poll will recover.
      }
      if (userInitiated) {
        toast.error(
          error instanceof Error ? error.message : "Failed to load status",
        );
      }
    }
  }, []);

  const refreshPassive = useCallback(async () => {
    await fetchStatus();
  }, [fetchStatus]);

  const checkHealth = useCallback(async () => {
    setPendingAction(CHECK_HEALTH_PENDING_ACTION);
    try {
      await fetchStatus({ health: true, userInitiated: true });
    } finally {
      setPendingAction((current) =>
        current === CHECK_HEALTH_PENDING_ACTION ? null : current,
      );
    }
  }, [fetchStatus]);

  const ingestFirewallLearning = useCallback(async () => {
    try {
      const response = await fetch("/api/firewall/ingest", {
        method: "POST",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
      });

      if (response.status === 401) {
        setStatus(null);
      }
    } catch {
      // Best-effort background ingest; status refresh below handles visible errors.
    }
  }, []);

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
    input: RequestInit & { label: string; successMessage?: string; refreshAfter?: boolean },
  ): Promise<T | null> {
    setPendingAction(input.label);
    try {
      const response = await fetch(action, {
        ...input,
        headers: {
          accept: "application/json",
          ...(input.headers ?? {}),
        },
      });

      if (response.status === 401) {
        setStatus(null);
        return null;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | JsonRouteErrorPayload
          | null;

        throw new Error(
          buildJsonRouteErrorMessage(payload, `${input.label} failed`),
        );
      }

      const payload = (await response.json().catch(() => null)) as T | null;
      if (input.refreshAfter !== false) {
        await refreshPassive();
      }
      toast.success(input.successMessage ?? input.label);
      return payload;
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : `${input.label} failed`;
      toast.error(message);
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  async function runAction(
    action: string,
    input: RequestInit & { label: string; successMessage?: string },
  ): Promise<void> {
    await requestJson(action, input);
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
                    statusVersion={statusVersion}
                    busy={busy}
                    pendingAction={pendingAction}
                    runAction={runAction}
                    checkHealth={checkHealth}
                  />
                </section>
              )}
              {isMounted("firewall") && (
                <section {...getPanelProps("firewall")}>
                  <FirewallPanel
                    active={activeTab === "firewall"}
                    status={status}
                    busy={busy}
                    runAction={runAction}
                    requestJson={requestJson}
                    refresh={refreshPassive}
                  />
                </section>
              )}
              {isMounted("channels") && (
                <section {...getPanelProps("channels")}>
                  <div className="tab-panel-stack">
                    <ChannelsPanel
                      active={activeTab === "channels"}
                      status={status}
                      busy={busy}
                      runAction={runAction}
                      requestJson={requestJson}
                      refresh={refreshPassive}
                    />
                    <LaunchPanel
                      status={status}
                      busy={busy}
                      requestJson={requestJson}
                    />
                  </div>
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
                  <LogsPanel active={activeTab === "logs"} status={status} />
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
