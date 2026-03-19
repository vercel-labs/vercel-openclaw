"use client";

import { useEffect, useState } from "react";
import type { ChannelQueueHealthPayload } from "@/shared/channel-queue-health";

const POLL_MS = 10_000;

function statusLabel(item: ChannelQueueHealthPayload["channels"][number]): string {
  if (item.hasFailures) return "needs attention";
  if (item.hasBacklog) return "busy";
  return "clear";
}

function statusClass(item: ChannelQueueHealthPayload["channels"][number]): string {
  if (item.hasFailures) return "queue-status-fail";
  if (item.hasBacklog) return "queue-status-busy";
  return "queue-status-clear";
}

export function ChannelQueueHealthCard() {
  const [payload, setPayload] = useState<ChannelQueueHealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/admin/channels/health", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ChannelQueueHealthPayload;
        if (!cancelled) {
          setPayload(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <article className="panel-card full-span queue-health-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Message queues</p>
        </div>
        {payload && (
          <span className="mono" style={{ fontSize: 11, opacity: 0.5 }}>
            Updated {new Date(payload.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error ? (
        <p className="error-banner">Failed to load queue health: {error}</p>
      ) : (
        <div className="queue-grid">
          {payload ? (
            payload.channels.map((item) => (
              <div key={item.channel} className={`queue-channel-card ${statusClass(item)}`}>
                <div className="queue-channel-head">
                  <span className="queue-channel-name">{item.channel}</span>
                  <span className="queue-channel-status">{statusLabel(item)}</span>
                </div>
                <div className="queue-channel-counts">
                  <span className="queue-count">
                    <span className="queue-count-value">{item.counts.queued}</span>
                    <span className="queue-count-label">queued</span>
                  </span>
                  <span className="queue-count">
                    <span className="queue-count-value">{item.counts.processing}</span>
                    <span className="queue-count-label">processing</span>
                  </span>
                  <span className="queue-count">
                    <span className="queue-count-value">{item.counts.failed}</span>
                    <span className="queue-count-label">failed</span>
                  </span>
                </div>
              </div>
            ))
          ) : (
            ["slack", "telegram", "discord"].map((ch) => (
              <div key={ch} className="queue-channel-card queue-skeleton">
                <div className="queue-channel-head">
                  <span className="queue-channel-name">{ch}</span>
                  <span className="queue-channel-status">&mdash;</span>
                </div>
                <div className="queue-channel-counts">
                  <span className="queue-count">
                    <span className="queue-count-value">&mdash;</span>
                    <span className="queue-count-label">queued</span>
                  </span>
                  <span className="queue-count">
                    <span className="queue-count-value">&mdash;</span>
                    <span className="queue-count-label">processing</span>
                  </span>
                  <span className="queue-count">
                    <span className="queue-count-value">&mdash;</span>
                    <span className="queue-count-label">failed</span>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </article>
  );
}
