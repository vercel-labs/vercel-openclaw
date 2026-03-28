import { useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type {
  RunAction,
  RequestJson,
  TelegramPreviewPayload,
  StatusPayload,
} from "@/components/admin-types";

type TelegramPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

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
        successMessage: "Telegram bot previewed",
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
      label: "Save Telegram",
      successMessage: "Telegram connected",
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
      label: "Disconnect Telegram",
      successMessage: "Telegram disconnected",
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
      successMessage: "Telegram commands synced",
      method: "POST",
    });
    setSyncingCommands(false);
  }

  return (
    <section className="channel-card channel-telegram">
      <div className="channel-head">
        <div>
          <h3>Telegram</h3>
          <p className="muted-copy">
            {tg.configured
              ? `Connected${tg.botUsername ? ` \u00b7 @${tg.botUsername}` : ""}`
              : "Not configured"}
          </p>
        </div>
        <ChannelPill
          variant={
            tg.configured
              ? tg.status === "error"
                ? "bad"
                : "good"
              : "idle"
          }
        >
          {tg.configured
            ? tg.status === "error"
              ? "error"
              : "connected"
            : "offline"}
        </ChannelPill>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {tg.lastError ? <p className="error-banner">{tg.lastError}</p> : null}
      {tg.commandSyncError ? (
        <p className="error-banner">Command sync: {tg.commandSyncError}</p>
      ) : null}
      <ConnectabilityNotice connectability={tg.connectability} suppressedIds={preflightBlockerIds} />

      {tg.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Bot</span>
            <code className="inline-code">
              @{tg.botUsername ?? "unknown"}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Webhook URL</span>
            <div className="channel-copy-row">
              <code className="inline-code channel-copy-code">
                {tg.webhookUrl ?? "\u2014"}
              </code>
              {tg.webhookUrl ? (
                <button
                  className="button ghost channel-copy-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(tg.webhookUrl!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              ) : null}
            </div>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Commands</span>
            <code className="inline-code">
              {tg.commandSyncStatus}
              {tg.commandsRegisteredAt
                ? ` \u00b7 ${new Date(tg.commandsRegisteredAt).toLocaleString()}`
                : ""}
            </code>
          </div>
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

          <div className="stack">
            <span className="field-label">Bot token</span>
            <div className="channel-token-row">
              <input
                className="text-input"
                type={showToken ? "text" : "password"}
                value={botToken}
                onChange={(event) => {
                  setBotToken(event.target.value);
                  setPreview(null);
                }}
                placeholder="123456:ABC-DEF1234..."
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
              <button
                type="button"
                className="button ghost channel-toggle-btn"
                onClick={() => setShowToken((s) => !s)}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </div>

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
              {editing ? "Update Credentials" : "Save Credentials"}
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
    </section>
  );
}
