"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ActionResult,
  StatusPayload,
} from "@/components/admin-types";
import { requestJsonCore } from "@/components/admin-shell";
import { ChannelsPanel } from "@/components/panels/channels-panel";
import type { LogEntry, LogLevel, LogSource, SnapshotRecord } from "@/shared/types";
import type { AdminFaqPayload } from "@/shared/admin-faq";

type Props = { initialStatus: StatusPayload | null };

type View =
  | "status"
  | "channels"
  | "firewall"
  | "terminal"
  | "logs"
  | "snapshots"
  | "faq";

type SshResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timestamp: number;
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

const RAIL_LOG_CAP = 500;
const MAIN_LOG_CAP = 2000;

function isSandboxTailId(id: string): boolean {
  return id.startsWith("sbx-") || id.startsWith("log-plain-");
}

function isServerBufferId(id: string): boolean {
  return id.startsWith("slog-");
}

function mergeLogs(prev: LogEntry[], incoming: LogEntry[], cap: number): LogEntry[] {
  if (incoming.length === 0) return prev;
  // Strip prior sandbox-tail entries; server replaces them every poll.
  const hasSandboxInIncoming = incoming.some((e) => isSandboxTailId(e.id));
  const base = hasSandboxInIncoming
    ? prev.filter((e) => !isSandboxTailId(e.id))
    : prev;
  const seen = new Set(base.map((e) => e.id));
  const newOnes = incoming.filter((e) => !seen.has(e.id));
  if (newOnes.length === 0 && !hasSandboxInIncoming) return prev;
  // Server returns newest-first. Preserve that ordering by prepending.
  const merged = [...newOnes, ...base];
  // Re-sort so sandbox entries fall in the right place by sourceOrder/timestamp.
  merged.sort((a, b) => {
    const at = a.sourceOrder ?? a.timestamp ?? 0;
    const bt = b.sourceOrder ?? b.timestamp ?? 0;
    return bt - at;
  });
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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
        {(value as JsonValue[]).map((v, i) => (
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

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "muted" | "info"> = {
  running: "success",
  setup: "info",
  booting: "info",
  creating: "info",
  stopped: "muted",
  error: "danger",
  uninitialized: "muted",
};

function fmtMs(n: number | undefined | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString()}ms`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtTimeOfDay(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function truncate(s: string | null, n: number): string {
  if (!s) return "—";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export function CommandShell({ initialStatus }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(initialStatus);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secret, setSecret] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [tick, setTick] = useState(0);

  // View + feature state
  const [view, setView] = useState<View>("status");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const selectView = useCallback((v: View) => {
    setView(v);
    setSidebarOpen(false);
  }, []);

  // Firewall
  const [fwDomainInput, setFwDomainInput] = useState("");
  const [fwTestDomain, setFwTestDomain] = useState("");
  const [fwTestResult, setFwTestResult] = useState<{
    allowed: boolean;
    reason: string;
    domain: string;
  } | null>(null);

  // Snapshots
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);

  // Logs
  const [logSearch, setLogSearch] = useState("");
  const [logLevels, setLogLevels] = useState<Record<LogLevel, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: false,
  });
  const [logSource, setLogSource] = useState<LogSource | "all">("all");
  const [logsLive, setLogsLive] = useState(true);
  const [logsHoverPaused, setLogsHoverPaused] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);
  const [copiedLogMode, setCopiedLogMode] = useState<"text" | "json" | null>(null);
  const logsCursorRef = useRef<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Terminal (SSH)
  const [sshCmd, setSshCmd] = useState("");
  const [sshResults, setSshResults] = useState<SshResult[]>([]);
  const [sshRunning, setSshRunning] = useState(false);

  // FAQ
  const [faq, setFaq] = useState<AdminFaqPayload | null>(null);
  const [faqLoading, setFaqLoading] = useState(false);
  const [faqError, setFaqError] = useState<string | null>(null);

  const actionMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tick every second so uptime/relative times update without refetching.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as StatusPayload;
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshLogs = useCallback(async () => {
    try {
      const cursor = logsCursorRef.current;
      const url = cursor
        ? `/api/admin/logs?sinceId=${encodeURIComponent(cursor)}`
        : "/api/admin/logs";
      const res = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        logs: LogEntry[];
        nextCursor?: string | null;
      };
      if (data.nextCursor) logsCursorRef.current = data.nextCursor;
      if (!cursor) {
        // First load — replace.
        setLogs(data.logs.slice(0, MAIN_LOG_CAP));
      } else {
        setLogs((prev) => mergeLogs(prev, data.logs, MAIN_LOG_CAP));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!status) return;
    refreshStatus();
    refreshLogs();
    const sId = setInterval(refreshStatus, 5000);
    const paused = !logsLive || logsHoverPaused;
    const lId = paused ? null : setInterval(refreshLogs, 3000);
    return () => {
      clearInterval(sId);
      if (lId) clearInterval(lId);
    };
  }, [status, refreshStatus, refreshLogs, logsLive, logsHoverPaused]);

  // Keyboard: Escape collapses all expanded log rows in main view.
  useEffect(() => {
    if (view !== "logs") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedLogIds.size > 0) {
        setExpandedLogIds(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, expandedLogIds]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copyLogAs = useCallback(
    (entry: LogEntry, mode: "text" | "json") => {
      const text =
        mode === "json"
          ? JSON.stringify(entry, null, 2)
          : `[${new Date(entry.timestamp).toISOString()}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedLogId(entry.id);
          setCopiedLogMode(mode);
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
          copyTimerRef.current = setTimeout(() => {
            setCopiedLogId(null);
            setCopiedLogMode(null);
          }, 1500);
        })
        .catch(() => {
          /* clipboard unavailable */
        });
    },
    [],
  );

  // Adapters so the existing panel components (ChannelsPanel, etc.) can post
  // mutations through the shared `requestJsonCore` plumbing.
  const requestJson = useCallback(
    async <T,>(
      action: string,
      input: RequestInit & { label: string; refreshAfter?: boolean },
    ): Promise<ActionResult<T>> => {
      return requestJsonCore<T>(
        action,
        { ...input, toastSuccess: false },
        {
          setPendingAction: (label) => setPending(label),
          setStatus: () => setStatus(null),
          refreshPassive: refreshStatus,
          toastSuccess: () => {},
          toastError: (msg) => toast.error(msg),
        },
      );
    },
    [refreshStatus],
  );

  const runAction = useCallback(
    async (
      action: string,
      input: RequestInit & { label: string },
    ): Promise<boolean> => {
      const result = await requestJson(action, input);
      return result.ok;
    },
    [requestJson],
  );

  const doAction = useCallback(
    async (
      label: string,
      path: string,
      methodOrInit: "POST" | "DELETE" | "PUT" | "GET" | RequestInit = "POST",
    ): Promise<{ ok: boolean; data: unknown }> => {
      const init: RequestInit =
        typeof methodOrInit === "string" ? { method: methodOrInit } : methodOrInit;
      setPending(label);
      setActionMsg(null);
      if (actionMsgTimerRef.current) clearTimeout(actionMsgTimerRef.current);
      try {
        const res = await fetch(path, {
          ...init,
          credentials: "same-origin",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            accept: "application/json",
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          /* ignore */
        }
        if (!res.ok) {
          const msg =
            (payload as { error?: { message?: string } } | null)?.error?.message ??
            `${res.status}`;
          setActionMsg(null);
          toast.error(`${label} failed`, { description: msg });
          return { ok: false, data: payload };
        }
        setActionMsg(`${label} ok`);
        actionMsgTimerRef.current = setTimeout(() => setActionMsg(null), 3000);
        await refreshStatus();
        await refreshLogs();
        return { ok: true, data: payload };
      } catch (err) {
        setActionMsg(null);
        toast.error(`${label} failed`, { description: (err as Error).message });
        return { ok: false, data: null };
      } finally {
        setPending(null);
      }
    },
    [refreshStatus, refreshLogs],
  );

  // Snapshot fetch
  const fetchSnapshots = useCallback(async () => {
    setSnapshotsLoading(true);
    try {
      const res = await fetch("/api/admin/snapshots", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { snapshots: SnapshotRecord[] };
        setSnapshots(data.snapshots);
      }
    } catch {
      /* ignore */
    } finally {
      setSnapshotsLoading(false);
    }
  }, []);

  const fetchFaq = useCallback(async () => {
    setFaqLoading(true);
    setFaqError(null);
    try {
      const res = await fetch("/api/admin/faq", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        setFaqError(`Failed to load FAQ (${res.status})`);
        return;
      }
      const data = (await res.json()) as AdminFaqPayload;
      setFaq(data);
    } catch (err) {
      setFaqError((err as Error).message);
    } finally {
      setFaqLoading(false);
    }
  }, []);

  // Load snapshots / FAQ when entering those views.
  // Important: do NOT include `status` in deps — it repolls every 5s and would
  // re-trigger these fetches, flipping `faqLoading` back to true on every tick.
  useEffect(() => {
    if (view === "snapshots") void fetchSnapshots();
    if (view === "faq" && !faq) void fetchFaq();
  }, [view, fetchSnapshots, fetchFaq, faq]);

  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoginPending(true);
      setLoginError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-requested-with": "XMLHttpRequest",
          },
          body: JSON.stringify({ secret }),
        });
        if (!res.ok) {
          let msg = `Login failed (${res.status})`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) msg = body.message;
          } catch {
            /* ignore */
          }
          setLoginError(msg);
        } else {
          // Fetch status directly with the freshly-set cookie instead of reloading.
          const statusRes = await fetch("/api/status", {
            credentials: "same-origin",
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          if (statusRes.ok) {
            const data = (await statusRes.json()) as StatusPayload;
            setStatus(data);
            setSecret("");
          } else {
            setLoginError(`Logged in but /api/status returned ${statusRes.status}`);
          }
        }
      } catch (err) {
        setLoginError((err as Error).message);
      } finally {
        setLoginPending(false);
      }
    },
    [secret],
  );

  const sandboxId = status?.sandboxId ?? null;

  const uptimeMs = useMemo(() => {
    if (!status) return null;
    if (status.status !== "running") return null;
    const recorded = status.lifecycle.lastRestoreMetrics?.recordedAt;
    if (!recorded) return null;
    return Date.now() - recorded;
  }, [status, tick]);

  const tone = status ? STATUS_TONE[status.status] ?? "muted" : "muted";

  const lifecycle = status?.lifecycle.lastRestoreMetrics ?? null;
  const channels = status?.channels ?? null;
  const firewall = status?.firewall ?? null;

  if (!status) {
    return (
      <div className="login-wrap">
        <Style />
        <form
          className="login-card"
          onSubmit={handleLogin}
          method="post"
          action="/api/auth/login"
        >
          <div className="login-header">
            <img src="/openclaw-logo.svg" width={24} height={24} alt="OpenClaw" />
            <span className="sidebar-title">OpenClaw</span>
          </div>
          <input
            type="text"
            name="username"
            value="admin"
            readOnly
            autoComplete="username"
            aria-hidden="true"
            tabIndex={-1}
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
          />
          <label className="eyebrow" htmlFor="secret">Admin secret</label>
          <input
            id="secret"
            name="password"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="login-input"
            placeholder="ADMIN_SECRET"
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <button type="submit" className="btn btn-primary" disabled={loginPending || !secret}>
            {loginPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  const channelRows: Array<{
    name: string;
    configured: boolean;
    state: string;
    tone: "success" | "warning" | "danger" | "muted";
    webhook: string | null;
  }> = channels
    ? [
        {
          name: "Slack",
          configured: channels.slack.configured,
          state: channels.slack.configured ? "connected" : "not configured",
          tone: channels.slack.lastError
            ? "warning"
            : channels.slack.configured
              ? "success"
              : "muted",
          webhook: channels.slack.webhookUrl,
        },
        {
          name: "Telegram",
          configured: channels.telegram.configured,
          state: channels.telegram.status,
          tone:
            channels.telegram.status === "connected"
              ? "success"
              : channels.telegram.status === "error"
                ? "danger"
                : channels.telegram.configured
                  ? "warning"
                  : "muted",
          webhook: channels.telegram.webhookUrl,
        },
        {
          name: "Discord",
          configured: channels.discord.configured,
          state: channels.discord.configured
            ? channels.discord.commandRegistered
              ? "connected"
              : "registered"
            : "not configured",
          tone: channels.discord.endpointError
            ? "warning"
            : channels.discord.configured
              ? "success"
              : "muted",
          webhook: channels.discord.webhookUrl,
        },
        {
          name: "WhatsApp",
          configured: channels.whatsapp.configured,
          state: channels.whatsapp.configured
            ? channels.whatsapp.status
            : "not configured",
          tone: channels.whatsapp.lastError
            ? "warning"
            : channels.whatsapp.configured
              ? "success"
              : "muted",
          webhook: channels.whatsapp.webhookUrl,
        },
      ]
    : [];

  const wouldBlockCount = firewall?.wouldBlock?.length ?? 0;
  const allowlist = firewall?.allowlist ?? [];

  const cliCmd = sandboxId
    ? `npx sandbox connect ${sandboxId}`
    : "npx sandbox connect <sandbox-id>";

  return (
    <div className={`layout${sidebarOpen ? " sidebar-open" : ""}`}>
      <Style />

      {sidebarOpen && (
        <div
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="sidebar-header">
          <img src="/openclaw-logo.svg" width={24} height={24} alt="OpenClaw" />
          <span className="sidebar-title">OpenClaw</span>
        </div>

        <div className="sidebar-nav">
          <NavItem
            label="Status"
            active={view === "status"}
            onClick={() => selectView("status")}
          />
          <NavItem
            label="Channels"
            active={view === "channels"}
            onClick={() => selectView("channels")}
          />
          <NavItem
            label="Firewall"
            active={view === "firewall"}
            onClick={() => selectView("firewall")}
          />
          <NavItem
            label="Terminal"
            active={view === "terminal"}
            onClick={() => selectView("terminal")}
          />
          <NavItem
            label="Logs"
            active={view === "logs"}
            onClick={() => selectView("logs")}
          />
          <NavItem
            label="Snapshots"
            active={view === "snapshots"}
            onClick={() => selectView("snapshots")}
          />
          <NavItem
            label="FAQ"
            active={view === "faq"}
            onClick={() => selectView("faq")}
          />
        </div>

        <div className="sidebar-footer">
          <FootRow label="Store" val={status.storeBackend} />
          <FootRow label="Auth" val={status.authMode} />
          <FootRow
            label="AI Auth"
            val={status.lifecycle.lastTokenSource ?? "—"}
          />
          <FootRow
            label="Sandbox SDK"
            val={status.sandboxSdkVersion ?? "—"}
          />
          <FootRow
            label="OpenClaw"
            val={status.openclawVersion ?? "—"}
          />
          <div
            className="footer-row"
            style={{
              marginTop: 8,
              paddingTop: 16,
              borderTop: "1px solid var(--border)",
              alignItems: "center",
            }}
          >
            <span>User</span>
            <div className="user-cluster">
              <div className="pill">{status.user?.name ?? "admin"}</div>
              <a
                href="/api/auth/signout"
                className="signout-link"
                title="Sign out and clear the session cookie"
                aria-label="Sign out"
              >
                Sign out
              </a>
            </div>
          </div>
          <button
            type="button"
            className="reset-link"
            disabled={pending !== null}
            onClick={() => {
              if (
                typeof window !== "undefined" &&
                !window.confirm(
                  "Reset sandbox from scratch?\n\nThis deletes the current sandbox and all saved snapshots, then starts a fresh install of OpenClaw. Unsaved runtime state, installed packages, and in-sandbox changes will be lost.",
                )
              ) {
                return;
              }
              void doAction("Reset", "/api/admin/reset");
            }}
            title="Delete sandbox and snapshots; start a fresh install"
          >
            <span>Reset sandbox</span>
            <span className="reset-hint">destructive</span>
          </button>
        </div>
      </div>

      <div className="main">
        <div className="toolbar">
          <div className="toolbar-left">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-expanded={sidebarOpen}
              aria-label="Toggle navigation"
            >
              <span />
              <span />
              <span />
            </button>
            <div className="breadcrumb">
              <span className="current">{view}</span>
              {pending && <span className="pending">· {pending}…</span>}
              {actionMsg && <span className="action-msg">· {actionMsg}</span>}
            </div>
          </div>
        </div>

        <div className="content">
          {status.lastError && (
            <section>
              <div className="error-inline">
                <span className="eyebrow" style={{ color: "var(--danger)" }}>
                  Last error
                </span>
                <div className="error-inline-msg">{status.lastError}</div>
              </div>
            </section>
          )}

          {status.setupProgress &&
            ["creating", "setup", "booting", "restoring"].includes(status.status) && (
              <section>
                <div className="section-header">
                  <h2 className="section-title">Setup progress</h2>
                  <span className="eyebrow">
                    {status.setupProgress.phase}
                  </span>
                </div>
                <div className="setup-steps">
                  {[
                    "Creating sandbox",
                    "Installing OpenClaw",
                    "Configuring",
                    "Starting gateway",
                    "Ready",
                  ].map((step, idx) => {
                    const phase = status.setupProgress?.phase ?? "";
                    const active =
                      (idx === 0 &&
                        (phase === "creating-sandbox" ||
                          phase === "resuming-sandbox")) ||
                      (idx === 1 &&
                        (phase.startsWith("installing") ||
                          phase === "cleaning-cache")) ||
                      (idx === 2 &&
                        (phase === "writing-config" ||
                          phase === "checking-version")) ||
                      (idx === 3 &&
                        (phase === "starting-gateway" ||
                          phase === "waiting-for-gateway" ||
                          phase === "pairing-device" ||
                          phase === "applying-firewall")) ||
                      (idx === 4 && phase === "ready");
                    return (
                      <div
                        key={step}
                        className={`setup-step${active ? " active" : ""}`}
                      >
                        <span className="setup-step-dot" />
                        <span>{step}</span>
                      </div>
                    );
                  })}
                </div>
                {status.setupProgress.preview && (
                  <p className="muted-copy" style={{ marginTop: 8 }}>
                    {status.setupProgress.preview}
                  </p>
                )}
              </section>
            )}

          <section>
            <div className="hero-panel">
              <div className="hero-info">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="status-badge">
                    <span className={`status-dot ${tone}`}></span>
                    {status.status.toUpperCase()}
                  </div>
                  <div className="hero-id">
                    {sandboxId ?? "—"}
                  </div>
                </div>
                <div className="hero-meta">
                  <span className="hero-meta-item">
                    Uptime:{" "}
                    <span className="hero-meta-val">{fmtDuration(uptimeMs)}</span>
                  </span>
                  <span className="hero-meta-item">
                    Timeout remaining:{" "}
                    <span className="hero-meta-val">
                      {fmtDuration(status.timeoutRemainingMs)}
                    </span>
                  </span>
                  <span className="hero-meta-item">
                    Last keepalive:{" "}
                    <span className="hero-meta-val">
                      {fmtRelative(status.lastKeepaliveAt)}
                    </span>
                  </span>
                </div>
                {status.lastError && (
                  <div className="hero-error">{status.lastError}</div>
                )}
              </div>
              <div className="hero-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => doAction("Snapshot", "/api/admin/snapshot")}
                  disabled={
                    pending !== null ||
                    status.status === "uninitialized" ||
                    status.status === "stopped"
                  }
                  title="Stop the sandbox (auto-snapshots on stop)"
                  aria-label="Take snapshot — stops the sandbox, which auto-snapshots"
                >
                  Snapshot
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => doAction("Stop", "/api/admin/stop")}
                  disabled={
                    pending !== null ||
                    status.status === "stopped" ||
                    status.status === "uninitialized"
                  }
                  title="Stop the sandbox; state is preserved by auto-snapshot"
                  aria-label="Stop sandbox"
                >
                  Stop
                </button>
                {status.status !== "running" && (
                  <button
                    className="btn btn-primary"
                    onClick={() => doAction("Restore", "/api/admin/ensure")}
                    disabled={pending !== null}
                    title="Create or resume the sandbox from the latest snapshot"
                    aria-label="Restore sandbox"
                  >
                    Restore
                  </button>
                )}
                <a
                  className={
                    status.status === "running"
                      ? "btn btn-primary"
                      : "btn btn-ghost"
                  }
                  href={status.gatewayUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={status.status !== "running"}
                  title={
                    status.status === "running"
                      ? "Open the OpenClaw gateway in a new tab"
                      : "Gateway is offline — restore the sandbox first"
                  }
                  aria-label="Open OpenClaw gateway"
                  style={
                    status.status !== "running"
                      ? { opacity: 0.5, pointerEvents: "none" }
                      : undefined
                  }
                >
                  Open Gateway →
                </a>
              </div>
            </div>
          </section>

          {view === "status" && (
            <section>
              <div className="section-header">
                <h2 className="section-title">Lifecycle Metrics</h2>
                <span className="eyebrow">
                  Last restore · {fmtRelative(lifecycle?.recordedAt)}
                </span>
              </div>
              <div className="metrics-grid">
                <Metric label="sandboxCreateMs" val={lifecycle?.sandboxCreateMs} />
                <Metric label="assetSyncMs" val={lifecycle?.assetSyncMs} />
                <Metric label="startupScriptMs" val={lifecycle?.startupScriptMs} />
                <Metric label="forcePairMs" val={lifecycle?.forcePairMs} />
                <Metric label="firewallSyncMs" val={lifecycle?.firewallSyncMs} />
                <Metric label="localReadyMs" val={lifecycle?.localReadyMs} />
                <Metric label="publicReadyMs" val={lifecycle?.publicReadyMs} />
                <Metric
                  label={`totalMs (vcpus=${lifecycle?.vcpus ?? "—"})`}
                  val={lifecycle?.totalMs}
                  emphasized
                />
              </div>
            </section>
          )}

          {view === "channels" && (
            <section className="cmd-channels">
              <ChannelsPanel
                active={view === "channels"}
                status={status}
                busy={pending !== null}
                runAction={runAction}
                requestJson={requestJson}
                refresh={refreshStatus}
              />
            </section>
          )}

          {view === "firewall" && firewall && (
            <section>
              <div className="section-header">
                <h2 className="section-title">Firewall</h2>
                <div className="fw-mode-pills">
                  {(["disabled", "learning", "enforcing"] as const).map(
                    (mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`fw-mode-pill${
                          firewall.mode === mode ? " active" : ""
                        }`}
                        disabled={pending !== null || firewall.mode === mode}
                        onClick={() =>
                          void doAction(`Set mode ${mode}`, "/api/firewall", {
                            method: "PUT",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ mode }),
                          })
                        }
                      >
                        {mode}
                      </button>
                    ),
                  )}
                </div>
              </div>

              {firewall.wouldBlock.length > 0 && (
                <div className="fw-wouldblock">
                  <span className="eyebrow">
                    Would block ({firewall.wouldBlock.length})
                  </span>
                  <ul className="fw-chip-list">
                    {firewall.wouldBlock.map((d) => (
                      <li key={d}>
                        <code>{d}</code>
                        <button
                          type="button"
                          className="tiny-btn"
                          onClick={() =>
                            void doAction(
                              `Approve ${d}`,
                              "/api/firewall/allowlist",
                              {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ domains: [d] }),
                              },
                            )
                          }
                        >
                          approve
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="fw-row">
                <span className="eyebrow">Block test</span>
                <div className="fw-row-inputs">
                  <input
                    type="text"
                    className="cs-input"
                    placeholder="example.com"
                    value={fwTestDomain}
                    onChange={(e) => {
                      setFwTestDomain(e.target.value);
                      setFwTestResult(null);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pending !== null || !fwTestDomain.trim()}
                    onClick={async () => {
                      const result = await doAction(
                        `Test ${fwTestDomain}`,
                        "/api/firewall/test",
                        {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ domain: fwTestDomain.trim() }),
                        },
                      );
                      if (result.ok && result.data) {
                        setFwTestResult(
                          result.data as {
                            allowed: boolean;
                            reason: string;
                            domain: string;
                          },
                        );
                      }
                    }}
                  >
                    Test
                  </button>
                </div>
                {fwTestResult && (
                  <p
                    className="mono"
                    style={{
                      color: fwTestResult.allowed
                        ? "var(--success)"
                        : "var(--danger)",
                      fontSize: 12,
                    }}
                  >
                    {fwTestResult.allowed ? "Allowed" : "Blocked"} —{" "}
                    {fwTestResult.reason}
                  </p>
                )}
              </div>

              <div className="fw-row">
                <span className="eyebrow">Approve domains</span>
                <textarea
                  className="cs-input"
                  rows={3}
                  placeholder="api.openai.com, github.com"
                  value={fwDomainInput}
                  onChange={(e) => setFwDomainInput(e.target.value)}
                />
                <div className="fw-row-inputs">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pending !== null || !fwDomainInput.trim()}
                    onClick={async () => {
                      const domains = fwDomainInput
                        .split(/[\n,]/)
                        .map((v) => v.trim())
                        .filter(Boolean);
                      if (!domains.length) return;
                      const result = await doAction(
                        `Approve ${domains.length}`,
                        "/api/firewall/allowlist",
                        {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ domains }),
                        },
                      );
                      if (result.ok) setFwDomainInput("");
                    }}
                  >
                    Add to allowlist
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pending !== null || firewall.learned.length === 0}
                    onClick={() => {
                      if (
                        typeof window !== "undefined" &&
                        !window.confirm(
                          "Promote all learned domains to allowlist and switch to enforcing?",
                        )
                      )
                        return;
                      void doAction("Promote learned", "/api/firewall/promote", {
                        method: "POST",
                      });
                    }}
                  >
                    Promote learned to enforcing
                  </button>
                </div>
              </div>

              <div className="fw-split">
                <div>
                  <div className="section-header">
                    <h3 className="section-title">
                      Allowlist ({firewall.allowlist.length})
                    </h3>
                  </div>
                  {firewall.allowlist.length === 0 ? (
                    <p className="muted-copy">No approved domains yet.</p>
                  ) : (
                    <ul className="fw-chip-list">
                      {firewall.allowlist.map((d) => (
                        <li key={d}>
                          <code>{d}</code>
                          <button
                            type="button"
                            className="tiny-btn tiny-danger"
                            onClick={() => {
                              if (
                                typeof window !== "undefined" &&
                                !window.confirm(`Remove ${d} from allowlist?`)
                              )
                                return;
                              void doAction(
                                `Remove ${d}`,
                                "/api/firewall/allowlist",
                                {
                                  method: "DELETE",
                                  headers: {
                                    "content-type": "application/json",
                                  },
                                  body: JSON.stringify({ domains: [d] }),
                                },
                              );
                            }}
                          >
                            remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="section-header">
                    <h3 className="section-title">
                      Learned ({firewall.learned.length})
                    </h3>
                  </div>
                  {firewall.learned.length === 0 ? (
                    <p className="muted-copy">No learned domains yet.</p>
                  ) : (
                    <ul className="fw-chip-list">
                      {firewall.learned.slice(0, 30).map((entry) => (
                        <li key={entry.domain}>
                          <code>{entry.domain}</code>
                          <button
                            type="button"
                            className="tiny-btn"
                            onClick={() =>
                              void doAction(
                                `Approve ${entry.domain}`,
                                "/api/firewall/allowlist",
                                {
                                  method: "POST",
                                  headers: {
                                    "content-type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    domains: [entry.domain],
                                  }),
                                },
                              )
                            }
                          >
                            approve
                          </button>
                          <button
                            type="button"
                            className="tiny-btn tiny-danger"
                            onClick={() =>
                              void doAction(
                                `Dismiss ${entry.domain}`,
                                "/api/firewall/learned",
                                {
                                  method: "DELETE",
                                  headers: {
                                    "content-type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    domains: [entry.domain],
                                  }),
                                },
                              )
                            }
                          >
                            dismiss
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )}

          {view === "terminal" && (
            <>
              <section>
                <div className="section-header">
                  <h2 className="section-title">Vercel Sandbox CLI</h2>
                  <span className="eyebrow">
                    {sandboxId ? "live sandbox" : "no sandbox running"}
                  </span>
                </div>
                <div className="cli-block">
                  <div>
                    <span className="cli-prompt">$</span>
                    <span>{cliCmd}</span>
                  </div>
                  <button
                    className="cli-copy"
                    disabled={!sandboxId}
                    onClick={async () => {
                      if (!sandboxId) return;
                      if (
                        typeof navigator !== "undefined" &&
                        navigator.clipboard
                      ) {
                        await navigator.clipboard.writeText(cliCmd);
                      }
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    aria-label={
                      sandboxId
                        ? "Copy command"
                        : "No sandbox running — nothing to copy"
                    }
                    title={
                      sandboxId
                        ? "Copy command"
                        : "No sandbox running — start one from the Status tab"
                    }
                  >
                    {copied ? "✓" : "copy"}
                  </button>
                </div>
                <p className="muted-copy" style={{ marginTop: 8 }}>
                  Run <code>npx sandbox login</code> first. Append{" "}
                  <code>--scope TEAM --project NAME</code> on 404.
                </p>
              </section>

              <section>
                <div className="section-header">
                  <h2 className="section-title">Exec command</h2>
                  <span className="eyebrow">POST /api/admin/ssh</span>
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const cmd = sshCmd.trim();
                    if (!cmd || sshRunning) return;
                    setSshRunning(true);
                    const result = await doAction(
                      `Run: ${cmd.slice(0, 40)}`,
                      "/api/admin/ssh",
                      {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ command: cmd }),
                      },
                    );
                    setSshRunning(false);
                    if (result.ok && result.data) {
                      const data = result.data as {
                        stdout: string;
                        stderr: string;
                        exitCode: number;
                      };
                      setSshResults((prev) => [
                        {
                          command: cmd,
                          stdout: data.stdout,
                          stderr: data.stderr,
                          exitCode: data.exitCode,
                          timestamp: Date.now(),
                        },
                        ...prev,
                      ]);
                      setSshCmd("");
                    }
                  }}
                  className="ssh-form"
                >
                  <input
                    className="cs-input mono"
                    type="text"
                    placeholder="ls -la /tmp/openclaw/"
                    value={sshCmd}
                    onChange={(e) => setSshCmd(e.target.value)}
                    disabled={sshRunning || status.status !== "running"}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={
                      sshRunning ||
                      !sshCmd.trim() ||
                      status.status !== "running"
                    }
                  >
                    {sshRunning ? "Running…" : "Run"}
                  </button>
                </form>
                {status.status !== "running" && (
                  <p className="muted-copy" style={{ marginTop: 8 }}>
                    Sandbox must be running to execute commands.
                  </p>
                )}
                <div className="ssh-results">
                  {sshResults.map((r) => (
                    <div className="ssh-result" key={r.timestamp}>
                      <div className="ssh-result-head">
                        <code>$ {r.command}</code>
                        <span
                          className={`mono ssh-exit ${
                            r.exitCode === 0 ? "ok" : "fail"
                          }`}
                        >
                          exit {r.exitCode}
                        </span>
                      </div>
                      {r.stdout && <pre className="ssh-pre">{r.stdout}</pre>}
                      {r.stderr && (
                        <pre className="ssh-pre ssh-stderr">{r.stderr}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          {view === "logs" && (
            <section>
              <div className="section-header">
                <h2 className="section-title">Logs</h2>
                <button
                  type="button"
                  className={`fw-mode-pill${logsLive ? " active" : ""}`}
                  onClick={() => setLogsLive((v) => !v)}
                >
                  {logsLive ? "Live" : "Paused"}
                </button>
              </div>
              <div className="logs-filters">
                <input
                  className="cs-input"
                  type="text"
                  placeholder="Search logs…"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                />
                <div className="logs-level-row">
                  {ALL_LEVELS.map((lvl) => (
                    <label key={lvl} className="logs-lvl-check">
                      <input
                        type="checkbox"
                        checked={logLevels[lvl]}
                        onChange={() =>
                          setLogLevels((prev) => ({
                            ...prev,
                            [lvl]: !prev[lvl],
                          }))
                        }
                      />
                      <span className={`log-level ${lvl}`}>{lvl}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="logs-source-row">
                <button
                  type="button"
                  className={`fw-mode-pill${
                    logSource === "all" ? " active" : ""
                  }`}
                  onClick={() => setLogSource("all")}
                >
                  all
                </button>
                {ALL_SOURCES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`fw-mode-pill${
                      logSource === s ? " active" : ""
                    }`}
                    onClick={() => setLogSource(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="logs-table">
                {logs
                  .filter((l) => {
                    if (!logLevels[l.level]) return false;
                    if (logSource !== "all" && l.source !== logSource)
                      return false;
                    if (
                      logSearch &&
                      !l.message
                        .toLowerCase()
                        .includes(logSearch.toLowerCase())
                    )
                      return false;
                    return true;
                  })
                  .map((l) => {
                    const expanded = expandedLogIds.has(l.id);
                    const data = l.data ?? null;
                    const truncated = Boolean(
                      data && (data as Record<string, unknown>).__truncated,
                    );
                    const preview = truncated
                      ? String(
                          (data as Record<string, unknown>).__preview ?? "",
                        )
                      : "";
                    const originalBytes = truncated
                      ? Number(
                          (data as Record<string, unknown>).__originalBytes ??
                            0,
                        )
                      : 0;
                    const hasData =
                      data && Object.keys(data).length > 0;
                    return (
                      <div
                        className={`log-row main-log-row${expanded ? " expanded" : ""}`}
                        key={l.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => hasData && toggleExpanded(l.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && hasData) {
                            e.preventDefault();
                            toggleExpanded(l.id);
                          }
                        }}
                      >
                        <div className="log-meta">
                          <span>{fmtTimeOfDay(l.timestamp)}</span>
                          <span className={`log-level ${l.level}`}>
                            {l.level}
                          </span>
                          <span
                            style={{ color: "var(--foreground-subtle)" }}
                          >
                            {l.source}
                          </span>
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
                              onClick={() => copyLogAs(l, "text")}
                              title="Copy as text"
                            >
                              {copiedLogId === l.id &&
                              copiedLogMode === "text"
                                ? "✓"
                                : "copy ⎘"}
                            </button>
                            <button
                              type="button"
                              className="log-copy-btn"
                              onClick={() => copyLogAs(l, "json")}
                              title="Copy full entry as JSON"
                            >
                              {copiedLogId === l.id &&
                              copiedLogMode === "json"
                                ? "✓"
                                : "json ⎘"}
                            </button>
                          </div>
                        </div>
                        <div className="log-msg">{l.message}</div>
                        {expanded && hasData && (
                          <div className="log-data">
                            {truncated && (
                              <div className="log-trunc-callout">
                                ⚠ Truncated ({originalBytes.toLocaleString()}{" "}
                                bytes). View full in Vercel function logs.
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
                {logs.length === 0 && (
                  <p className="muted-copy">No logs collected yet.</p>
                )}
              </div>
            </section>
          )}

          {view === "snapshots" && (
            <section>
              <div className="section-header">
                <h2 className="section-title">Snapshots</h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pending !== null || status.status !== "running"}
                  onClick={async () => {
                    if (
                      typeof window !== "undefined" &&
                      !window.confirm(
                        "Take snapshot? This stops the running sandbox to snapshot, then restarts.",
                      )
                    )
                      return;
                    const r = await doAction(
                      "Create snapshot",
                      "/api/admin/snapshots",
                      {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ reason: "manual" }),
                      },
                    );
                    await fetchSnapshots();
                    if (r.ok) {
                      void doAction("Restarting", "/api/admin/ensure");
                    }
                  }}
                >
                  Take snapshot
                </button>
              </div>
              {snapshotsLoading && (
                <p className="muted-copy">Loading…</p>
              )}
              {!snapshotsLoading && snapshots.length === 0 && (
                <p className="muted-copy">No snapshots in history yet.</p>
              )}
              {snapshots.map((snap) => {
                const isCurrent = snap.snapshotId === status.snapshotId;
                return (
                  <div className="dense-row" key={snap.id}>
                    <div className="dense-col label">
                      <span
                        className={`status-dot ${
                          isCurrent ? "success" : "muted"
                        }`}
                      />
                      {isCurrent ? "Current" : snap.reason}
                    </div>
                    <div className="dense-col mono">
                      {truncate(snap.snapshotId, 42)}
                    </div>
                    <div className="dense-col right mono">
                      {fmtRelative(snap.timestamp)}
                    </div>
                    <div
                      className="dense-col right"
                      style={{ flex: "0 0 160px", display: "flex", gap: 6, justifyContent: "flex-end" }}
                    >
                      <button
                        type="button"
                        className="tiny-btn"
                        disabled={pending !== null || isCurrent}
                        onClick={() => {
                          if (
                            typeof window !== "undefined" &&
                            !window.confirm(
                              `Restore snapshot ${snap.snapshotId.slice(0, 12)}…? Unsaved state will be lost.`,
                            )
                          )
                            return;
                          void doAction(
                            `Restore ${snap.snapshotId.slice(0, 12)}…`,
                            "/api/admin/snapshots/restore",
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({
                                snapshotId: snap.snapshotId,
                              }),
                            },
                          );
                        }}
                      >
                        restore
                      </button>
                      <button
                        type="button"
                        className="tiny-btn tiny-danger"
                        disabled={pending !== null || isCurrent}
                        onClick={async () => {
                          if (
                            typeof window !== "undefined" &&
                            !window.confirm(
                              `Permanently delete ${snap.snapshotId.slice(0, 12)}…?`,
                            )
                          )
                            return;
                          const r = await doAction(
                            `Delete ${snap.snapshotId.slice(0, 12)}…`,
                            "/api/admin/snapshots/delete",
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({
                                snapshotId: snap.snapshotId,
                              }),
                            },
                          );
                          if (r.ok) await fetchSnapshots();
                        }}
                      >
                        delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {view === "faq" && (
            <section>
              <div className="section-header">
                <h2 className="section-title">FAQ</h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={faqLoading}
                  onClick={() => void fetchFaq()}
                >
                  {faqLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {faqError && (
                <p className="muted-copy" style={{ color: "var(--danger)" }}>
                  {faqError}
                </p>
              )}
              {faq?.warning && faq.warning !== "FAQ unavailable." && (
                <p className="muted-copy">{faq.warning}</p>
              )}
              {faq?.markdown && (
                <div className="faq-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {faq.markdown}
                  </ReactMarkdown>
                </div>
              )}
              {!faq && !faqLoading && !faqError && (
                <p className="muted-copy">Loading…</p>
              )}
            </section>
          )}

          <details className="mobile-logs">
            <summary>
              <span className="eyebrow">Live Logs</span>
              <span className="rail-meta">{logs.length} recent</span>
            </summary>
            <div className="mobile-logs-body">
              {logs.length === 0 && (
                <div className="rail-empty">No logs yet.</div>
              )}
              {logs.slice(0, RAIL_LOG_CAP).map((l) => {
                const truncated = Boolean(
                  l.data &&
                    (l.data as Record<string, unknown>).__truncated,
                );
                return (
                  <div className="log-row rail-log-row" key={l.id}>
                    <div className="log-meta">
                      <span>{fmtTimeOfDay(l.timestamp)}</span>
                      <span className={`log-level ${l.level}`}>{l.level}</span>
                      <span style={{ color: "var(--foreground-subtle)" }}>
                        {l.source}
                      </span>
                      {truncated && (
                        <span className="log-trunc-pill" title="Truncated">
                          ⚠
                        </span>
                      )}
                    </div>
                    <div className="log-msg log-msg-clip">{l.message}</div>
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      </div>

      <div
        className={`right-rail${view === "logs" ? " right-rail-hidden" : ""}`}
        aria-hidden={view === "logs"}
        onMouseEnter={() => setLogsHoverPaused(true)}
        onMouseLeave={() => setLogsHoverPaused(false)}
        onFocusCapture={() => setLogsHoverPaused(true)}
        onBlurCapture={() => setLogsHoverPaused(false)}
      >
        <div className="rail-header">
          <span className="rail-title">Live Logs</span>
          <span className="rail-meta">
            {logs.length} recent ·{" "}
            <span
              className={`status-dot ${logsHoverPaused || !logsLive ? "muted" : "success"}`}
              style={{ marginRight: 0 }}
              title={
                logsHoverPaused
                  ? "Paused (hover)"
                  : !logsLive
                    ? "Paused"
                    : "Live"
              }
            ></span>
          </span>
        </div>
        <div className="rail-content">
          {logs.length === 0 && (
            <div className="rail-empty">No logs yet. Polling /api/admin/logs…</div>
          )}
          {logs.slice(0, RAIL_LOG_CAP).map((l) => {
            const truncated = Boolean(
              l.data && (l.data as Record<string, unknown>).__truncated,
            );
            return (
              <div className="log-row rail-log-row" key={l.id}>
                <div className="log-meta">
                  <span>{fmtTimeOfDay(l.timestamp)}</span>
                  <span className={`log-level ${l.level}`}>{l.level}</span>
                  <span style={{ color: "var(--foreground-subtle)" }}>
                    {l.source}
                  </span>
                  {truncated && (
                    <span
                      className="log-trunc-pill"
                      title="Truncated — view in main Logs panel"
                    >
                      ⚠
                    </span>
                  )}
                  <button
                    type="button"
                    className="log-copy-btn rail-copy-btn"
                    onClick={() =>
                      copyLogAs(l, "text")
                    }
                    title="Copy"
                  >
                    {copiedLogId === l.id && copiedLogMode === "text"
                      ? "✓"
                      : "⎘"}
                  </button>
                </div>
                <div className="log-msg log-msg-clip">{l.message}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`nav-item${active ? " active" : ""}`}
      onClick={onClick}
    >
      <div className="nav-icon-text">{label}</div>
    </button>
  );
}

function FootRow({ label, val }: { label: string; val: string }) {
  return (
    <div className="footer-row">
      <span>{label}</span>
      <span className="footer-val">{val}</span>
    </div>
  );
}

function Metric({
  label,
  val,
  emphasized,
}: {
  label: string;
  val: number | undefined | null;
  emphasized?: boolean;
}) {
  return (
    <div
      className="metric-card"
      style={emphasized ? { background: "var(--background-hover)" } : undefined}
    >
      <span className="metric-val">{fmtMs(val)}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function Style() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        :root {
          --background: #000;
          --background-elevated: #0a0a0a;
          --background-hover: #111;
          --foreground: #ededed;
          --foreground-muted: #888;
          --foreground-subtle: #666;
          --border: rgba(255,255,255,0.08);
          --border-strong: rgba(255,255,255,0.14);
          --success: #45a557;
          --warning: #f5a623;
          --danger: #e5484d;
          --info: #0070f3;
          --radius: 8px;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background: var(--background);
          color: var(--foreground);
          font-family: var(--font-geist-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif);
          font-size: 13px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
        }
        a { color: inherit; text-decoration: none; }

        .layout { display: flex; height: 100vh; width: 100vw; overflow: hidden; }
        .sidebar {
          width: 240px; flex-shrink: 0;
          border-right: 1px solid var(--border);
          display: flex; flex-direction: column;
          background: var(--background-elevated);
        }
        .sidebar-header {
          height: 48px; padding: 0 16px;
          display: flex; align-items: center; gap: 12px;
          border-bottom: 1px solid var(--border);
        }
        .sidebar-title { font-weight: 500; font-size: 14px; color: var(--foreground); }
        .sidebar-nav {
          flex-grow: 1; padding: 16px 8px;
          display: flex; flex-direction: column; gap: 2px;
          overflow-y: auto;
          scrollbar-gutter: stable;
        }
        .nav-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 8px; border-radius: 6px;
          color: var(--foreground-muted);
          transition: background 150ms ease, color 150ms ease;
          cursor: pointer; user-select: none;
        }
        .nav-item:hover { background: var(--background-hover); color: var(--foreground); }
        .nav-item.active { background: var(--background-hover); color: var(--foreground); font-weight: 500; }
        .nav-icon-text { display: flex; align-items: center; gap: 8px; }
        .sidebar-footer {
          padding: 16px;
          border-top: 1px solid var(--border);
          display: flex; flex-direction: column; gap: 12px;
          font-size: 12px;
        }
        .footer-row { display: flex; justify-content: space-between; color: var(--foreground-muted); }
        .footer-val {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          color: var(--foreground-subtle);
          max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .main { flex-grow: 1; display: flex; flex-direction: column; min-width: 0; background: var(--background); }
        .toolbar {
          height: 48px; padding: 0 16px;
          border-bottom: 1px solid var(--border);
          display: flex; align-items: center; justify-content: space-between;
          background: var(--background); position: sticky; top: 0; z-index: 10;
        }
        .breadcrumb { display: flex; align-items: center; gap: 8px; color: var(--foreground-muted); font-family: var(--font-geist-mono, ui-monospace, monospace); font-size: 12px; }
        .breadcrumb .current { color: var(--foreground); font-weight: 500; }
        .breadcrumb .pending { color: var(--info); }
        .breadcrumb .action-msg { color: var(--foreground-subtle); }
        .command-palette-trigger {
          display: flex; align-items: center; gap: 12px;
          padding: 4px 8px 4px 12px;
          border: 1px solid var(--border); border-radius: 6px;
          background: var(--background-elevated);
          color: var(--foreground-muted);
          font-size: 12px; cursor: text; width: 240px;
          transition: border-color 150ms ease;
        }
        .command-palette-trigger:hover { border-color: var(--border-strong); }
        .command-palette-trigger .shortcuts { display: flex; gap: 4px; margin-left: auto; }

        .content {
          flex-grow: 1; overflow-y: auto;
          scrollbar-gutter: stable;
          padding: 32px 48px;
          display: flex; flex-direction: column; gap: 48px;
        }
        .section-header {
          display: flex; align-items: baseline; justify-content: space-between;
          margin-bottom: 16px; padding-bottom: 8px;
          border-bottom: 1px solid var(--border);
        }
        .section-title { font-size: 14px; font-weight: 600; margin: 0; color: var(--foreground); }
        .eyebrow {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--foreground-subtle);
        }
        .dense-row {
          display: flex; align-items: center;
          min-height: 28px; padding: 4px 0;
          border-bottom: 1px solid var(--border);
        }
        .dense-row:last-child { border-bottom: none; }
        .dense-col { flex: 1; min-width: 0; }
        .dense-col.label { color: var(--foreground-muted); flex: 0 0 180px; }
        .dense-col.mono { font-family: var(--font-geist-mono, ui-monospace, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dense-col.right { text-align: right; flex: 0 0 140px; }

        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; flex-shrink: 0; }
        .status-dot.success { background: var(--success); }
        .status-dot.warning { background: var(--warning); }
        .status-dot.danger { background: var(--danger); }
        .status-dot.info { background: var(--info); }
        .status-dot.muted { background: var(--foreground-subtle); }

        .status-badge {
          display: inline-flex; align-items: center;
          padding: 2px 8px;
          border: 1px solid var(--border); border-radius: 12px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px; line-height: 1;
          color: var(--foreground); background: var(--background-elevated);
        }

        .hero-panel {
          border: 1px solid var(--border); border-radius: var(--radius);
          background: var(--background-elevated); padding: 20px;
          display: flex; justify-content: space-between; align-items: center;
          gap: 24px; flex-wrap: wrap;
        }
        .hero-info { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
        .hero-id {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 16px; font-weight: 500; color: var(--foreground);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          max-width: 480px;
        }
        .hero-meta { display: flex; gap: 24px; color: var(--foreground-muted); font-size: 13px; flex-wrap: wrap; }
        .hero-meta-item { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
        .hero-meta-val {
          display: inline-block;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          color: var(--foreground);
          min-width: 7ch;
        }
        .hero-error {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          color: var(--danger); font-size: 12px; max-width: 600px;
        }
        .hero-actions { display: flex; gap: 12px; }

        .btn {
          display: inline-flex; align-items: center; justify-content: center;
          height: 32px; padding: 0 14px; border-radius: 6px;
          font-size: 13px; font-weight: 500; cursor: pointer;
          transition: all 150ms ease; border: 1px solid transparent;
          font-family: inherit;
        }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary { background: var(--foreground); color: var(--background); }
        .btn-primary:hover:not(:disabled) { background: #fff; }
        .btn-ghost { background: transparent; border-color: var(--border); color: var(--foreground); }
        .btn-ghost:hover:not(:disabled) { background: var(--background-hover); border-color: var(--border-strong); }
        .btn-danger { background: transparent; border-color: var(--danger); color: var(--danger); }
        .btn-danger:hover:not(:disabled) { background: rgba(229, 72, 77, 0.1); }
        .btn-success { background: transparent; border-color: var(--success); color: var(--success); text-decoration: none; }
        .btn-success:hover { background: rgba(69, 165, 87, 0.1); }
        .btn-warn { border-color: rgba(245, 166, 35, 0.35); color: var(--warning); }
        .btn-warn:hover:not(:disabled) { background: rgba(245, 166, 35, 0.08); border-color: var(--warning); }

        .reset-link {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px; margin: 0 -6px;
          background: transparent; border: 1px solid transparent;
          border-radius: 6px;
          color: var(--foreground-subtle);
          font-family: inherit; font-size: 12px;
          cursor: pointer;
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
        }
        .reset-link:hover:not(:disabled) {
          color: var(--danger);
          border-color: rgba(229, 72, 77, 0.25);
          background: rgba(229, 72, 77, 0.06);
        }
        .reset-link:disabled { opacity: 0.4; cursor: not-allowed; }
        .reset-link .reset-hint {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--foreground-subtle);
        }
        .reset-link:hover:not(:disabled) .reset-hint { color: var(--danger); }

        .user-cluster { display: flex; align-items: center; gap: 8px; }
        .signout-link {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          color: var(--foreground-muted);
          text-decoration: none;
          padding: 2px 6px;
          border: 1px solid transparent;
          border-radius: 4px;
          transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
        }
        .signout-link:hover {
          color: var(--foreground);
          border-color: var(--border-strong);
          background: var(--background-hover);
        }

        .metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 1px;
          background: var(--border);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .metric-card { background: var(--background); padding: 16px; display: flex; flex-direction: column; gap: 6px; }
        .metric-val { font-family: var(--font-geist-mono, ui-monospace, monospace); font-size: 14px; color: var(--foreground); }
        .metric-label { font-size: 12px; color: var(--foreground-muted); }

        .cli-block {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 16px;
          background: var(--background-elevated);
          border: 1px solid var(--border); border-radius: var(--radius);
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 13px; color: var(--foreground);
          gap: 12px; overflow: hidden;
        }
        .cli-block > div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .cli-prompt { color: var(--foreground-subtle); margin-right: 12px; user-select: none; }
        .cli-copy {
          background: transparent; border: 1px solid var(--border);
          color: var(--foreground-muted); cursor: pointer;
          padding: 4px 10px; border-radius: 4px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          transition: background 150ms ease, color 150ms ease;
          flex-shrink: 0;
        }
        .cli-copy:hover:not(:disabled) { color: var(--foreground); background: var(--background-hover); }
        .cli-copy:disabled { opacity: 0.4; cursor: not-allowed; }

        .right-rail {
          width: 320px; flex-shrink: 0;
          border-left: 1px solid var(--border);
          display: flex; flex-direction: column;
          background: var(--background);
        }
        @media (max-width: 900px) { .right-rail { display: none; } }
        .right-rail-hidden { display: none; }

        .toolbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .sidebar-toggle {
          display: none;
          width: 32px; height: 32px;
          flex-direction: column; justify-content: center; align-items: center;
          gap: 4px;
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 6px;
          cursor: pointer;
          padding: 0;
          flex-shrink: 0;
        }
        .sidebar-toggle:hover { border-color: var(--border-strong); }
        .sidebar-toggle span {
          display: block;
          width: 14px; height: 1px;
          background: var(--foreground-muted);
        }
        .sidebar-scrim {
          display: none;
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.6);
          z-index: 40;
        }
        .search-icon-btn {
          display: none;
          width: 32px; height: 32px;
          align-items: center; justify-content: center;
          background: var(--background-elevated);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--foreground-muted);
          cursor: pointer;
          flex-shrink: 0;
        }
        .search-icon-btn:hover { border-color: var(--border-strong); color: var(--foreground); }

        .mobile-logs { display: none; }
        .mobile-logs > summary {
          list-style: none;
          cursor: pointer;
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 0;
          border-top: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          user-select: none;
        }
        .mobile-logs > summary::-webkit-details-marker { display: none; }
        .mobile-logs[open] > summary { border-bottom-color: var(--border-strong); }
        .mobile-logs-body {
          display: flex; flex-direction: column; gap: 16px;
          padding: 16px 0;
        }

        @media (max-width: 900px) {
          .sidebar-toggle { display: inline-flex; }
          .sidebar-scrim { display: block; }
          .layout:not(.sidebar-open) .sidebar-scrim { display: none; }
          .sidebar {
            position: fixed;
            top: 0; left: 0;
            height: 100vh;
            width: min(280px, 80vw);
            z-index: 50;
            transform: translateX(-100%);
            transition: transform 200ms ease;
          }
          .sidebar.open { transform: translateX(0); }
          .mobile-logs { display: block; }
        }

        @media (max-width: 640px) {
          .command-palette-trigger { display: none; }
          .search-icon-btn { display: inline-flex; }
          .content {
            padding: 20px 16px;
            gap: 32px;
          }
          .hero-panel {
            flex-direction: column;
            align-items: stretch;
          }
          .hero-actions {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            width: 100%;
          }
          .hero-actions .btn { width: 100%; }
          .metrics-grid {
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          }
          .dense-col.label { flex: 0 0 120px; }
          .toolbar { padding: 0 12px; }
        }
        .rail-header {
          height: 48px; padding: 0 16px;
          border-bottom: 1px solid var(--border);
          display: flex; align-items: center; justify-content: space-between;
        }
        .rail-title { font-weight: 500; font-size: 13px; }
        .rail-meta { font-size: 11px; color: var(--foreground-subtle); display: flex; align-items: center; gap: 8px; font-family: var(--font-geist-mono, ui-monospace, monospace); }
        .rail-content {
          flex-grow: 1; overflow-y: auto;
          scrollbar-gutter: stable;
          padding: 16px;
          display: flex; flex-direction: column; gap: 16px;
        }
        .rail-empty { color: var(--foreground-subtle); font-size: 12px; font-family: var(--font-geist-mono, ui-monospace, monospace); }

        .log-row {
          display: flex; flex-direction: column; gap: 6px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 12px; line-height: 1.5;
          border-bottom: 1px solid var(--border);
          padding-bottom: 12px;
        }
        .log-row:last-child { border-bottom: none; padding-bottom: 0; }
        .log-meta { display: flex; gap: 12px; color: var(--foreground-subtle); }
        .log-level.info { color: var(--info); }
        .log-level.warn { color: var(--warning); }
        .log-level.error { color: var(--danger); }
        .log-level.debug { color: var(--foreground-subtle); }
        .log-msg { color: var(--foreground); word-break: break-word; }

        .pill {
          display: inline-flex; align-items: center;
          padding: 2px 8px; border-radius: 12px;
          background: var(--background-hover); color: var(--foreground);
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px; border: 1px solid var(--border);
        }

        .login-wrap {
          min-height: 100vh; display: flex; align-items: center; justify-content: center;
          background: var(--background); color: var(--foreground);
          font-family: var(--font-geist-sans, -apple-system, sans-serif);
          padding: 32px;
        }
        .login-card {
          width: 360px; padding: 32px;
          border: 1px solid var(--border); border-radius: var(--radius);
          background: var(--background-elevated);
          display: flex; flex-direction: column; gap: 16px;
        }
        .login-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
        .login-input {
          background: var(--background); color: var(--foreground);
          border: 1px solid var(--border); border-radius: 6px;
          padding: 10px 12px; font-size: 13px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          outline: none; transition: border-color 150ms ease;
        }
        .login-input:focus { border-color: var(--border-strong); }
        .login-error { color: var(--danger); font-size: 12px; font-family: var(--font-geist-mono, ui-monospace, monospace); }

        /* ─── Scoped Channels-panel overrides (align legacy panels with CommandShell theme) ─── */
        .cmd-channels { display: flex; flex-direction: column; gap: 24px; }
        .cmd-channels .panel-card {
          border-radius: var(--radius);
          padding: 20px;
          background: var(--background-elevated);
          border: 1px solid var(--border);
        }
        .cmd-channels .panel-head {
          padding-bottom: 12px;
          margin-bottom: 16px;
          border-bottom: 1px solid var(--border);
          align-items: baseline;
        }
        .cmd-channels h2, .cmd-channels h3 {
          font-weight: 600;
          letter-spacing: -0.01em;
        }
        .cmd-channels h2 { font-size: 14px; }
        .cmd-channels h3 { font-size: 13px; }
        .cmd-channels .eyebrow {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--foreground-subtle);
          margin: 0 0 8px;
        }
        .cmd-channels .lede,
        .cmd-channels .muted-copy,
        .cmd-channels p {
          font-size: 12px;
          line-height: 1.5;
          color: var(--foreground-muted);
        }
        .cmd-channels .button {
          min-height: 32px;
          padding: 0 14px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
        }
        .cmd-channels .button.primary {
          background: var(--foreground);
          border-color: var(--foreground);
          color: var(--background);
        }
        .cmd-channels .button.primary:hover:not(:disabled) {
          background: #fff;
          border-color: #fff;
        }
        .cmd-channels .button.ghost {
          background: transparent;
          border-color: var(--border);
          color: var(--foreground);
        }
        .cmd-channels .button.ghost:hover:not(:disabled) {
          background: var(--background-hover);
          border-color: var(--border-strong);
        }
        .cmd-channels .button.success {
          background: transparent;
          border-color: var(--success);
          color: var(--success);
        }
        .cmd-channels .button.success:hover:not(:disabled) {
          background: rgba(69, 165, 87, 0.08);
          border-color: var(--success);
          color: var(--success);
        }
        .cmd-channels .button.danger {
          background: transparent;
          border-color: var(--danger);
          color: var(--danger);
        }
        .cmd-channels .button.danger:hover:not(:disabled) {
          background: rgba(229, 72, 77, 0.08);
          color: var(--danger);
        }
        .cmd-channels .field-label {
          display: block;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--foreground-subtle);
          margin: 0 0 6px;
        }
        .cmd-channels .text-input {
          background: var(--background);
          color: var(--foreground);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          width: 100%;
        }
        .cmd-channels .text-input:focus {
          border-color: var(--border-strong);
          outline: none;
        }
        .cmd-channels .auth-chip,
        .cmd-channels .pill {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 12px;
          background: var(--background-hover);
          color: var(--foreground);
          border: 1px solid var(--border);
          min-height: auto;
        }
        .cmd-channels .panel-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        }
        /* Channel grid: equal-height cards, responsive columns, bottom-anchored actions */
        .cmd-channels .channel-grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          align-items: start;
          margin-top: 20px;
        }
        @media (max-width: 720px) {
          .cmd-channels .channel-grid {
            grid-template-columns: 1fr;
          }
        }
        .cmd-channels .channel-card {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 18px;
          height: 100%;
          min-width: 0;
        }
        .cmd-channels .channel-card > * {
          min-width: 0;
        }
        /* Card header: title/summary on the left, pill pinned top-right */
        .cmd-channels .channel-head {
          display: flex;
          flex-wrap: nowrap;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--border);
        }
        .cmd-channels .channel-head > div {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .cmd-channels .channel-head h3 {
          margin: 0;
          line-height: 1.3;
          word-break: break-word;
        }
        .cmd-channels .channel-pill {
          flex: 0 0 auto;
          white-space: nowrap;
          align-self: flex-start;
        }
        /* Pin the primary action row to the bottom of each card */
        .cmd-channels .channel-card .inline-actions {
          margin-top: auto;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding-top: 4px;
        }
        .cmd-channels .channel-card .inline-actions .button {
          flex: 1 1 auto;
          min-width: 0;
          white-space: nowrap;
        }
        /* Port status reads as a quiet inline line, not a bordered chip */
        .cmd-channels .port-status-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 0;
          border: 0;
          background: transparent;
        }
        .cmd-channels .port-status-header {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--foreground-subtle);
        }
        .cmd-channels .port-status-header .field-label {
          margin: 0;
        }
        .cmd-channels .port-status-message {
          font-size: 11px;
          text-transform: none;
          letter-spacing: normal;
          color: var(--foreground-muted);
          min-width: 0;
          flex: 1 1 auto;
          overflow-wrap: anywhere;
        }
        .cmd-channels .port-status-dot {
          flex: 0 0 auto;
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }
        /* Breathing room between stacked sections inside the form body */
        .cmd-channels .channel-wizard {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1 1 auto;
        }
        .cmd-channels .channel-wizard > * + * {
          margin-top: 0;
        }
        .cmd-channels .channel-card .stack {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .cmd-channels code {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 12px;
          background: var(--background);
          padding: 1px 6px;
          border-radius: 4px;
          border: 1px solid var(--border);
        }
        .cmd-channels a:not(.button) {
          color: var(--foreground);
          text-decoration: underline;
          text-decoration-color: var(--border-strong);
          text-underline-offset: 3px;
        }
        .cmd-channels a:not(.button):hover {
          text-decoration-color: var(--foreground);
        }

        /* Button-ified NavItem */
        button.nav-item {
          width: 100%; border: none; background: transparent;
          text-align: left; font-family: inherit; font-size: 13px;
          color: var(--foreground-muted);
        }

        .error-inline {
          display: flex; flex-direction: column; gap: 6px;
          padding: 12px 16px;
          border: 1px solid rgba(229, 72, 77, 0.3); border-radius: var(--radius);
          background: rgba(229, 72, 77, 0.06);
        }
        .error-inline-msg {
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          color: var(--danger); font-size: 12px; word-break: break-word;
        }

        .setup-steps { display: flex; flex-direction: column; gap: 6px; }
        .setup-step {
          display: flex; align-items: center; gap: 10px;
          font-size: 13px; color: var(--foreground-subtle);
        }
        .setup-step.active { color: var(--foreground); }
        .setup-step-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--foreground-subtle);
        }
        .setup-step.active .setup-step-dot { background: var(--info); }

        .fw-mode-pills { display: flex; gap: 4px; }
        .fw-mode-pill {
          padding: 4px 10px; border-radius: 12px;
          border: 1px solid var(--border); background: var(--background-elevated);
          color: var(--foreground-muted);
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px; cursor: pointer;
          transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
        }
        .fw-mode-pill:hover:not(:disabled) { color: var(--foreground); border-color: var(--border-strong); }
        .fw-mode-pill.active {
          color: var(--background);
          border-color: var(--foreground);
          background: var(--foreground);
          font-weight: 600;
        }
        .fw-mode-pill.active:hover:not(:disabled) {
          color: var(--background);
          border-color: var(--foreground);
          background: var(--foreground);
        }
        .fw-mode-pill:disabled { opacity: 0.8; cursor: default; }

        .fw-wouldblock {
          padding: 12px; margin-top: 12px;
          border: 1px solid rgba(245, 166, 35, 0.25); border-radius: var(--radius);
          background: rgba(245, 166, 35, 0.05);
          display: flex; flex-direction: column; gap: 8px;
        }
        .fw-chip-list {
          list-style: none; margin: 0; padding: 0;
          display: flex; flex-wrap: wrap; gap: 6px;
        }
        .fw-chip-list li {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px;
          background: var(--background-elevated);
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
        }
        .tiny-btn {
          background: transparent; border: 1px solid var(--border); border-radius: 4px;
          padding: 2px 6px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 10px; color: var(--foreground-muted); cursor: pointer;
          transition: color 150ms ease, border-color 150ms ease;
        }
        .tiny-btn:hover:not(:disabled) { color: var(--foreground); border-color: var(--border-strong); }
        .tiny-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .tiny-btn.tiny-danger:hover:not(:disabled) { color: var(--danger); border-color: rgba(229, 72, 77, 0.35); }

        .fw-row {
          display: flex; flex-direction: column; gap: 6px;
          margin-top: 16px;
        }
        .fw-row-inputs { display: flex; gap: 8px; flex-wrap: wrap; }
        .cs-input {
          background: var(--background); color: var(--foreground);
          border: 1px solid var(--border); border-radius: 6px;
          padding: 8px 10px; font-size: 13px;
          font-family: var(--font-geist-sans, sans-serif);
          outline: none; min-width: 0; flex: 1;
          transition: border-color 150ms ease;
        }
        .cs-input.mono { font-family: var(--font-geist-mono, ui-monospace, monospace); }
        .cs-input:focus { border-color: var(--border-strong); }
        textarea.cs-input { resize: vertical; }

        .fw-split {
          display: grid; grid-template-columns: 1fr 1fr; gap: 24px;
          margin-top: 24px;
        }
        @media (max-width: 900px) { .fw-split { grid-template-columns: 1fr; } }

        .ssh-form { display: flex; gap: 8px; margin-top: 8px; }
        .ssh-results { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
        .ssh-result {
          border: 1px solid var(--border); border-radius: var(--radius);
          background: var(--background-elevated);
          padding: 10px 12px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .ssh-result-head {
          display: flex; justify-content: space-between; align-items: center;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 12px;
        }
        .ssh-exit.ok { color: var(--success); }
        .ssh-exit.fail { color: var(--danger); }
        .ssh-pre {
          margin: 0; white-space: pre-wrap; word-break: break-word;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 12px; color: var(--foreground);
          max-height: 240px; overflow: auto;
          scrollbar-gutter: stable;
        }
        .ssh-pre.ssh-stderr { color: var(--warning); }

        .logs-filters { display: flex; gap: 12px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
        .logs-level-row { display: flex; gap: 12px; }
        .logs-lvl-check {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px; color: var(--foreground-muted); cursor: pointer;
        }
        .logs-source-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
        .logs-table { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; max-height: 560px; overflow: auto; scrollbar-gutter: stable; }

        .main-log-row {
          cursor: default;
          padding: 8px 10px;
          border-radius: 4px;
          border: 1px solid transparent;
          border-bottom: 1px solid var(--border);
          transition: background-color 150ms ease, border-color 150ms ease;
        }
        .main-log-row:hover { background: var(--background-hover); }
        .main-log-row.expanded {
          background: var(--background-elevated);
          border-color: var(--border);
        }
        .main-log-row:focus-visible {
          outline: 1px solid var(--foreground-muted);
          outline-offset: 1px;
        }
        .main-log-row .log-meta {
          align-items: center;
          gap: 10px;
        }
        .log-copy-row {
          margin-left: auto; display: inline-flex; gap: 4px;
          opacity: 0;
          transition: opacity 150ms ease;
        }
        .main-log-row:hover .log-copy-row,
        .main-log-row.expanded .log-copy-row { opacity: 1; }
        .log-copy-btn {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--foreground-muted);
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
          cursor: pointer;
          transition: color 150ms ease, border-color 150ms ease;
        }
        .log-copy-btn:hover { color: var(--foreground); border-color: var(--border-strong); }
        .rail-copy-btn { border: none; padding: 0 4px; margin-left: auto; }
        .log-trunc-pill {
          display: inline-flex; align-items: center;
          padding: 1px 6px;
          border-radius: 3px;
          border: 1px solid var(--warning);
          color: var(--warning);
          font-size: 10px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
        }
        .log-expand-hint {
          color: var(--foreground-subtle); font-size: 10px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
        }
        .log-data {
          margin-top: 8px;
          padding: 10px 12px;
          background: var(--background);
          border: 1px solid var(--border);
          border-radius: 4px;
          font-family: var(--font-geist-mono, ui-monospace, monospace);
          font-size: 11px;
          overflow-x: auto;
        }
        .log-trunc-callout {
          color: var(--warning);
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--border);
        }
        .log-trunc-preview {
          color: var(--foreground-muted);
          margin-top: 4px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .jt-block { display: flex; flex-direction: column; gap: 2px; }
        .jt-row { display: flex; gap: 6px; align-items: baseline; }
        .jt-key { color: var(--foreground-subtle); flex-shrink: 0; }
        .jt-str { color: var(--info); word-break: break-word; }
        .jt-num { color: var(--warning); }
        .jt-bool { color: var(--success); }
        .jt-null { color: var(--foreground-subtle); font-style: italic; }
        .jt-empty { color: var(--foreground-subtle); }

        .log-msg-clip {
          display: -webkit-box;
          -webkit-line-clamp: 1;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-all;
        }
        .rail-log-row .log-meta { align-items: center; gap: 8px; }

        .faq-content {
          font-size: 13px; line-height: 1.6; color: var(--foreground);
          margin-top: 8px;
        }
        .faq-content h1, .faq-content h2, .faq-content h3 {
          margin-top: 24px; margin-bottom: 8px; color: var(--foreground);
          font-weight: 600;
        }
        .faq-content h1 { font-size: 18px; }
        .faq-content h2 { font-size: 15px; }
        .faq-content h3 { font-size: 13px; }
        .faq-content p { margin: 8px 0; }
        .faq-content code {
          background: var(--background-elevated); padding: 2px 6px; border-radius: 4px;
          font-family: var(--font-geist-mono, ui-monospace, monospace); font-size: 12px;
          border: 1px solid var(--border);
        }
        .faq-content pre {
          background: var(--background-elevated); padding: 12px; border-radius: var(--radius);
          border: 1px solid var(--border); overflow-x: auto;
        }
        .faq-content pre code { background: transparent; border: none; padding: 0; }
        .faq-content a { color: var(--info); text-decoration: underline; }
        .faq-content ul, .faq-content ol { padding-left: 20px; }
        .faq-content blockquote {
          border-left: 2px solid var(--border-strong); padding-left: 12px;
          color: var(--foreground-muted); margin: 12px 0;
        }
      `,
      }}
    />
  );
}
