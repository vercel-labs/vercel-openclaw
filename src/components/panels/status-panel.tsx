"use client";

import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { StatusPayload, RunAction } from "@/components/admin-types";

type StatusPanelProps = {
  status: StatusPayload;
  busy: boolean;
  pendingAction: string | null;
  runAction: RunAction;
};

const NEEDS_RESTART = new Set(["error", "stopped", "uninitialized"]);
const IS_TRANSITIONAL = new Set(["creating", "restoring", "booting", "setup"]);

function friendlyError(raw: string): { headline: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("gateway never became ready") || lower.includes("gateway_ready_timeout")) {
    return {
      headline: "Gateway didn't respond in time",
      detail: "This can happen after a deployment or token rotation. Restarting usually fixes it.",
    };
  }
  if (lower.includes("snapshot storage") || lower.includes("snapshot_not_found")) {
    return {
      headline: "Snapshot unavailable",
      detail: "The snapshot could not be loaded. Check your Upstash connection or create a new sandbox.",
    };
  }
  if (lower.includes("oidc") || lower.includes("token") || lower.includes("ai gateway")) {
    return {
      headline: "AI Gateway authentication failed",
      detail: "This usually resolves on the next attempt when a fresh token is issued.",
    };
  }
  if (lower.includes("command") && lower.includes("failed")) {
    return {
      headline: "A setup command failed during restore",
      detail: "The sandbox started but a configuration step failed. Restarting usually fixes it.",
    };
  }
  return {
    headline: "Sandbox encountered an error",
    detail: "An unexpected error occurred during the last operation.",
  };
}

export function StatusPanel({ status, busy, pendingAction, runAction }: StatusPanelProps) {
  const { confirm: confirmStop, dialogProps: stopDialogProps } = useConfirm();
  const { confirm: confirmSnapshot, dialogProps: snapshotDialogProps } =
    useConfirm();

  function handleRestart(): void {
    void runAction("/api/admin/ensure", {
      label: "Restart sandbox",
      successMessage: "Sandbox restart initiated",
      method: "POST",
    });
  }

  async function handleStop(): Promise<void> {
    const ok = await confirmStop({
      title: "Stop sandbox?",
      description:
        "This will snapshot the current state and stop the sandbox. You can restore it later from the snapshot.",
      confirmLabel: "Snapshot & stop",
      variant: "danger",
    });
    if (!ok) return;
    void runAction("/api/admin/stop", {
      label: "Stop sandbox",
      successMessage: "Sandbox stopped",
      method: "POST",
    });
  }

  async function handleSnapshot(): Promise<void> {
    const ok = await confirmSnapshot({
      title: "Take snapshot?",
      description:
        "This will create a point-in-time snapshot of the running sandbox. The sandbox will continue running.",
      confirmLabel: "Take snapshot",
    });
    if (!ok) return;
    void runAction("/api/admin/snapshot", {
      label: "Take snapshot",
      successMessage: "Snapshot created",
      method: "POST",
    });
  }

  const isStopping = pendingAction === "Stop sandbox";
  const displayStatus = isStopping ? "stopping" : status.status;
  const showRestart = NEEDS_RESTART.has(status.status);
  const showRunningActions = status.status === "running" && !isStopping;
  const isTransitional = IS_TRANSITIONAL.has(status.status) || isStopping;

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2>Sandbox status</h2>
        </div>
        <StatusBadge status={displayStatus} />
      </div>

      <dl className="metrics-grid">
        <div>
          <dt>Sandbox ID</dt>
          <dd>{status.sandboxId ?? "none"}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{status.snapshotId ?? "none"}</dd>
        </div>
        <div>
          <dt>Auth mode</dt>
          <dd>{status.authMode}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>
            {status.storeBackend}
            {status.persistentStore ? "" : " (memory only)"}
          </dd>
        </div>
        <div>
          <dt>Gateway</dt>
          <dd>{status.gatewayReady ? "Ready" : "Not ready"}</dd>
        </div>
        <div>
          <dt>Sleep after</dt>
          <dd>{Math.round(status.sleepAfterMs / 60_000)}m</dd>
        </div>
        {status.timeoutRemainingMs != null && (
          <div>
            <dt>Timeout left</dt>
            <dd>{Math.round(status.timeoutRemainingMs / 1000)}s</dd>
          </div>
        )}
        <div>
          <dt>Firewall</dt>
          <dd>{status.firewall.mode}</dd>
        </div>
      </dl>

      <div className="hero-actions" style={{ justifyContent: "flex-end" }}>
        {showRestart && (
          <button
            className="button success"
            disabled={busy}
            onClick={handleRestart}
          >
            Restart sandbox
          </button>
        )}
        {showRunningActions && (
          <>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleSnapshot()}
            >
              Save snapshot
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              Stop
            </button>
            <a
              className="button success"
              href={status.gatewayUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open VClaw
            </a>
          </>
        )}
        {isTransitional && (
          <button className="button ghost" disabled>
            {isStopping ? "Stopping\u2026" : "Starting\u2026"}
          </button>
        )}
      </div>

      {status.lastError ? (
        <div className="error-banner">
          <p style={{ margin: 0, fontWeight: 500 }}>
            {friendlyError(status.lastError).headline}
          </p>
          <p style={{ margin: "4px 0 0", opacity: 0.85 }}>
            {friendlyError(status.lastError).detail}
          </p>
          <details style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            <summary>Technical details</summary>
            <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {status.lastError}
            </pre>
          </details>
        </div>
      ) : null}

      <ConfirmDialog {...stopDialogProps} />
      <ConfirmDialog {...snapshotDialogProps} />
    </article>
  );
}
