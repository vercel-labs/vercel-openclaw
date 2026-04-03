import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  StatusPayload,
  RequestJson,
  LearnedDomain,
  FirewallReportPayload,
} from "@/components/admin-types";
import type { LogEntry, LogLevel } from "@/shared/types";
import { fetchAdminJsonCore, type ReadJsonDeps } from "@/components/admin-request-core";
import { DOMAIN_PRESETS } from "@/shared/types";
import {
  computeEventCategoryCounts,
  filterEventsByCategory,
  isZeroMatchFilter,
  computePageCount,
  clampPage,
  paginateItems,
} from "./firewall-panel.helpers";

type BlockTestResult = {
  allowed: boolean;
  reason: string;
  domain: string;
  mode: string;
};

type FirewallPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
  readDeps: ReadJsonDeps;
};

export function FirewallPanel({
  active,
  status,
  busy,
  requestJson,
  refresh,
  readDeps,
}: FirewallPanelProps) {
  const [domainInput, setDomainInput] = useState("");
  const [testDomain, setTestDomain] = useState("");
  const [testResult, setTestResult] = useState<BlockTestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [learnedSearch, setLearnedSearch] = useState("");
  const [wouldBlockOpen, setWouldBlockOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [firewallLogs, setFirewallLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [eventPage, setEventPage] = useState(0);
  const [eventCategoryFilter, setEventCategoryFilter] = useState<string | null>(null);
  const [report, setReport] = useState<FirewallReportPayload | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [firewallLogsError, setFirewallLogsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncIndicator, setSyncIndicator] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [limitationsOpen, setLimitationsOpen] = useState(false);
  const { confirm: confirmPromote, dialogProps: promoteDialogProps } = useConfirm();
  const { confirm: confirmRemove, dialogProps: removeDialogProps } = useConfirm();
  const { confirm: confirmDismiss, dialogProps: dismissDialogProps } = useConfirm();

  const fetchReport = useCallback(async () => {
    if (!active) return;
    const result = await fetchAdminJsonCore<FirewallReportPayload>(
      "/api/firewall/report",
      readDeps,
      { toastError: false },
    );
    if (result.ok) {
      setReport(result.data);
      setReportError(null);
      return;
    }
    setReportError(result.error);
  }, [active, readDeps, report]);

  // Fetch report alongside status refreshes
  useEffect(() => {
    if (!active) return;
    void fetchReport();
  }, [active, status.firewall.updatedAt, fetchReport]);

  // Derive firewall data from report when available, fall back to status
  const fw = report?.state ?? status.firewall;
  const diagnostics = report?.diagnostics ?? null;
  const groupedLearned = report?.groupedLearned ?? null;

  const fetchFirewallLogs = useCallback(async () => {
    if (!active) return;
    setLogsLoading(true);
    try {
      const result = await fetchAdminJsonCore<{ logs: LogEntry[] }>(
        "/api/admin/logs?source=firewall",
        readDeps,
        { toastError: false },
      );
      if (result.ok) {
        setFirewallLogs(result.data.logs);
        setFirewallLogsError(null);
        return;
      }
      setFirewallLogsError(result.error);
    } finally {
      setLogsLoading(false);
    }
  }, [active, readDeps, firewallLogs.length]);

  // Fetch firewall logs when section is opened and on each refresh cycle
  useEffect(() => {
    if (!active) return;
    if (logsOpen) {
      void fetchFirewallLogs();
    }
  }, [active, logsOpen, status.firewall.updatedAt, fetchFirewallLogs]);

  const eventCategoryCounts = useMemo(
    () => computeEventCategoryCounts(fw.events),
    [fw.events],
  );

  const filteredEvents = useMemo(
    () => filterEventsByCategory(fw.events, eventCategoryFilter),
    [fw.events, eventCategoryFilter],
  );

  const eventPageCount = computePageCount(filteredEvents.length);
  const clampedPage = clampPage(eventPage, eventPageCount);
  const paginatedEvents = paginateItems(filteredEvents, clampedPage);

  const filteredLearned = useMemo(() => {
    const query = learnedSearch.trim().toLowerCase();
    if (!query) return fw.learned;
    return fw.learned.filter(
      (entry) =>
        entry.domain.toLowerCase().includes(query) ||
        (entry.categories ?? []).some((c) => c.toLowerCase().includes(query)),
    );
  }, [fw.learned, learnedSearch]);

  // Use server-grouped data when available, else fall back to client-side grouping
  const learnedGroups = useMemo(() => {
    if (groupedLearned && !learnedSearch.trim()) {
      return groupedLearned;
    }
    // Client-side grouping for filtered results
    return clientGroupByRegistrableDomain(filteredLearned);
  }, [groupedLearned, filteredLearned, learnedSearch]);

  function toggleGroup(key: string): void {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  /** Wrap a firewall mutation: run the action, then re-fetch report to check sync status. */
  async function runFirewallMutation(
    action: string,
    input: Parameters<RequestJson>[1],
  ): Promise<boolean> {
    setSyncIndicator(null);
    const mutationResult = await requestJson<null>(action, input);
    if (!mutationResult.ok) {
      setSyncIndicator({ ok: false, reason: mutationResult.error });
      return false;
    }
    // Re-fetch report through the shared read helper so auth/error handling is consistent
    const reportResult = await fetchAdminJsonCore<FirewallReportPayload>(
      "/api/firewall/report",
      readDeps,
    );
    if (!reportResult.ok) {
      setSyncIndicator({ ok: false, reason: reportResult.error });
      return false;
    }
    const freshReport = reportResult.data;
    setReport(freshReport);
    const sync = freshReport.diagnostics.syncStatus;
    if (
      sync.lastAppliedAt &&
      (sync.lastFailedAt ?? 0) <= sync.lastAppliedAt
    ) {
      setSyncIndicator({ ok: true });
      return true;
    }
    if (sync.lastFailedAt) {
      setSyncIndicator({
        ok: false,
        reason: sync.lastReason ?? "Policy sync failed",
      });
      return false;
    }
    setSyncIndicator({ ok: true });
    return true;
  }

  async function approveMultipleDomains(domains: string[]): Promise<void> {
    await runFirewallMutation("/api/firewall/allowlist", {
      label: `Approve ${domains.length} domains`,
      successMessage: `${domains.length} domains approved`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains }),
    });
  }

  async function handleBlockTest(): Promise<void> {
    const domain = testDomain.trim();
    if (!domain) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await requestJson<BlockTestResult>("/api/firewall/test", {
        label: "Test domain",
        successMessage: "Domain tested",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
        refreshAfter: false,
      });
      if (result.ok && result.data) {
        setTestResult(result.data);
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

    const ok = await runFirewallMutation("/api/firewall/allowlist", {
      label: "Approve domains",
      successMessage: "Domains approved",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains }),
    });
    if (ok) {
      setDomainInput("");
    }
  }

  async function approveSingleDomain(domain: string): Promise<void> {
    await runFirewallMutation("/api/firewall/allowlist", {
      label: `Approve ${domain}`,
      successMessage: `${domain} approved`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: [domain] }),
    });
  }

  async function dismissSingleDomain(domain: string): Promise<void> {
    const ok = await confirmDismiss({
      title: `Dismiss ${domain}?`,
      description:
        "This domain will be removed from the learned list without being added to the allowlist.",
      confirmLabel: "Dismiss",
      variant: "danger",
    });
    if (!ok) return;
    await runFirewallMutation("/api/firewall/learned", {
      label: `Dismiss ${domain}`,
      successMessage: `${domain} dismissed`,
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: [domain] }),
    });
  }

  // Freshness indicator for learning data
  const learningFreshness = useMemo(() => {
    if (!diagnostics || fw.mode !== "learning") return null;
    const { stalenessMs, lastIngestedAt } = diagnostics.learningHealth;
    if (lastIngestedAt === null) return { label: "no data ingested yet", stale: false };
    if (stalenessMs === null) return null;
    const isStale = stalenessMs > 30_000;
    return {
      label: `last ingested ${formatRelativeTime(lastIngestedAt)}`,
      stale: isStale,
    };
  }, [diagnostics, fw.mode]);

  return (
    <>
      <div className="panel-grid">
        <article className="panel-card">
          <div className="panel-head">
            <div>
              <h2>Firewall policy</h2>
            </div>
            <div className="mode-pills">
              {(["disabled", "learning", "enforcing"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`pill ${fw.mode === mode ? "active" : ""}`}
                  disabled={busy}
                  onClick={() =>
                    void runFirewallMutation("/api/firewall", {
                      label: `Set mode ${mode}`,
                      successMessage: `Firewall set to ${mode}`,
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

          {syncIndicator && (
            <div className={`sync-indicator ${syncIndicator.ok ? "sync-ok" : "sync-fail"}`}>
              <span>{syncIndicator.ok ? "\u2713" : "\u2717"}</span>
              <span className="muted-copy">
                {syncIndicator.ok ? "Policy applied" : `Sync failed${syncIndicator.reason ? `: ${syncIndicator.reason}` : ""}`}
              </span>
            </div>
          )}

          {reportError && (
            <p className="error-banner">
              {report
                ? `Showing last successful firewall report. Latest refresh failed: ${reportError}`
                : `Failed to load firewall report: ${reportError}`}
            </p>
          )}

          {/* Policy hash & last apply — always reserve space to avoid CLS */}
          <div className="policy-meta">
            {report ? (
              <>
                <span className="muted-copy">
                  Policy: <code>{report.policyHash.slice(0, 12)}</code>
                </span>
                {report.lastSync && report.lastSync.applied && (
                  <span className="muted-copy">
                    {" · "}Applied {formatRelativeTime(report.lastSync.timestamp)}
                  </span>
                )}
                {report.lastSync && !report.lastSync.applied && (
                  <span className="muted-copy sync-fail-text">
                    {" · "}Not applied: {report.lastSync.reason}
                  </span>
                )}
              </>
            ) : (
              <span className="muted-copy">&nbsp;</span>
            )}
          </div>

          {fw.mode === "learning" && (
            <div className="learning-status">
              <span className="learning-dot" />
              <span className="muted-copy">
                Learning active
                {fw.learningStartedAt
                  ? ` · ${formatDuration(Date.now() - fw.learningStartedAt)}`
                  : ""}
                {` · ${fw.learned.length} unique domain${fw.learned.length === 1 ? "" : "s"}`}
                {` · ${fw.commandsObserved} command${fw.commandsObserved === 1 ? "" : "s"} observed`}
                {learningFreshness
                  ? ` · ${learningFreshness.label}`
                  : fw.lastIngestedAt
                    ? ` · last ingested ${formatRelativeTime(fw.lastIngestedAt)}`
                    : " · no data ingested yet"}
              </span>
              {learningFreshness?.stale && (
                <span className="staleness-warning" title="Data may be stale — last ingest was more than 30s ago">
                  {" "}⚠
                </span>
              )}
            </div>
          )}

          {fw.mode === "learning" && (
            <p className="learning-disclaimer">
              Shell command observation only — does not capture all network traffic
            </p>
          )}

          {fw.mode === "learning" &&
            diagnostics?.ingestionStatus.lastSkipReason &&
            diagnostics.ingestionStatus.consecutiveSkips > 1 &&
            diagnostics.learningHealth.stalenessMs !== null &&
            diagnostics.learningHealth.stalenessMs > 30_000 && (
            <p className="error-banner" style={{ marginTop: 0 }}>
              Learning may be stuck: {diagnostics.ingestionStatus.consecutiveSkips}{" "}
              consecutive ingest skips (last reason: {diagnostics.ingestionStatus.lastSkipReason})
            </p>
          )}

          {fw.mode === "learning" &&
            fw.learningStartedAt !== null &&
            Date.now() - fw.learningStartedAt < 3_600_000 && (
            <p className="learning-recommendation">
              Consider running learning longer to capture varied usage patterns
            </p>
          )}

          {/* Enforcement preview */}
          {(report?.wouldBlock ?? fw.wouldBlock).length > 0 && (
            <div className="would-block-banner">
              <button
                type="button"
                className="would-block-toggle"
                onClick={() => setWouldBlockOpen((prev) => !prev)}
                aria-expanded={wouldBlockOpen}
              >
                <span>
                  {(report?.wouldBlock ?? fw.wouldBlock).length} domain
                  {(report?.wouldBlock ?? fw.wouldBlock).length === 1 ? "" : "s"} would be
                  blocked if enforcing were enabled
                </span>
                <span
                  className="firewall-logs-chevron"
                  data-open={wouldBlockOpen}
                >
                  &#9656;
                </span>
              </button>
              {wouldBlockOpen && (
                <ul className="would-block-list">
                  {(report?.wouldBlock ?? fw.wouldBlock).map((domain) => (
                    <li key={domain}>
                      <code>{domain}</code>
                      <button
                        className="tiny-link learned-approve"
                        disabled={busy}
                        onClick={() => void approveSingleDomain(domain)}
                        title="Approve to allowlist"
                      >
                        approve
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

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
            <div className="preset-row">
              <span className="field-label">Presets</span>
              <div className="preset-chips">
                {Object.entries(DOMAIN_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    className="ssh-suggestion-chip"
                    disabled={busy}
                    onClick={() => void approveMultipleDomains(preset.domains)}
                    title={preset.domains.join(", ")}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

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
                disabled={busy || fw.learned.length === 0}
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
                    void runFirewallMutation("/api/firewall/promote", {
                      label: "Promote learned domains",
                      successMessage: "Learned domains promoted to enforcing",
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
              <h3>Allowlist ({fw.allowlist.length})</h3>
              <ul className="token-list">
                {fw.allowlist.length === 0 ? (
                  <li className="empty-token">No approved domains yet.</li>
                ) : (
                  fw.allowlist.map((domain) => (
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
                            void runFirewallMutation("/api/firewall/allowlist", {
                              label: `Remove ${domain}`,
                              successMessage: `${domain} removed`,
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
              <h3>Learned ({fw.learned.length})</h3>
              {fw.learned.length > 3 && (
                <input
                  className="text-input learned-search"
                  type="text"
                  placeholder="Filter learned domains…"
                  value={learnedSearch}
                  onChange={(event) => setLearnedSearch(event.target.value)}
                />
              )}
              <div className="domain-groups">
                {fw.learned.length === 0 ? (
                  <p className="empty-token">No learned domains yet.</p>
                ) : filteredLearned.length === 0 ? (
                  <p className="empty-token">No domains match &ldquo;{learnedSearch}&rdquo;.</p>
                ) : (
                  learnedGroups.map((group) => {
                    const isSingle = group.domains.length === 1;
                    const isExpanded = isSingle || expandedGroups.has(group.registrableDomain);

                    if (isSingle) {
                      const entry = group.domains[0];
                      return (
                        <div key={group.registrableDomain} className="domain-group-flat">
                          <div className="domain-group-entry">
                            <div>
                              <code>{entry.domain}</code>
                              <DomainEvidence entry={entry} />
                            </div>
                            <span className="learned-actions">
                              <button
                                className="tiny-link learned-approve"
                                disabled={busy}
                                onClick={() => void approveSingleDomain(entry.domain)}
                                title="Approve to allowlist"
                              >
                                approve
                              </button>
                              <button
                                className="tiny-link"
                                disabled={busy}
                                onClick={() => void dismissSingleDomain(entry.domain)}
                                title="Dismiss without approving"
                              >
                                dismiss
                              </button>
                            </span>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={group.registrableDomain} className="domain-group">
                        <div className="domain-group-header">
                          <button
                            type="button"
                            className="domain-group-header-left"
                            onClick={() => toggleGroup(group.registrableDomain)}
                            aria-expanded={isExpanded}
                          >
                            <span
                              className="domain-group-chevron"
                              data-open={isExpanded}
                            >
                              &#9656;
                            </span>
                            <code>{group.registrableDomain}</code>
                            <span className="domain-group-count">
                              {group.domains.length}
                            </span>
                          </button>
                          <button
                            className="tiny-link learned-approve"
                            disabled={busy}
                            onClick={() => {
                              void approveMultipleDomains(
                                group.domains.map((d) => d.domain),
                              );
                            }}
                            title={`Approve all ${group.domains.length} domains in ${group.registrableDomain}`}
                          >
                            approve all
                          </button>
                        </div>
                        {isExpanded && (
                          <ul className="domain-group-list">
                            {group.domains.map((entry) => (
                              <li key={entry.domain} className="domain-group-entry">
                                <div>
                                  <code>{entry.domain}</code>
                                  <DomainEvidence entry={entry} />
                                </div>
                                <span className="learned-actions">
                                  <button
                                    className="tiny-link learned-approve"
                                    disabled={busy}
                                    onClick={() => void approveSingleDomain(entry.domain)}
                                    title="Approve to allowlist"
                                  >
                                    approve
                                  </button>
                                  <button
                                    className="tiny-link"
                                    disabled={busy}
                                    onClick={() => void dismissSingleDomain(entry.domain)}
                                    title="Dismiss without approving"
                                  >
                                    dismiss
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Known limitations — always render container to avoid CLS when report loads */}
          {report?.limitations && report.limitations.length > 0 ? (
            <div className="limitations-section">
              <button
                type="button"
                className="firewall-logs-toggle"
                onClick={() => setLimitationsOpen((prev) => !prev)}
                aria-expanded={limitationsOpen}
              >
                <span>
                  Known limitations
                  <span className="muted-copy" style={{ marginLeft: 8 }}>
                    ({report.limitations.length})
                  </span>
                </span>
                <span className="firewall-logs-chevron" data-open={limitationsOpen}>
                  &#9656;
                </span>
              </button>
              {limitationsOpen && (
                <ul className="limitations-list">
                  {report.limitations.map((limitation) => (
                    <li key={limitation} className="muted-copy">
                      {limitation}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="limitations-section limitations-placeholder" />
          )}
        </article>

        <article className="panel-card">
          <div className="panel-head">
            <div>
              <h2>Observed activity</h2>
            </div>
            <button
              className="button ghost"
              disabled={busy || refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh().finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? "Refreshing\u2026" : "Refresh"}
            </button>
          </div>

          {eventCategoryCounts.size > 0 && (
            <div className="event-category-summary">
              <button
                className={`event-category-chip ${eventCategoryFilter === null ? "active" : ""}`}
                onClick={() => { setEventCategoryFilter(null); setEventPage(0); }}
              >
                all ({fw.events.length})
              </button>
              {[...eventCategoryCounts.entries()]
                .sort(([, a], [, b]) => b - a)
                .map(([cat, count]) => (
                  <button
                    key={cat}
                    className={`event-category-chip ${eventCategoryFilter === cat ? "active" : ""}`}
                    onClick={() => { setEventCategoryFilter(eventCategoryFilter === cat ? null : cat); setEventPage(0); }}
                  >
                    {cat}: {count}
                  </button>
                ))}
            </div>
          )}

          <ul className="event-list">
            {isZeroMatchFilter(fw.events.length, eventCategoryFilter, filteredEvents.length) ? (
              <li className="event-empty">
                No events match the &ldquo;{eventCategoryFilter}&rdquo; filter.
              </li>
            ) : paginatedEvents.length === 0 ? (
              <li className="event-empty">No firewall events yet.</li>
            ) : (
              paginatedEvents.map((event) => (
                <li key={event.id} className="event-row">
                  <div>
                    <p className="event-title">
                      {event.action}
                      {event.domain ? ` \u00b7 ${event.domain}` : ""}
                      {event.category && event.category !== "unknown" ? (
                        <span className="category-tag">{event.category}</span>
                      ) : null}
                    </p>
                    {event.sourceCommand ? (
                      <p className="event-command">
                        <code>{event.sourceCommand}</code>
                      </p>
                    ) : null}
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

          {eventPageCount > 1 && (
            <div className="event-pagination">
              <button
                className="button secondary"
                disabled={clampedPage === 0}
                onClick={() => setEventPage((p) => Math.max(0, p - 1))}
              >
                Prev
              </button>
              <span className="event-page-indicator">
                {clampedPage + 1} / {eventPageCount}
              </span>
              <button
                className="button secondary"
                disabled={clampedPage >= eventPageCount - 1}
                onClick={() => setEventPage((p) => Math.min(eventPageCount - 1, p + 1))}
              >
                Next
              </button>
            </div>
          )}
        </article>
      </div>

      <article className="panel-card" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="firewall-logs-toggle"
          onClick={() => setLogsOpen((prev) => !prev)}
          aria-expanded={logsOpen}
        >
          <span>
            Firewall Logs
            <span className="muted-copy" style={{ marginLeft: 8 }}>
              ({firewallLogs.length})
            </span>
          </span>
          <span className="firewall-logs-chevron" data-open={logsOpen}>
            &#9656;
          </span>
        </button>

        {logsOpen && (
          <div className="firewall-logs-body">
            {firewallLogsError && (
              <p className="error-banner">
                {firewallLogs.length > 0
                  ? `Showing last successful firewall logs. Latest refresh failed: ${firewallLogsError}`
                  : `Failed to load firewall logs: ${firewallLogsError}`}
              </p>
            )}
            {logsLoading && firewallLogs.length === 0 ? (
              <p className="empty-token">Loading firewall logs...</p>
            ) : firewallLogs.length === 0 ? (
              <p className="empty-token">No firewall logs yet.</p>
            ) : (
              <div className="firewall-logs-scroll">
                {firewallLogs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`log-row ${LEVEL_COLORS[entry.level]}`}
                  >
                    <span className="log-time">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`log-level ${LEVEL_COLORS[entry.level]}`}>
                      {entry.level}
                    </span>
                    <span className="log-message">{entry.message}</span>
                    {entry.data && Object.keys(entry.data).length > 0 ? (
                      <span className="log-data">
                        {formatLogData(entry.data)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </article>

      <ConfirmDialog {...promoteDialogProps} />
      <ConfirmDialog {...removeDialogProps} />
      <ConfirmDialog {...dismissDialogProps} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-domain evidence component
// ---------------------------------------------------------------------------

function DomainEvidence({ entry }: { entry: LearnedDomain }) {
  const categories = (entry.categories ?? []).filter((c) => c !== "unknown");
  return (
    <span className="muted-copy">
      {entry.hitCount} hit{entry.hitCount === 1 ? "" : "s"}
      {categories.length > 0 ? ` \u00b7 ${categories.join(", ")}` : ""}
      {" \u00b7 "}first {formatRelativeTime(entry.firstSeenAt)}
      {" \u00b7 "}last {formatRelativeTime(entry.lastSeenAt)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Client-side eTLD+1 grouping fallback (for filtered results)
// ---------------------------------------------------------------------------

import { getRegistrableDomain } from "@/shared/domain-grouping";

type DomainGroup = {
  registrableDomain: string;
  domains: LearnedDomain[];
};

function clientGroupByRegistrableDomain(domains: LearnedDomain[]): DomainGroup[] {
  const groups = new Map<string, LearnedDomain[]>();
  for (const entry of domains) {
    const key = getRegistrableDomain(entry.domain);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.domain.localeCompare(b.domain));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([registrableDomain, domains]) => ({ registrableDomain, domains }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "log-error",
  warn: "log-warn",
  info: "log-info",
  debug: "log-debug",
};

function formatLogData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    } else if (value !== null && value !== undefined) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(" ");
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return "< 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return formatTimestamp(timestamp);
}
