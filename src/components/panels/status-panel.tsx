"use client";

import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { StatusPayload, RunAction } from "@/components/admin-types";

type StatusPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
};

export function StatusPanel({ status, busy, runAction }: StatusPanelProps) {
  const { confirm: confirmStop, dialogProps: stopDialogProps } = useConfirm();
  const { confirm: confirmSnapshot, dialogProps: snapshotDialogProps } =
    useConfirm();

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
      method: "POST",
    });
  }

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2>Sandbox status</h2>
        </div>
        <StatusBadge status={status.status} />
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
          <dt>Firewall</dt>
          <dd>{status.firewall.mode}</dd>
        </div>
      </dl>

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
        <a
          className="button accent"
          href={status.gatewayUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open gateway
        </a>
        <button
          className="button ghost"
          disabled={busy}
          onClick={() => void handleStop()}
        >
          Snapshot and stop
        </button>
        <button
          className="button ghost"
          disabled={busy}
          onClick={() => void handleSnapshot()}
        >
          Snapshot now
        </button>
      </div>

      {status.lastError ? (
        <p className="error-banner">{status.lastError}</p>
      ) : null}

      <ConfirmDialog {...stopDialogProps} />
      <ConfirmDialog {...snapshotDialogProps} />
    </article>
  );
}
