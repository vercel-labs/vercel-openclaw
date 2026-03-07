"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { SnapshotRecord } from "@/shared/types";
import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";

const REASON_LABELS: Record<string, string> = {
  manual: "Manual",
  auto: "Auto",
  bootstrap: "Bootstrap",
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
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
};

export function SnapshotsPanel({
  status,
  busy,
  runAction,
  requestJson,
}: SnapshotsPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const { confirm, dialogProps } = useConfirm();

  const isRunning = status.status === "running";

  const fetchSnapshots = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void fetchSnapshots();
  }, [fetchSnapshots]);

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

    const result = await requestJson<{ status: string }>("/api/admin/snapshots/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId }),
      label: `Restore ${snapshotId.slice(0, 12)}...`,
    });
    if (result) {
      toast.success("Restore initiated");
    }
  };

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Snapshots</p>
          <h2>Snapshot history.</h2>
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
      {snapshots.length === 0 && !loading && (
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
                  onClick={() => void handleRestore(snap.snapshotId)}
                >
                  Restore
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog {...dialogProps} />
    </article>
  );
}
