"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { SnapshotRecord, SingleStatus } from "@/shared/types";
import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";

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
};

export function SnapshotsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
}: SnapshotsPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [loading, setLoading] = useState(true);
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
      const res = await fetch("/api/admin/snapshots", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { snapshots: SnapshotRecord[] };
        setSnapshots(data.snapshots);
      }
    } catch {
      // Best-effort
    } finally {
      setLoading(false);
    }
  }, [active]);

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
      successMessage: "Snapshot created",
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
      successMessage: "Restore initiated",
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
      successMessage: "Snapshot deleted",
    });
    if (result?.ok) {
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

    await runAction("/api/admin/reset", {
      label: "Reset Sandbox",
      successMessage: "Sandbox reset initiated",
      method: "POST",
    });
  };

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Snapshots</p>
          <h2>Snapshot history</h2>
          <p
            className="event-meta"
            style={{ marginTop: 6, maxWidth: 520, lineHeight: 1.45 }}
          >
            The tag after Current/Available is{" "}
            <strong>how it was saved</strong>:{" "}
            <em>Saved on stop</em> means the sandbox was stopped from Status (or
            Stop elsewhere); <em>Manual</em> means you used Take snapshot here.
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

      {/* Current snapshot */}
      <dl className="metrics-grid" style={{ marginBottom: 16 }}>
        <div>
          <dt>Current snapshot</dt>
          <dd>{status.snapshotId ?? "none"}</dd>
        </div>
        <div>
          <dt>History count</dt>
          <dd>{loading ? "..." : snapshots.length}</dd>
        </div>
      </dl>

      {/* Snapshot list */}
      {loading && snapshots.length === 0 && (
        <div className="snapshot-loading">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      )}
      {!loading && snapshots.length === 0 && (
        <p className="empty-token">No snapshots in history yet.</p>
      )}

      <ul className="token-list">
        {snapshots.map((snap) => {
          const isCurrent = snap.snapshotId === status.snapshotId;
          return (
            <li
              key={snap.id}
              className={isCurrent ? "snapshot-current" : undefined}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
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

      <section className="mt-7">
        <p className="mb-2 text-xs font-medium leading-5 text-[var(--foreground-subtle)]">
          Danger zone
        </p>
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-80 flex-1">
              <p className="m-0 font-semibold">Reset Sandbox</p>
              <p className="mt-2 max-w-2xl text-[var(--foreground-muted)] leading-6">
                Delete the current sandbox and all saved snapshots, then create
                a brand new sandbox from scratch. Use this when the environment
                is stuck, corrupted, or you want a clean rebuild.
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
