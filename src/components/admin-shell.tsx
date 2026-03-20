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
import { ChannelQueueHealthCard } from "@/components/panels/channel-queue-health-card";
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

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status?health=1", {
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
    } catch (nextError) {
      toast.error(
        nextError instanceof Error
          ? nextError.message
          : "Failed to load status",
      );
    }
  }, []);

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

    await refresh();
  }, [ingestFirewallLearning, refresh, shouldPollFirewallIngest]);

  useEffect(() => {
    startTransition(() => {
      void pollStatus();
    });

    const interval = window.setInterval(() => {
      void pollStatus();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [pollStatus]);

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
        await refresh();
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
        await refresh();
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
        <Tabs tabs={[...TABS]} defaultTab="status">
          {(activeTab) => (
            <>
              {activeTab === "status" && (
                <StatusPanel
                  status={status}
                  busy={busy}
                  pendingAction={pendingAction}
                  runAction={runAction}
                />
              )}
              {activeTab === "firewall" && (
                <FirewallPanel
                  status={status}
                  busy={busy}
                  runAction={runAction}
                  requestJson={requestJson}
                  refresh={refresh}
                />
              )}
              {activeTab === "channels" && (
                <>
                  <ChannelsPanel
                    status={status}
                    busy={busy}
                    runAction={runAction}
                    requestJson={requestJson}
                    refresh={refresh}
                  />
                  <ChannelQueueHealthCard />
                  <LaunchPanel
                    status={status}
                    busy={busy}
                    requestJson={requestJson}
                  />
                </>
              )}
              {activeTab === "terminal" && (
                <SshPanel
                  status={status}
                  busy={busy}
                  requestJson={requestJson}
                />
              )}
              {activeTab === "logs" && (
                <LogsPanel status={status} />
              )}
              {activeTab === "snapshots" && (
                <SnapshotsPanel
                  status={status}
                  busy={busy}
                  runAction={runAction}
                  requestJson={requestJson}
                />
              )}
            </>
          )}
        </Tabs>
      </section>
    </main>
  );
}
