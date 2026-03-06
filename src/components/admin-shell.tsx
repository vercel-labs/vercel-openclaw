"use client";

import Link from "next/link";
import {
  useCallback,
  startTransition,
  useEffect,
  useMemo,
  useState,
} from "react";

type LearnedDomain = {
  domain: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
};

type FirewallEvent = {
  id: string;
  timestamp: number;
  action: string;
  decision: string;
  domain?: string;
  reason?: string;
  source?: string;
};

type StatusPayload = {
  authMode: "deployment-protection" | "sign-in-with-vercel";
  storeBackend: string;
  persistentStore: boolean;
  status: string;
  sandboxId: string | null;
  snapshotId: string | null;
  gatewayReady: boolean;
  gatewayUrl: string;
  lastError: string | null;
  firewall: {
    mode: "disabled" | "learning" | "enforcing";
    allowlist: string[];
    learned: LearnedDomain[];
    events: FirewallEvent[];
    updatedAt: number;
  };
  user: {
    sub: string;
    email?: string;
    name?: string;
    preferredUsername?: string;
  } | null;
};

type UnauthorizedPayload = {
  authorizeUrl?: string;
  error: string;
  message: string;
};

export function AdminShell() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState("/api/auth/authorize?next=/admin");
  const [error, setError] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status?health=1", {
        cache: "no-store",
        headers: {
          accept: "application/json",
        },
      });

      if (response.status === 401) {
        const payload = (await response.json()) as UnauthorizedPayload;
        setStatus(null);
        setAuthorizeUrl(payload.authorizeUrl ?? "/api/auth/authorize?next=/admin");
        setError(null);
        return;
      }

      if (!response.ok) {
        throw new Error(`Status request failed with ${response.status}`);
      }

      const payload = (await response.json()) as StatusPayload;
      setStatus(payload);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load status");
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

  const sortedEvents = useMemo(() => status?.firewall.events.slice(0, 8) ?? [], [status]);

  async function runAction(
    action: string,
    input: RequestInit & { label: string },
  ): Promise<void> {
    setPendingAction(input.label);
    setError(null);
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
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(payload?.message ?? `${input.label} failed`);
      }

      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `${input.label} failed`);
    } finally {
      setPendingAction(null);
    }
  }

  async function submitAllowlist(): Promise<void> {
    const domains = domainInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (domains.length === 0) {
      return;
    }

    await runAction("/api/firewall/allowlist", {
      label: "Approve domains",
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ domains }),
    });
    setDomainInput("");
  }

  if (!status) {
    return (
      <main className="shell">
        <section className="hero-card">
          <p className="eyebrow">OpenClaw Single</p>
          <h1>One sandbox. One gateway. One tight control loop.</h1>
          <p className="lede">
            This app keeps a single OpenClaw sandbox behind Vercel auth, restores it on
            demand, and can move from learning to enforcing network egress.
          </p>
          <div className="hero-actions">
            <a className="button primary" href={authorizeUrl}>
              Sign in with Vercel
            </a>
            <Link className="button ghost" href="/api/health">
              Health
            </Link>
          </div>
          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      </main>
    );
  }

  const busy = pendingAction !== null;

  return (
    <main className="shell">
      <section className="hero-card">
        <div className="hero-header">
          <div>
            <p className="eyebrow">OpenClaw Single</p>
            <h1>Persistent OpenClaw on one Vercel Sandbox.</h1>
          </div>
          <div className="auth-chip">
            <span>{status.user?.name ?? status.user?.email ?? "Protected viewer"}</span>
            <a href="/api/auth/signout">Sign out</a>
          </div>
        </div>
        <p className="lede">
          Auth mode: <strong>{status.authMode}</strong>. Store backend:{" "}
          <strong>{status.storeBackend}</strong>. Current status:{" "}
          <strong>{status.status}</strong>
          {status.gatewayReady ? " (gateway ready)" : ""}.
        </p>
        <div className="hero-actions">
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void runAction("/api/admin/ensure", {
                label: "Ensure sandbox",
                method: "POST",
              })
            }
          >
            {status.status === "running" ? "Refresh ensure" : "Ensure running"}
          </button>
          <a className="button accent" href={status.gatewayUrl} target="_blank" rel="noreferrer">
            Open gateway
          </a>
          <button
            className="button ghost"
            disabled={busy}
            onClick={() =>
              void runAction("/api/admin/stop", {
                label: "Stop sandbox",
                method: "POST",
              })
            }
          >
            Snapshot and stop
          </button>
          <button
            className="button ghost"
            disabled={busy}
            onClick={() =>
              void runAction("/api/admin/snapshot", {
                label: "Take snapshot",
                method: "POST",
              })
            }
          >
            Snapshot now
          </button>
        </div>
        <dl className="metrics-grid">
          <div>
            <dt>Sandbox</dt>
            <dd>{status.sandboxId ?? "none"}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>{status.snapshotId ?? "none"}</dd>
          </div>
          <div>
            <dt>Persistence</dt>
            <dd>{status.persistentStore ? "persistent" : "memory only"}</dd>
          </div>
          <div>
            <dt>Firewall</dt>
            <dd>{status.firewall.mode}</dd>
          </div>
        </dl>
        {error ? <p className="error-banner">{error}</p> : null}
        {status.lastError ? <p className="error-banner">{status.lastError}</p> : null}
      </section>

      <section className="panel-grid">
        <article className="panel-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Firewall</p>
              <h2>Move from learning to enforcing.</h2>
            </div>
            <div className="mode-pills">
              {(["disabled", "learning", "enforcing"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`pill ${status.firewall.mode === mode ? "active" : ""}`}
                  disabled={busy}
                  onClick={() =>
                    void runAction("/api/firewall", {
                      label: `Set mode ${mode}`,
                      method: "PUT",
                      headers: {
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({ mode }),
                    })
                  }
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="stack">
            <label className="stack">
              <span className="field-label">Approve domains</span>
              <textarea
                className="text-input"
                rows={3}
                placeholder="api.openai.com, github.com"
                value={domainInput}
                onChange={(event) => setDomainInput(event.target.value)}
              />
            </label>
            <div className="inline-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void submitAllowlist()}
              >
                Add to allowlist
              </button>
              <button
                className="button ghost"
                disabled={busy || status.firewall.learned.length === 0}
                onClick={() =>
                  void runAction("/api/firewall/promote", {
                    label: "Promote learned domains",
                    method: "POST",
                  })
                }
              >
                Promote learned to enforcing
              </button>
            </div>
          </div>

          <div className="split-lists">
            <div>
              <h3>Allowlist</h3>
              <ul className="token-list">
                {status.firewall.allowlist.length === 0 ? (
                  <li className="empty-token">No approved domains yet.</li>
                ) : (
                  status.firewall.allowlist.map((domain) => (
                    <li key={domain}>
                      <code>{domain}</code>
                      <button
                        className="tiny-link"
                        disabled={busy}
                        onClick={() =>
                          void runAction("/api/firewall/allowlist", {
                            label: `Remove ${domain}`,
                            method: "DELETE",
                            headers: {
                              "content-type": "application/json",
                            },
                            body: JSON.stringify({ domains: [domain] }),
                          })
                        }
                      >
                        remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div>
              <h3>Learned</h3>
              <ul className="token-list">
                {status.firewall.learned.length === 0 ? (
                  <li className="empty-token">No learned domains yet.</li>
                ) : (
                  status.firewall.learned.map((entry) => (
                    <li key={entry.domain}>
                      <code>{entry.domain}</code>
                      <span className="muted-copy">{entry.hitCount} hits</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Recent events</p>
              <h2>Observed firewall activity.</h2>
            </div>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>

          <ul className="event-list">
            {sortedEvents.length === 0 ? (
              <li className="event-empty">No firewall events yet.</li>
            ) : (
              sortedEvents.map((event) => (
                <li key={event.id} className="event-row">
                  <div>
                    <p className="event-title">
                      {event.action}
                      {event.domain ? ` · ${event.domain}` : ""}
                    </p>
                    <p className="event-meta">
                      {formatTimestamp(event.timestamp)}
                      {event.source ? ` · ${event.source}` : ""}
                    </p>
                  </div>
                  <span className={`event-badge ${event.decision}`}>{event.decision}</span>
                </li>
              ))
            )}
          </ul>
        </article>
      </section>
    </main>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}
