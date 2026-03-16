"use client";

import { useEffect, useState } from "react";
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
  onReadinessChange?: (readiness: ChannelReadiness | null) => void;
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

export function LaunchPanel({ status, busy, requestJson, onReadinessChange }: LaunchPanelProps) {
  const [result, setResult] = useState<LaunchVerificationPayload | null>(null);
  const [readiness, setReadiness] = useState<ChannelReadiness | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPersistedReadiness().then((data) => {
      if (!cancelled && data) {
        setReadiness(data);
        onReadinessChange?.(data);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runVerification(mode: "safe" | "destructive"): Promise<void> {
    setRunning(true);
    try {
      const payload = await requestJson<LaunchVerificationPayload & { channelReadiness?: ChannelReadiness }>(
        "/api/admin/launch-verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
          label: "Verify deployment",
          refreshAfter: false,
        },
      );
      if (payload) {
        setResult(payload);
        if (payload.channelReadiness) {
          setReadiness(payload.channelReadiness);
          onReadinessChange?.(payload.channelReadiness);
        }
        if (!payload.ok) {
          const failing = payload.phases.find((p) => p.status === "fail");
          if (failing) {
            toast.error(`Verification failed at ${failing.id}: ${failing.error ?? failing.message}`);
          }
        }
      }
    } finally {
      setRunning(false);
    }
  }

  // Use persisted readiness phases when no fresh result exists
  const displayResult = result;
  const displayReadiness = readiness;

  const totalMs = displayResult
    ? new Date(displayResult.completedAt).getTime() - new Date(displayResult.startedAt).getTime()
    : 0;

  // Show persisted readiness info even without a fresh run
  const showPersistedPhases = !displayResult && displayReadiness && displayReadiness.phases.length > 0;

  return (
    <article className="panel-card full-span">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Launch Verification</p>
          <h2>Prove this deployment works end-to-end</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {displayReadiness && (
            <span
              className={`status-badge ${displayReadiness.ready ? "running" : "error"}`}
            >
              {displayReadiness.ready ? "Channels Ready" : "Not Ready"}
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

      <div className="hero-actions">
        <button
          className="button primary"
          disabled={busy || running}
          onClick={() => void runVerification("destructive")}
          title="Runs full verification including stop/restore cycle"
        >
          {running ? "Verifying\u2026" : "Verify & Unlock Channels"}
        </button>
        <button
          className="button ghost"
          disabled={busy || running}
          onClick={() => void runVerification("safe")}
          title="Quick diagnostic — does not unlock channels"
        >
          Quick Check
        </button>
      </div>

      {displayResult && (
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

      {showPersistedPhases && (
        <div style={{ marginTop: 16 }}>
          <div
            className="metrics-grid"
            style={{ marginBottom: 12 }}
          >
            <div>
              <dt>Mode</dt>
              <dd>{displayReadiness.mode ?? "—"}</dd>
            </div>
            <div>
              <dt>Last verified</dt>
              <dd>{displayReadiness.verifiedAt ? formatTimestamp(displayReadiness.verifiedAt) : "—"}</dd>
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
