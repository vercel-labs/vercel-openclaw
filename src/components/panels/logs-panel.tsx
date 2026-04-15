"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import type { LogEntry, LogLevel, LogSource, SingleStatus } from "@/shared/types";
import type { StatusPayload } from "@/components/admin-types";
import { fetchAdminJsonCore, type ReadJsonDeps } from "@/components/admin-request-core";
import { isSandboxLogReadableStatus, isSandboxLifecyclePending } from "@/shared/sandbox/log-visibility";

type LogsPanelProps = {
  active: boolean;
  status: StatusPayload;
  readDeps: ReadJsonDeps;
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "log-error",
  warn: "log-warn",
  info: "log-info",
  debug: "log-debug",
};

const ALL_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

const ALL_SOURCES: LogSource[] = [
  "lifecycle",
  "proxy",
  "firewall",
  "channels",
  "auth",
  "system",
];

const POLL_INTERVAL_MS = 3000;
const MAIN_LOG_CAP = 2000;

function formatLogTime(entry: LogEntry): string {
  return entry.timestampKind === "untimed"
    ? "untimed"
    : new Date(entry.timestamp).toLocaleTimeString();
}

function formatLogCopyText(entry: LogEntry): string {
  const prefix =
    entry.timestampKind === "untimed"
      ? "[untimed]"
      : `[${new Date(entry.timestamp).toISOString()}]`;
  return `${prefix} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
}

function isSandboxTailId(id: string): boolean {
  return id.startsWith("sbx-") || id.startsWith("log-plain-");
}

function mergeLogs(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (incoming.length === 0) return prev;
  const hasSandboxInIncoming = incoming.some((e) => isSandboxTailId(e.id));
  const base = hasSandboxInIncoming
    ? prev.filter((e) => !isSandboxTailId(e.id))
    : prev;
  const seen = new Set(base.map((e) => e.id));
  const newOnes = incoming.filter((e) => !seen.has(e.id));
  if (newOnes.length === 0 && !hasSandboxInIncoming) return prev;
  // Server returns newest-first; VList shows oldest-at-top, so we append newest to end.
  // Incoming order: newest-first -> reverse to oldest-first for append.
  const reversed = [...newOnes].reverse();
  const merged = [...base, ...reversed];
  return merged.length > MAIN_LOG_CAP ? merged.slice(-MAIN_LOG_CAP) : merged;
}

function LogJsonTree({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  if (value === null) return <span className="jt-null">null</span>;
  if (value === undefined) return <span className="jt-null">undefined</span>;
  const t = typeof value;
  if (t === "string") return <span className="jt-str">&quot;{value as string}&quot;</span>;
  if (t === "number" || t === "bigint") return <span className="jt-num">{String(value)}</span>;
  if (t === "boolean") return <span className="jt-bool">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="jt-empty">[]</span>;
    return (
      <div className="jt-block" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
        {value.map((v, i) => (
          <div className="jt-row" key={i}>
            <span className="jt-key">[{i}]</span>
            <LogJsonTree value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return <span className="jt-empty">{"{}"}</span>;
    return (
      <div className="jt-block" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
        {keys.map((k) => (
          <div className="jt-row" key={k}>
            <span className="jt-key">{k}:</span>
            <LogJsonTree value={obj[k]} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  return <span className="jt-str">{String(value)}</span>;
}

export function LogsPanel({ active, status, readDeps }: LogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: false,
  });
  const [activeSource, setActiveSource] = useState<LogSource | "all">("all");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedMode, setCopiedMode] = useState<"text" | "json" | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vlistRef = useRef<VListHandle>(null);
  const cursorRef = useRef<string | null>(null);

  const sandboxStatus = status.status as SingleStatus;
  const canFetchLogs = isSandboxLogReadableStatus(sandboxStatus);
  const isBooting = isSandboxLifecyclePending(sandboxStatus);
  const isStopped = sandboxStatus === "stopped";

  const fetchLogs = useCallback(async () => {
    if (!active || !canFetchLogs) return;
    setLoading(true);
    try {
      const cursor = cursorRef.current;
      const path = cursor
        ? `/api/admin/logs?sinceId=${encodeURIComponent(cursor)}`
        : "/api/admin/logs";
      const result = await fetchAdminJsonCore<{
        logs: LogEntry[];
        nextCursor?: string | null;
      }>(path, readDeps, { toastError: false });
      if (result.ok) {
        if (result.data.nextCursor) cursorRef.current = result.data.nextCursor;
        if (!cursor) {
          // First load: server returns newest-first; VList lists oldest first for auto-scroll-to-bottom.
          setLogs([...result.data.logs].reverse().slice(-MAIN_LOG_CAP));
        } else {
          setLogs((prev) => mergeLogs(prev, result.data.logs));
        }
        setReadError(null);
        return;
      }
      setReadError(result.error);
    } finally {
      setLoading(false);
    }
  }, [active, canFetchLogs, readDeps]);

  useEffect(() => {
    if (!active) return;
    void fetchLogs();
  }, [active, fetchLogs]);

  useEffect(() => {
    if (!active || !live || !canFetchLogs) return;

    const interval = window.setInterval(() => {
      void fetchLogs();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [active, live, canFetchLogs, fetchLogs]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedIds.size > 0) {
        setExpandedIds(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, expandedIds]);

  const toggleLevel = (level: LogLevel) => {
    setLevels((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  const filtered = useMemo(
    () =>
      logs.filter((entry) => {
        if (!levels[entry.level]) return false;
        if (activeSource !== "all" && entry.source !== activeSource) return false;
        if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) {
          return false;
        }
        return true;
      }),
    [logs, levels, activeSource, search],
  );

  // Auto-scroll to bottom when live and new logs arrive
  useEffect(() => {
    if (!active) return;
    if (live && vlistRef.current && filtered.length > 0) {
      vlistRef.current.scrollToIndex(filtered.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, logs, live]);

  const copyLogEntry = useCallback((entry: LogEntry, mode: "text" | "json") => {
    const text =
      mode === "json"
        ? JSON.stringify(entry, null, 2)
        : formatLogCopyText(entry);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(entry.id);
        setCopiedMode(mode);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setCopiedId(null);
          setCopiedMode(null);
        }, 1500);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const emptyMessage = (() => {
    if (sandboxStatus === "creating") return "Sandbox is being created -- logs will appear once setup begins.";
    if (isBooting) return "Sandbox is starting up -- logs may appear as setup progresses.";
    if (isStopped) return "Sandbox is stopped. Start it from the Status tab to see logs.";
    if (sandboxStatus === "error") return "Sandbox is in an error state. Check the Status tab.";
    if (sandboxStatus === "uninitialized") return "Sandbox has not been created yet. Use the Status tab to get started.";
    if (canFetchLogs && logs.length === 0) return "No logs collected yet. They will appear shortly.";
    if (canFetchLogs && filtered.length === 0) return "No logs matching current filters.";
    return "No logs available.";
  })();

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <h2>Sandbox log viewer</h2>
        </div>
        <button
          type="button"
          className={`pill ${live ? "active" : ""}`}
          onClick={() => setLive((prev) => !prev)}
        >
          {live ? "Live" : "Paused"}
        </button>
      </div>

      {!canFetchLogs && !isBooting && sandboxStatus !== "uninitialized" && (
        <p className="error-banner">
          Sandbox is not running. Start it from the Status tab first.
        </p>
      )}

      {readError && (
        <p className="error-banner">
          {logs.length > 0
            ? `Showing last successful logs. Latest refresh failed: ${readError}`
            : `Failed to load logs: ${readError}`}
        </p>
      )}

      {/* Filters */}
      <div className="logs-filters">
        <input
          type="text"
          className="ssh-input logs-search"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="logs-level-filters">
          {ALL_LEVELS.map((level) => (
            <label key={level} className="check-row">
              <input
                type="checkbox"
                checked={levels[level]}
                onChange={() => toggleLevel(level)}
              />
              <span className={`log-level-label ${LEVEL_COLORS[level]}`}>
                {level}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Source filter pills */}
      <div className="logs-source-filters">
        <button
          type="button"
          className={`logs-source-pill ${activeSource === "all" ? "active" : ""}`}
          onClick={() => setActiveSource("all")}
        >
          all
        </button>
        {ALL_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            className={`logs-source-pill ${activeSource === source ? "active" : ""}`}
            onClick={() => setActiveSource(source)}
          >
            {source}
          </button>
        ))}
      </div>

      {/* Log list with virtual scrolling */}
      <div className="logs-scroll">
        {filtered.length === 0 ? (
          <p className="empty-token">{emptyMessage}</p>
        ) : (
          <VList ref={vlistRef} style={{ height: 480 }}>
            {filtered.map((entry) => {
              const expanded = expandedIds.has(entry.id);
              const data = entry.data ?? null;
              const hasData = data && Object.keys(data).length > 0;
              const truncated = Boolean(
                data && (data as Record<string, unknown>).__truncated,
              );
              const preview = truncated
                ? String((data as Record<string, unknown>).__preview ?? "")
                : "";
              const originalBytes = truncated
                ? Number(
                    (data as Record<string, unknown>).__originalBytes ?? 0,
                  )
                : 0;
              return (
                <div
                  key={entry.id}
                  className={`log-row ${LEVEL_COLORS[entry.level]}${expanded ? " expanded" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => hasData && toggleExpanded(entry.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hasData) {
                      e.preventDefault();
                      toggleExpanded(entry.id);
                    }
                  }}
                >
                  <div className="log-row-main">
                    <span className="log-time">{formatLogTime(entry)}</span>
                    <span className={`log-level ${LEVEL_COLORS[entry.level]}`}>
                      {entry.level}
                    </span>
                    <span className="log-source">{entry.source}</span>
                    <span className="log-message">{entry.message}</span>
                    {truncated && (
                      <span
                        className="log-trunc-pill"
                        title="Payload truncated by server"
                      >
                        ⚠ truncated
                      </span>
                    )}
                    {hasData && (
                      <span className="log-expand-hint" aria-hidden>
                        {expanded ? "▾" : "▸"}
                      </span>
                    )}
                    <div
                      className="log-copy-row"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="log-copy-btn"
                        onClick={() => copyLogEntry(entry, "text")}
                        title="Copy as text"
                      >
                        {copiedId === entry.id && copiedMode === "text"
                          ? "\u2713"
                          : "copy \u2398"}
                      </button>
                      <button
                        type="button"
                        className="log-copy-btn"
                        onClick={() => copyLogEntry(entry, "json")}
                        title="Copy full entry as JSON"
                      >
                        {copiedId === entry.id && copiedMode === "json"
                          ? "\u2713"
                          : "json \u2398"}
                      </button>
                    </div>
                  </div>
                  {expanded && hasData && (
                    <div className="log-data">
                      {truncated && (
                        <div className="log-trunc-callout">
                          ⚠ Truncated ({originalBytes.toLocaleString()} bytes).
                          View full in Vercel function logs.
                          {preview && (
                            <div className="log-trunc-preview">
                              Preview: {preview}
                            </div>
                          )}
                        </div>
                      )}
                      <LogJsonTree value={data} />
                    </div>
                  )}
                </div>
              );
            })}
          </VList>
        )}
      </div>

      <p className="muted-copy" style={{ marginTop: 8 }}>
        {filtered.length === logs.length
          ? `${logs.length} entries`
          : `${filtered.length} of ${logs.length} entries`}
        {loading ? " (refreshing...)" : ""}
      </p>
    </article>
  );
}
