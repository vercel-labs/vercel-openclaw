import { useState } from "react";
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
  refresh: () => Promise<void>;
};

export function TelegramPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: TelegramPanelProps) {
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [preview, setPreview] = useState<TelegramPreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const { confirm, dialogProps } = useConfirm();

  const tg = status.channels.telegram;

  async function handlePreview(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const payload = await requestJson<TelegramPreviewPayload>(
      "/api/channels/telegram/preview",
      {
        label: "Preview Telegram bot",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
        refreshAfter: false,
      },
    );
    if (payload) {
      setPreview(payload);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    try {
      await requestJson("/api/channels/telegram", {
        label: "Save Telegram",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      setBotToken("");
      setPreview(null);
      setEditing(false);
      setShowToken(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to connect",
      );
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
    try {
      await runAction("/api/channels/telegram", {
        label: "Disconnect Telegram",
        method: "DELETE",
      });
      setEditing(false);
      setBotToken("");
      setPreview(null);
      setShowToken(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to disconnect",
      );
    }
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {tg.queueDepth > 0 && (
            <span className="channel-pill good">{tg.queueDepth} queued</span>
          )}
          <span
            className={`channel-pill ${
              tg.status === "connected"
                ? "good"
                : tg.status === "error"
                  ? "bad"
                  : ""
            }`}
          >
            {tg.status === "connected"
              ? "connected"
              : tg.status === "error"
                ? "error"
                : "offline"}
          </span>
        </div>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {tg.lastError ? <p className="error-banner">{tg.lastError}</p> : null}
      <ConnectabilityNotice connectability={tg.connectability} />

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
            <code className="inline-code">{tg.webhookUrl ?? "\u2014"}</code>
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
              Update token
            </button>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
      ) : (
        <div className="channel-wizard">
          <p className="channel-wizard-title">
            {editing ? "Update Bot Token" : "Connect Telegram Bot"}
          </p>

          {!editing && (
            <div className="channel-wizard-steps">
              <div className="channel-wizard-step">
                <span className="channel-step-number">1</span>
                <span className="muted-copy">
                  Open{" "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                    className="channel-link"
                  >
                    @BotFather
                  </a>{" "}
                  on Telegram and create a bot with <code>/newbot</code>
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">2</span>
                <span className="muted-copy">
                  Copy the bot token and paste it below
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">3</span>
                <span className="muted-copy">
                  Click <strong>Preview bot</strong> to validate, then{" "}
                  <strong>Save &amp; Connect</strong>
                </span>
              </div>
            </div>
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
              className="button secondary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
              onClick={() => void handlePreview()}
            >
              Preview bot
            </button>
            <button
              className="button primary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
              onClick={() => void handleConnect()}
            >
              {editing ? "Update" : "Save & Connect"}
            </button>
            {editing && (
              <button
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
          {!tg.connectability.canConnect ? (
            <p className="muted-copy">
              Resolve the deployment blockers above before saving the Telegram bot token.
            </p>
          ) : null}
        </div>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
