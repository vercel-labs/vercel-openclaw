import { useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  RunAction,
  RequestJson,
  TelegramPreviewPayload,
  StatusPayload,
} from "@/components/admin-types";
import type { ChannelPillModel } from "@/components/panels/channel-panel-shared";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  ChannelSecretField,
  getChannelActionLabel,
} from "@/components/panels/channel-panel-shared";

type TelegramPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

function getTelegramPill(args: {
  configured: boolean;
  status: string;
}): ChannelPillModel {
  if (!args.configured) {
    return { label: "offline", variant: "idle" };
  }
  if (args.status === "error") {
    return { label: "error", variant: "bad" };
  }
  return { label: "connected", variant: "good" };
}

function getTelegramHealth(args: {
  commandSyncStatus?: "synced" | "unsynced" | "error";
  commandsRegisteredAt?: number | null;
}): string {
  const base =
    args.commandSyncStatus === "error"
      ? "Command sync failed"
      : args.commandSyncStatus === "synced"
        ? "Commands synced"
        : "Commands pending";
  if (!args.commandsRegisteredAt) {
    return base;
  }
  return `${base} · ${new Date(args.commandsRegisteredAt).toLocaleString()}`;
}

export function TelegramPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
}: TelegramPanelProps) {
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [preview, setPreview] = useState<TelegramPreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [syncingCommands, setSyncingCommands] = useState(false);
  const [copied, setCopied] = useState(false);
  const { confirm, dialogProps } = useConfirm();

  const tg = status.channels.telegram;

  async function handlePreview(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson<TelegramPreviewPayload>(
      "/api/channels/telegram/preview",
      {
        label: "Preview Telegram bot",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
        refreshAfter: false,
      },
    );
    if (result.ok && result.data) {
      setPreview(result.data);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson("/api/channels/telegram", {
      label: getChannelActionLabel("telegram", editing ? "update" : "connect"),
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken: botToken.trim() }),
    });
    if (result.ok) {
      setBotToken("");
      setPreview(null);
      setEditing(false);
      setShowToken(false);
    } else {
      setPanelError(result.error);
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect Telegram?",
      description:
        "This will remove the bot token and stop processing messages from this Telegram bot.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;

    setPanelError(null);
    const success = await runAction("/api/channels/telegram", {
      label: getChannelActionLabel("telegram", "disconnect"),
      method: "DELETE",
    });
    if (success) {
      setEditing(false);
      setBotToken("");
      setPreview(null);
      setShowToken(false);
    }
  }

  async function handleSyncCommands(): Promise<void> {
    setPanelError(null);
    setSyncingCommands(true);
    await runAction("/api/channels/telegram/sync-commands", {
      label: "Sync Telegram commands",
      method: "POST",
    });
    setSyncingCommands(false);
  }

  function handleCopyWebhook(): void {
    if (!tg.webhookUrl) return;
    void navigator.clipboard.writeText(tg.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <ChannelCardFrame
      channel="telegram"
      configured={tg.configured}
      channelClassName="channel-telegram"
      title="Telegram"
      summary={
        tg.configured
          ? `Connected${tg.botUsername ? ` · @${tg.botUsername}` : ""}`
          : "Not configured"
      }
      pill={getTelegramPill({ configured: tg.configured, status: tg.status })}
      errors={[panelError, tg.lastError]}
      connectability={tg.connectability}
      suppressedIds={preflightBlockerIds}
    >
      {tg.configured && !editing ? (
        <div className="channel-connected-view">
          <ChannelInfoRow label="Bot">
            <code className="inline-code">
              @{tg.botUsername ?? "unknown"}
            </code>
          </ChannelInfoRow>
          <ChannelCopyValue
            label="Webhook URL"
            value={tg.webhookUrl}
            copied={copied}
            onCopy={handleCopyWebhook}
          />
          <ChannelInfoRow label="Commands">
            <code className="inline-code">
              {getTelegramHealth({
                commandSyncStatus: tg.commandSyncStatus,
                commandsRegisteredAt: tg.commandsRegisteredAt,
              })}
            </code>
          </ChannelInfoRow>
          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPanelError(null);
                setEditing(true);
              }}
            >
              Update credentials
            </button>
            <button
              className="button secondary"
              disabled={busy || syncingCommands}
              onClick={() => void handleSyncCommands()}
            >
              {syncingCommands ? "Syncing\u2026" : "Sync commands"}
            </button>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form className="channel-wizard" onSubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
          <p className="channel-wizard-title">
            {editing ? "Update Credentials" : "Connect Telegram"}
          </p>

          {!editing && (
            <p className="muted-copy">
              Paste the token from{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="channel-link"
              >
                @BotFather
              </a>{" "}
              (<code>/newbot</code>).
            </p>
          )}

          <ChannelSecretField
            label="Bot token"
            value={botToken}
            onChange={(v) => {
              setBotToken(v);
              setPreview(null);
            }}
            placeholder="123456:ABC-DEF1234..."
            shown={showToken}
            onToggleShown={() => setShowToken((s) => !s)}
          />

          {preview ? (
            <p className="success-copy">
              Bot preview: {preview.bot.first_name}
              {preview.bot.username ? ` (@${preview.bot.username})` : ""}
            </p>
          ) : null}

          <div className="inline-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
              onClick={() => void handlePreview()}
            >
              Preview bot
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
            >
              {editing ? "Update" : "Connect"}
            </button>
            {editing && (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setEditing(false);
                  setBotToken("");
                  setPreview(null);
                  setPanelError(null);
                  setShowToken(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
