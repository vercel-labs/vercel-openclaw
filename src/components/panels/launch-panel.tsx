"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { StatusPayload, RequestJson } from "@/components/admin-types";
import type {
  LaunchVerificationPayload,
  LaunchVerificationPhase,
  ChannelReadiness,
} from "@/shared/launch-verification";

type LaunchPanelProps = {
  status: StatusPayload;
  busy: boolean;
  requestJson: RequestJson;
};

function phaseStatusIcon(phase: LaunchVerificationPhase): string {
  switch (phase.status) {
    case "pass":
      return "\u2713";
    case "fail":
      return "\u2717";
    case "skip":
      return "\u2013";
    case "running":
      return "\u2026";
  }
}

function phaseStatusClass(phase: LaunchVerificationPhase): string {
  switch (phase.status) {
    case "pass":
      return "launch-phase-pass";
    case "fail":
      return "launch-phase-fail";
    case "skip":
      return "launch-phase-skip";
    case "running":
      return "launch-phase-running";
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function loadPersistedReadiness(): Promise<ChannelReadiness | null> {
  try {
    const res = await fetch("/api/admin/launch-verify", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as ChannelReadiness) : null;
  } catch {
    return null;
  }
}

type StreamPhaseEvent = { type: "phase"; phase: LaunchVerificationPhase };
type StreamResultEvent = {
  type: "result";
  payload: LaunchVerificationPayload & { channelReadiness?: ChannelReadiness };
};
type StreamEvent = StreamPhaseEvent | StreamResultEvent;

export function LaunchPanel({ status, busy, requestJson }: LaunchPanelProps) {
  const [result, setResult] = useState<LaunchVerificationPayload | null>(null);
  const [readiness, setReadiness] = useState<ChannelReadiness | null>(null);
  const [running, setRunning] = useState(false);
  const [streamingPhases, setStreamingPhases] = useState<LaunchVerificationPhase[]>([]);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPersistedReadiness().then((data) => {
      if (!cancelled && data) {
        setReadiness(data);
      }
    });
    return () => { cancelled = true; };
  }, []);

  async function runVerification(mode: "safe" | "destructive"): Promise<void> {
    setRunning(true);
    setStreamingPhases([]);
    setResult(null);
    setExpanded(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/admin/launch-verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        const msg = payload?.error?.message ?? `HTTP ${response.status}`;
        toast.error(msg);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        toast.error("No response stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as StreamEvent;
            if (event.type === "phase") {
              setStreamingPhases((prev) => {
                const existing = prev.findIndex((p) => p.id === event.phase.id);
                if (existing >= 0) {
                  const next = [...prev];
                  next[existing] = event.phase;
                  return next;
                }
                return [...prev, event.phase];
              });
            } else if (event.type === "result") {
              setResult(event.payload);
              setStreamingPhases([]);
              if (event.payload.channelReadiness) {
                setReadiness(event.payload.channelReadiness);
              }
              if (!event.payload.ok) {
                setExpanded(true);
                const failing = event.payload.phases.find((p) => p.status === "fail");
                if (failing) {
                  toast.error(`Verification failed at ${failing.id}: ${failing.error ?? failing.message}`);
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const displayResult = result;
  const displayReadiness = readiness;
  const isStreaming = running && streamingPhases.length > 0;
  const isVerified = displayReadiness?.ready === true;
  const isFailed = displayResult && !displayResult.ok;

  const totalMs = displayResult
    ? new Date(displayResult.completedAt).getTime() - new Date(displayResult.startedAt).getTime()
    : 0;

  const showPersistedPhases = !displayResult && !isStreaming && displayReadiness && displayReadiness.phases.length > 0;

  const completedStreamCount = streamingPhases.filter(
    (p) => p.status !== "running",
  ).length;
  const totalPhaseCount = 5;
  const progressPct = isStreaming
    ? Math.round((completedStreamCount / totalPhaseCount) * 100)
    : 0;

  const showDetails = expanded || isStreaming || isFailed || !isVerified;

  return (
    <article className="panel-card full-span">
      <div className="panel-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <p className="eyebrow">Deployment Diagnostics</p>
            {!isVerified && <h2>Verify end-to-end connectivity</h2>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {displayReadiness && (
            <span
              className={`status-badge ${displayReadiness.ready ? "running" : "error"}`}
            >
              {displayReadiness.ready ? "Passed" : "Not Verified"}
            </span>
          )}
          {displayResult && (
            <span
              className={`status-badge ${displayResult.ok ? "running" : "error"}`}
            >
              {displayResult.ok ? "Verified" : "Failed"}
            </span>
          )}
        </div>
      </div>

      {isVerified && !isStreaming && !isFailed && (
        <div className="launch-verified-summary">
          <span className="muted-copy">
            Verified {displayReadiness.verifiedAt ? formatTimestamp(displayReadiness.verifiedAt) : ""}
            {displayResult ? ` in ${formatDuration(totalMs)}` : ""}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="button ghost"
              disabled={busy || running}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide details" : "Show details"}
            </button>
            <button
              className="button ghost"
              disabled={busy || running}
              onClick={() => void runVerification("destructive")}
            >
              Re-verify
            </button>
          </div>
        </div>
      )}

      {!isVerified && !isStreaming && (
        <div className="hero-actions">
          <button
            className="button primary"
            disabled={busy || running}
            onClick={() => void runVerification("destructive")}
            title="Runs full verification including stop/restore cycle"
          >
            {running ? "Verifying\u2026" : "Run Verification"}
          </button>
          <button
            className="button ghost"
            disabled={busy || running}
            onClick={() => void runVerification("safe")}
            title="Quick diagnostic \u2014 does not unlock channels"
          >
            Quick Check
          </button>
        </div>
      )}

      {isStreaming && (
        <div style={{ marginTop: 16 }}>
          <div className="launch-progress-bar" style={{ marginBottom: 12 }}>
            <div
              className="launch-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="launch-phases">
            {streamingPhases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">
                  {phaseStatusIcon(phase)}
                </span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">
                    {formatDuration(phase.durationMs)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {displayResult && showDetails && (
        <div style={{ marginTop: 16 }}>
          <div
            className="metrics-grid"
            style={{ marginBottom: 12 }}
          >
            <div>
              <dt>Mode</dt>
              <dd>{displayResult.mode}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(totalMs)}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{formatTimestamp(displayResult.completedAt)}</dd>
            </div>
          </div>

          <div className="launch-phases">
            {displayResult.phases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">
                  {phaseStatusIcon(phase)}
                </span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">
                    {formatDuration(phase.durationMs)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {displayResult.phases.some((p) => p.status === "fail" && p.error) && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              {displayResult.phases
                .filter((p) => p.status === "fail" && p.error)
                .map((p) => (
                  <p key={p.id} style={{ margin: "4px 0" }}>
                    <strong>{p.id}:</strong> {p.error}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}

      {showPersistedPhases && showDetails && (
        <div style={{ marginTop: 16 }}>
          <div
            className="metrics-grid"
            style={{ marginBottom: 12 }}
          >
            <div>
              <dt>Mode</dt>
              <dd>{displayReadiness.mode ?? "\u2014"}</dd>
            </div>
            <div>
              <dt>Last verified</dt>
              <dd>{displayReadiness.verifiedAt ? formatTimestamp(displayReadiness.verifiedAt) : "\u2014"}</dd>
            </div>
          </div>

          <div className="launch-phases">
            {displayReadiness.phases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">
                  {phaseStatusIcon(phase)}
                </span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">
                    {formatDuration(phase.durationMs)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
