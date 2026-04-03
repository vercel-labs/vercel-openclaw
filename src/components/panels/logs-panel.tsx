"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vlistRef = useRef<VListHandle>(null);

  const sandboxStatus = status.status as SingleStatus;
  const canFetchLogs = isSandboxLogReadableStatus(sandboxStatus);
  const isBooting = isSandboxLifecyclePending(sandboxStatus);
  const isStopped = sandboxStatus === "stopped";

  const fetchLogs = useCallback(async () => {
    if (!active || !canFetchLogs) return;
    setLoading(true);
    try {
      const result = await fetchAdminJsonCore<{ logs: LogEntry[] }>(
        "/api/admin/logs",
        readDeps,
        { toastError: false },
      );
      if (result.ok) {
        setLogs(result.data.logs);
        setReadError(null);
        return;
      }
      setReadError(result.error);
    } finally {
      setLoading(false);
    }
  }, [active, canFetchLogs, readDeps, logs.length]);

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

  // Auto-scroll to bottom when live and new logs arrive
  useEffect(() => {
    if (!active) return;
    if (live && vlistRef.current && filtered.length > 0) {
      vlistRef.current.scrollToIndex(filtered.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, logs, live]);

  const toggleLevel = (level: LogLevel) => {
    setLevels((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  const filtered = logs.filter((entry) => {
    if (!levels[entry.level]) return false;
    if (activeSource !== "all" && entry.source !== activeSource) return false;
    if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  const copyLogEntry = useCallback((entry: LogEntry) => {
    const text = formatLogCopyText(entry);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(entry.id);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => {
        /* clipboard unavailable */
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
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className={`log-row ${LEVEL_COLORS[entry.level]}`}
              >
                <span className="log-time">
                  {formatLogTime(entry)}
                </span>
                <span className={`log-level ${LEVEL_COLORS[entry.level]}`}>
                  {entry.level}
                </span>
                <span className="log-source">{entry.source}</span>
                <span className="log-message">{entry.message}</span>
                <button
                  type="button"
                  className="log-copy-btn"
                  onClick={() => copyLogEntry(entry)}
                  title="Copy log entry"
                >
                  {copiedId === entry.id ? "\u2713" : "\u2398"}
                </button>
              </div>
            ))}
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
