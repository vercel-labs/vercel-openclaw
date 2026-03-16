import { useEffect, useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { DiscordPanel } from "@/components/panels/discord-panel";
import type { ChannelReadiness } from "@/shared/launch-verification";

type ChannelSummaryEntry = {
  connected: boolean;
  queueDepth: number;
  failedCount: number;
  lastError: string | null;
};

type ChannelSummary = {
  slack: ChannelSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
};

type PreflightAction = {
  id: string;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

type PreflightNextStep = {
  id: string;
  label: string;
  description: string;
};

type PreflightData = {
  ok: boolean;
  actions: PreflightAction[];
  nextSteps: PreflightNextStep[];
};

type ChannelsPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
  channelReadiness?: ChannelReadiness | null;
};

async function loadChannelSummary(): Promise<ChannelSummary | null> {
  const res = await fetch("/api/channels/summary", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return res.ok ? ((await res.json()) as ChannelSummary) : null;
}

async function loadPreflightData(): Promise<PreflightData | null> {
  const res = await fetch("/api/admin/preflight", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return res.ok ? ((await res.json()) as PreflightData) : null;
}

export function ChannelsPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
  channelReadiness,
}: ChannelsPanelProps) {
  const [summary, setSummary] = useState<ChannelSummary | null>(null);
  const [preflight, setPreflight] = useState<PreflightData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadChannelSummary()
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => {});
    void loadPreflightData()
      .then((data) => { if (!cancelled) setPreflight(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function refreshPanelData(): void {
    void Promise.all([
      loadChannelSummary().catch(() => null),
      loadPreflightData().catch(() => null),
    ]).then(([nextSummary, nextPreflight]) => {
      if (nextSummary) setSummary(nextSummary);
      if (nextPreflight) setPreflight(nextPreflight);
    });
  }

  const totalQueue =
    (summary?.slack.queueDepth ?? 0) +
    (summary?.telegram.queueDepth ?? 0) +
    (summary?.discord.queueDepth ?? 0);

  const totalDL =
    (summary?.slack.failedCount ?? 0) +
    (summary?.telegram.failedCount ?? 0) +
    (summary?.discord.failedCount ?? 0);

  const isReady = channelReadiness?.ready === true;

  return (
    <article className="panel-card full-span">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>External entry points</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isReady && (
            <ChannelPill variant="good">Verified</ChannelPill>
          )}
          {totalQueue > 0 && (
            <ChannelPill variant="good">{totalQueue} queued</ChannelPill>
          )}
          {totalDL > 0 && (
            <ChannelPill variant="bad">{totalDL} failed</ChannelPill>
          )}
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => {
              void refresh();
              refreshPanelData();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {!isReady && (
        <div className="connectability-warning-banner" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontWeight: 500 }}>
            Launch verification required before connecting channels.
          </p>
          <p className="muted-copy" style={{ margin: "4px 0 0" }}>
            {channelReadiness?.failingPhaseId
              ? `Last attempt failed at "${channelReadiness.failingPhaseId}". `
              : ""}
            Run <strong>Verify &amp; Unlock Channels</strong> above to prove the full queue, wake, and reply path works.
          </p>
        </div>
      )}

      {preflight && !preflight.ok ? (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontWeight: 500 }}>
            Deployment blockers must be resolved before connecting channels.
          </p>
          {preflight.actions
            .filter((a) => a.status === "required")
            .map((action) => (
              <p key={action.id} className="muted-copy" style={{ margin: "4px 0 0" }}>
                {action.remediation}
              </p>
            ))}
        </div>
      ) : null}

      {preflight?.nextSteps && preflight.nextSteps.length > 0 && preflight.ok ? (
        <div className="connectability-warning-banner" style={{ marginBottom: 16 }}>
          {preflight.nextSteps.map((step) => (
            <p key={step.id} className="muted-copy" style={{ margin: "2px 0" }}>
              <strong>{step.label}:</strong> {step.description}
            </p>
          ))}
        </div>
      ) : null}

      {isReady ? (
        <div className="channel-grid">
          <SlackPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
          <TelegramPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
          <DiscordPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
        </div>
      ) : (
        <div className="channel-grid" style={{ opacity: 0.5, pointerEvents: "none" }}>
          <SlackPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
          <TelegramPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
          <DiscordPanel
            status={status}
            busy={busy}
            runAction={runAction}
            requestJson={requestJson}
            refresh={refresh}
          />
        </div>
      )}
    </article>
  );
}
