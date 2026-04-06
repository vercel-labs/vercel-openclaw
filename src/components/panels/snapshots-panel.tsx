"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { SnapshotRecord, SingleStatus } from "@/shared/types";
import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";
import { fetchAdminJsonCore, type ReadJsonDeps } from "@/components/admin-request-core";

/** How this snapshot was created (stored on each history row). */
const REASON_LABELS: Record<string, string> = {
  /** "Take snapshot" on this page */
  manual: "Manual",
  auto: "Auto",
  bootstrap: "Bootstrap",
  /** Status → Stop (or POST /api/admin/stop / snapshot) — not a button here */
  stop: "Saved on stop",
};

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type SnapshotsPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  readDeps: ReadJsonDeps;
};

export function SnapshotsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
  readDeps,
}: SnapshotsPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const { confirm, dialogProps } = useConfirm();
  const { confirm: confirmReset, dialogProps: resetDialogProps } = useConfirm();

  const lifecycleStatus = status.status as SingleStatus;
  const isRunning = lifecycleStatus === "running";
  const isLifecycleTransition = new Set<SingleStatus>([
    "creating",
    "restoring",
    "booting",
    "setup",
  ]).has(lifecycleStatus);
  const isResetDisabled =
    busy || lifecycleStatus === "uninitialized" || isLifecycleTransition;

  const fetchSnapshots = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      const result = await fetchAdminJsonCore<{ snapshots: SnapshotRecord[] }>(
        "/api/admin/snapshots",
        readDeps,
        { toastError: false },
      );
      if (result.ok) {
        setSnapshots(result.data.snapshots);
        setReadError(null);
        return;
      }
      setReadError(result.error);
    } finally {
      setLoading(false);
    }
  }, [active, readDeps, snapshots.length]);

  useEffect(() => {
    if (!active) return;
    void fetchSnapshots();
  }, [active, fetchSnapshots]);

  const handleSnapshot = async () => {
    await runAction("/api/admin/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual" }),
      label: "Create snapshot",
    });
    await fetchSnapshots();
  };

  const handleRestore = async (snapshotId: string) => {
    const ok = await confirm({
      title: "Restore snapshot?",
      description: `This will stop the current sandbox and restore from snapshot ${snapshotId.slice(0, 12)}... Any unsaved state will be lost.`,
      confirmLabel: "Restore",
      variant: "danger",
    });
    if (!ok) return;

    await requestJson<{ status: string }>("/api/admin/snapshots/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId }),
      label: `Restore ${snapshotId.slice(0, 12)}...`,
    });
  };

  const handleDelete = async (snapshotId: string) => {
    const ok = await confirm({
      title: "Delete snapshot?",
      description: `Permanently delete ${snapshotId.slice(0, 12)}... from Vercel? This cannot be undone. You cannot delete the snapshot you would restore from (current).`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;

    const result = await requestJson<{ ok: boolean }>("/api/admin/snapshots/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId }),
      label: `Delete ${snapshotId.slice(0, 12)}...`,
    });
    if (result.ok) {
      await fetchSnapshots();
    }
  };

  const handleReset = async () => {
    const ok = await confirmReset({
      title: "Reset sandbox from scratch?",
      description:
        "This deletes the current sandbox and all saved snapshots, then starts a fresh install of OpenClaw. Unsaved runtime state, installed packages, and in-sandbox changes will be lost.",
      confirmLabel: "Reset Sandbox",
      variant: "danger",
    });
    if (!ok) return;

    const success = await runAction("/api/admin/reset", {
      label: "Reset Sandbox",
      method: "POST",
    });
    if (success) {
      setSnapshots([]);
    }
  };

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <h2>Snapshot history</h2>
          <p className="muted-copy snapshots-intro">
            Current is the active restore point. The tag shows how it was created.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={busy || !isRunning}
          onClick={() => void handleSnapshot()}
        >
          Take snapshot
        </button>
      </div>

      <dl className="metrics-grid snapshots-summary">
        <div>
          <dt>OpenClaw</dt>
          <dd>{status.openclawVersion ?? "unknown"}</dd>
        </div>
        <div>
          <dt>SDK</dt>
          <dd>{status.sandboxSdkVersion ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Snapshots</dt>
          <dd>{loading ? "\u2026" : snapshots.length}</dd>
        </div>
      </dl>

      {readError && (
        <p className="error-banner">
          {snapshots.length > 0
            ? `Showing last successful snapshot list. Latest refresh failed: ${readError}`
            : `Failed to load snapshots: ${readError}`}
        </p>
      )}

      {/* Snapshot list — fixed min-height avoids CLS when count changes */}
      <div className="snapshot-list-container">
        {loading && snapshots.length === 0 && (
          <div className="snapshot-loading">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        )}
        {!loading && snapshots.length === 0 && (
          <p className="empty-token">No snapshots in history yet.</p>
        )}
      </div>

      <ul className="token-list">
        {snapshots.map((snap) => {
          const isCurrent = snap.snapshotId === status.snapshotId;
          return (
            <li
              key={snap.id}
              className={isCurrent ? "snapshot-current" : undefined}
            >
              <div>
                <div className="snapshot-row-header">
                  <code>{snap.snapshotId}</code>
                  <span
                    className={`snapshot-badge ${isCurrent ? "snapshot-badge-current" : "snapshot-badge-available"}`}
                  >
                    {isCurrent ? "Current" : "Available"}
                  </span>
                  <span className={`snapshot-reason snapshot-reason-${snap.reason}`}>
                    {REASON_LABELS[snap.reason] ?? snap.reason}
                  </span>
                </div>
                <p className="event-meta">
                  {relativeTime(snap.timestamp)} &middot;{" "}
                  {new Date(snap.timestamp).toLocaleString()}
                </p>
              </div>
              <div className="snapshot-row-actions">
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy || isCurrent}
                  onClick={() => void handleDelete(snap.snapshotId)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy || isCurrent}
                  onClick={() => void handleRestore(snap.snapshotId)}
                >
                  Restore
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="danger-zone">
        <p className="danger-zone-label">Danger zone</p>
        <div className="danger-zone-card">
          <div className="danger-zone-body">
            <div className="danger-zone-copy">
              <p className="danger-zone-title">Reset sandbox</p>
              <p className="danger-zone-text">
                Delete the current sandbox and snapshots, then build a fresh one.
              </p>
            </div>
            <button
              className="button danger"
              disabled={isResetDisabled}
              onClick={() => void handleReset()}
              type="button"
            >
              Reset Sandbox
            </button>
          </div>
        </div>
      </section>
      <ConfirmDialog {...dialogProps} />
      <ConfirmDialog {...resetDialogProps} />
    </article>
  );
}
