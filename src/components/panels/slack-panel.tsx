import { useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
  SlackTestPayload,
} from "@/components/admin-types";

type SlackPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

export function SlackPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
}: SlackPanelProps) {
  const [signingSecret, setSigningSecret] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testResult, setTestResult] = useState<SlackTestPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { confirm, dialogProps } = useConfirm();
  const sl = status.channels.slack;
  const botTokenValid = /^xoxb-/.test(botToken.trim());

  function clearDrafts(): void {
    setSigningSecret("");
    setBotToken("");
    setShowSecret(false);
    setShowToken(false);
    setTestResult(null);
    setPanelError(null);
  }

  async function handleTestToken(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson<SlackTestPayload>(
      "/api/channels/slack/test",
      {
        label: "Test Slack token",
        successMessage: "Slack token verified",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
        refreshAfter: false,
      },
    );
    if (result.ok && result.data) {
      setTestResult(result.data);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!signingSecret.trim() || !botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson("/api/channels/slack", {
      label: "Save Slack",
      successMessage: "Slack connected",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signingSecret: signingSecret.trim(),
        botToken: botToken.trim(),
      }),
    });
    if (result.ok) {
      clearDrafts();
      setEditing(false);
    } else {
      setPanelError(result.error);
    }
  }

  async function handleCreateApp(): Promise<void> {
    const result = await requestJson<{ createAppUrl: string }>(
      "/api/channels/slack/manifest",
      {
        label: "Create Slack app",
        successMessage: "Slack app manifest opened",
        method: "GET",
        refreshAfter: false,
      },
    );
    if (result.ok && result.data?.createAppUrl) {
      window.open(result.data.createAppUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect Slack?",
      description:
        "This will remove the Slack credentials and stop processing messages from this workspace.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;

    setPanelError(null);
    const success = await runAction("/api/channels/slack", {
      label: "Disconnect Slack",
      successMessage: "Slack disconnected",
      method: "DELETE",
    });
    if (success) {
      clearDrafts();
      setEditing(false);
    }
  }

  function handleCopyWebhook(): void {
    void navigator.clipboard.writeText(sl.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="channel-card channel-slack">
      <div className="channel-head">
        <div>
          <h3>Slack</h3>
          <p className="muted-copy">
            {sl.configured
              ? `Connected${sl.team ? ` · ${sl.team}` : ""}`
              : "Not configured"}
          </p>
        </div>
        <ChannelPill variant={sl.configured ? "good" : "idle"}>
          {sl.configured ? "connected" : "offline"}
        </ChannelPill>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {sl.lastError ? <p className="error-banner">{sl.lastError}</p> : null}
      <ConnectabilityNotice connectability={sl.connectability} suppressedIds={preflightBlockerIds} />

      {sl.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Workspace</span>
            <code className="inline-code">
              {sl.team ?? "—"}
              {sl.botId ? ` · ${sl.botId}` : ""}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Webhook URL</span>
            <div className="channel-copy-row">
              <code className="inline-code channel-copy-code">
                {sl.webhookUrl}
              </code>
              <button
                className="button ghost channel-copy-btn"
                onClick={handleCopyWebhook}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
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
            {editing ? "Update Credentials" : "Connect Slack"}
          </p>

          {!editing ? (
            <div className="inline-actions" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void handleCreateApp()}
              >
                Create Slack App
              </button>
              <span className="muted-copy">or</span>
              <a
                className="button ghost"
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noreferrer"
              >
                Open existing app
              </a>
            </div>
          ) : null}

          <div className="stack">
            <span className="field-label">Signing Secret</span>
            <p className="muted-copy">
              Basic Information → App Credentials → Signing Secret
            </p>
            <div className="channel-token-row">
              <input
                className="text-input"
                type={showSecret ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
                placeholder="Signing Secret"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
              <button
                type="button"
                className="button ghost channel-toggle-btn"
                onClick={() => setShowSecret((v) => !v)}
              >
                {showSecret ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="stack">
            <span className="field-label">Bot Token</span>
            <p className="muted-copy">
              OAuth & Permissions → Bot User OAuth Token (starts with xoxb-)
            </p>
            <div className="channel-token-row">
              <input
                className="text-input"
                type={showToken ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={botToken}
                onChange={(event) => {
                  setBotToken(event.target.value);
                  setTestResult(null);
                }}
                placeholder="xoxb-..."
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
              <button
                type="button"
                className="button ghost channel-toggle-btn"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            {botToken.trim() && !botTokenValid ? (
              <p className="channel-validation-error">
                Bot token must start with xoxb-
              </p>
            ) : null}
          </div>

          {botTokenValid ? (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void handleTestToken()}
            >
              Test Connection
            </button>
          ) : null}

          {testResult?.ok ? (
            <p className="success-copy">
              Connected to {testResult.team} as {testResult.user}
            </p>
          ) : null}

          {!editing ? (
            <div className="stack">
              <span className="field-label">Webhook URL</span>
              <p className="muted-copy">
                Paste in Event Subscriptions after saving.
              </p>
              <div className="channel-copy-row">
                <code className="inline-code channel-copy-code">
                  {sl.webhookUrl}
                </code>
                <button
                  type="button"
                  className="button ghost channel-copy-btn"
                  onClick={handleCopyWebhook}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                busy ||
                !sl.connectability.canConnect ||
                !signingSecret.trim() ||
                !botToken.trim()
              }
            >
              {editing ? "Update Credentials" : "Save Credentials"}
            </button>
            {editing ? (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  clearDrafts();
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
