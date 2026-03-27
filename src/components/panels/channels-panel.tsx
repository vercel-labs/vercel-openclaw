import { useEffect, useState } from "react";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { WhatsAppPanel } from "@/components/panels/whatsapp-panel";

type PreflightAction = {
  id: string;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

type PreflightData = {
  ok: boolean;
  actions: PreflightAction[];
};

type ChannelsPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

async function loadPreflightData(): Promise<PreflightData | null> {
  const res = await fetch("/api/admin/preflight", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return res.ok ? ((await res.json()) as PreflightData) : null;
}

export function ChannelsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: ChannelsPanelProps) {
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void loadPreflightData()
      .then((data) => { if (!cancelled) setPreflight(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  async function refreshPanelData(): Promise<void> {
    const nextPreflight = await loadPreflightData().catch(() => null);
    if (nextPreflight) setPreflight(nextPreflight);
  }

  return (
    <article className="panel-card full-span">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>External entry points</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36 }}>
          <button
            className="button ghost"
            disabled={busy || refreshing}
            onClick={() => {
              setRefreshing(true);
              void Promise.all([refresh(), refreshPanelData()])
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? "Refreshing\u2026" : "Refresh"}
          </button>
        </div>
      </div>

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
        <WhatsAppPanel
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
