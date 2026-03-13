"use client";

import Link from "next/link";
import { useCallback, startTransition, useEffect, useState } from "react";
import { toast } from "sonner";
import { Tabs } from "@/components/ui/tabs";
import { BrandIcon } from "@/components/ui/brand-icon";
import { StatusPanel } from "@/components/panels/status-panel";
import { FirewallPanel } from "@/components/panels/firewall-panel";
import { ChannelsPanel } from "@/components/panels/channels-panel";
import { SshPanel } from "@/components/panels/ssh-panel";
import { LogsPanel } from "@/components/panels/logs-panel";
import { SnapshotsPanel } from "@/components/panels/snapshots-panel";
import type {
  StatusPayload,
  UnauthorizedPayload,
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
  const [authorizeUrl, setAuthorizeUrl] = useState(
    "/api/auth/authorize?next=/admin",
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status?health=1", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });

      if (response.status === 401) {
        const payload = (await response.json()) as UnauthorizedPayload;
        setStatus(null);
        setAuthorizeUrl(
          payload.authorizeUrl ?? "/api/auth/authorize?next=/admin",
        );
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

  useEffect(() => {
    startTransition(() => {
      void refresh();
    });

    const interval = window.setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  async function requestJson<T>(
    action: string,
    input: RequestInit & { label: string; refreshAfter?: boolean },
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
        const payload = (await response.json()) as UnauthorizedPayload;
        setStatus(null);
        setAuthorizeUrl(payload.authorizeUrl ?? authorizeUrl);
        return null;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(payload?.message ?? `${input.label} failed`);
      }

      const payload = (await response.json().catch(() => null)) as T | null;
      if (input.refreshAfter !== false) {
        await refresh();
      }
      toast.success(input.label);
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
    input: RequestInit & { label: string },
  ): Promise<void> {
    await requestJson(action, input);
  }

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
            firewall controls, and channel entry points behind Vercel auth.
          </p>
          <div className="hero-actions">
            <a className="button primary" href={authorizeUrl}>
              Sign in with Vercel
            </a>
            <Link className="button ghost" href="/api/health">
              Health check
            </Link>
          </div>
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
                <ChannelsPanel
                  status={status}
                  busy={busy}
                  runAction={runAction}
                  requestJson={requestJson}
                  refresh={refresh}
                />
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
