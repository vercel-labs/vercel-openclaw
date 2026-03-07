import { useMemo, useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";

type BlockTestResult = {
  allowed: boolean;
  reason: string;
  domain: string;
  mode: string;
};

type FirewallPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function FirewallPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: FirewallPanelProps) {
  const [domainInput, setDomainInput] = useState("");
  const [testDomain, setTestDomain] = useState("");
  const [testResult, setTestResult] = useState<BlockTestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const { confirm: confirmPromote, dialogProps: promoteDialogProps } = useConfirm();
  const { confirm: confirmRemove, dialogProps: removeDialogProps } = useConfirm();

  const sortedEvents = useMemo(
    () => status.firewall.events.slice(0, 8),
    [status.firewall.events],
  );

  async function handleBlockTest(): Promise<void> {
    const domain = testDomain.trim();
    if (!domain) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await requestJson<BlockTestResult>("/api/firewall/test", {
        label: "Test domain",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
        refreshAfter: false,
      });
      if (result) {
        setTestResult(result);
      }
    } finally {
      setTestLoading(false);
    }
  }

  async function submitAllowlist(): Promise<void> {
    const domains = domainInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (domains.length === 0) return;

    await runAction("/api/firewall/allowlist", {
      label: "Approve domains",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains }),
    });
    setDomainInput("");
  }

  return (
    <>
      <div className="panel-grid">
        <article className="panel-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Firewall</p>
              <h2>Firewall policy.</h2>
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
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ mode }),
                    })
                  }
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="stack" style={{ marginTop: 16 }}>
            <span className="field-label">Block test</span>
            <div className="channel-token-row">
              <input
                className="text-input"
                type="text"
                placeholder="example.com"
                value={testDomain}
                onChange={(event) => {
                  setTestDomain(event.target.value);
                  setTestResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleBlockTest();
                  }
                }}
              />
              <button
                className="button secondary"
                disabled={busy || testLoading || !testDomain.trim()}
                onClick={() => void handleBlockTest()}
              >
                {testLoading ? "Testing..." : "Test"}
              </button>
            </div>
            {testResult ? (
              <p
                className={testResult.allowed ? "success-copy" : "error-banner"}
                style={testResult.allowed ? undefined : { marginTop: 0 }}
              >
                {testResult.allowed ? "Allowed" : "Blocked"} &mdash;{" "}
                {testResult.reason}
              </p>
            ) : null}
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
                  void (async () => {
                    const ok = await confirmPromote({
                      title: "Promote learned domains?",
                      description:
                        "This will add all learned domains to the allowlist and switch the firewall to enforcing mode. Only approved domains will be reachable.",
                      confirmLabel: "Promote & enforce",
                      variant: "danger",
                    });
                    if (!ok) return;
                    void runAction("/api/firewall/promote", {
                      label: "Promote learned domains",
                      method: "POST",
                    });
                  })()
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
                          void (async () => {
                            const ok = await confirmRemove({
                              title: `Remove ${domain}?`,
                              description:
                                "This domain will be removed from the allowlist. If the firewall is enforcing, outbound traffic to this domain will be blocked.",
                              confirmLabel: "Remove",
                              variant: "danger",
                            });
                            if (!ok) return;
                            void runAction("/api/firewall/allowlist", {
                              label: `Remove ${domain}`,
                              method: "DELETE",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ domains: [domain] }),
                            });
                          })()
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
              <h2>Observed activity.</h2>
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
                      {event.domain ? ` \u00b7 ${event.domain}` : ""}
                    </p>
                    <p className="event-meta">
                      {formatTimestamp(event.timestamp)}
                      {event.source ? ` \u00b7 ${event.source}` : ""}
                    </p>
                  </div>
                  <span className={`event-badge ${event.decision}`}>
                    {event.decision}
                  </span>
                </li>
              ))
            )}
          </ul>
        </article>
      </div>

      <ConfirmDialog {...promoteDialogProps} />
      <ConfirmDialog {...removeDialogProps} />
    </>
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
