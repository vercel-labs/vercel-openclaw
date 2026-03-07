import { useCallback, useEffect, useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { DiscordPanel } from "@/components/panels/discord-panel";

type ChannelSummaryEntry = {
  connected: boolean;
  queueDepth: number;
  deadLetterCount: number;
  lastError: string | null;
};

type ChannelSummary = {
  slack: ChannelSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
};

type ChannelsPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function ChannelsPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: ChannelsPanelProps) {
  const [summary, setSummary] = useState<ChannelSummary | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/channels/summary", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        setSummary((await res.json()) as ChannelSummary);
      }
    } catch {
      // Best-effort
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const totalQueue =
    (summary?.slack.queueDepth ?? 0) +
    (summary?.telegram.queueDepth ?? 0) +
    (summary?.discord.queueDepth ?? 0);

  const totalDL =
    (summary?.slack.deadLetterCount ?? 0) +
    (summary?.telegram.deadLetterCount ?? 0) +
    (summary?.discord.deadLetterCount ?? 0);

  return (
    <article className="panel-card full-span">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>External entry points.</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {totalQueue > 0 && (
            <ChannelPill variant="good">{totalQueue} queued</ChannelPill>
          )}
          {totalDL > 0 && (
            <ChannelPill variant="bad">{totalDL} dead-letter</ChannelPill>
          )}
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => {
              void refresh();
              void fetchSummary();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

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
    </article>
  );
}
