import { useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";

type DiscordPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

export function DiscordPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
}: DiscordPanelProps) {
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [autoEndpoint, setAutoEndpoint] = useState(true);
  const [autoCommand, setAutoCommand] = useState(true);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const { confirm, dialogProps } = useConfirm();
  const dc = status.channels.discord;
  const pending = busy || saving;

  function clearDrafts(): void {
    setBotToken("");
    setShowToken(false);
    setForceOverwrite(false);
    setPanelError(null);
    setSaving(false);
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim() || pending) return;
    setPanelError(null);
    setSaving(true);

    const result = await requestJson("/api/channels/discord", {
      label: "Save Discord",
      successMessage: "Discord connected",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botToken: botToken.trim(),
        autoConfigureEndpoint: autoEndpoint,
        autoRegisterCommand: autoCommand,
        forceOverwriteEndpoint: forceOverwrite,
      }),
    });

    if (result.ok) {
      setEditing(false);
      clearDrafts();
    } else {
      setSaving(false);
      setPanelError(result.error);
    }
  }

  async function handleRegisterCommand(): Promise<void> {
    setPanelError(null);
    await runAction("/api/channels/discord/register-command", {
      label: "Register Discord command",
      successMessage: "Discord command registered",
      method: "POST",
    });
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect Discord?",
      description:
        "This will remove the bot token and stop processing interactions from this Discord application.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;

    setPanelError(null);
    const success = await runAction("/api/channels/discord", {
      label: "Disconnect Discord",
      successMessage: "Discord disconnected",
      method: "DELETE",
    });
    if (success) {
      clearDrafts();
      setEditing(false);
    }
  }

  function handleCopy(target: string, value: string | null): void {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(target);
    setTimeout(() => setCopied((c) => (c === target ? null : c)), 2000);
  }

  return (
    <section className="channel-card channel-discord">
      <div className="channel-head">
        <div>
          <h3>Discord</h3>
          <p className="muted-copy">
            {dc.configured
              ? `Connected${dc.appName ? ` · ${dc.appName}` : ""}`
              : "Not configured"}
          </p>
        </div>
        <ChannelPill variant={dc.configured ? "good" : "idle"}>
          {dc.configured ? "connected" : "offline"}
        </ChannelPill>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {dc.endpointError ? (
        <p className="error-banner">{dc.endpointError}</p>
      ) : null}
      <ConnectabilityNotice connectability={dc.connectability} suppressedIds={preflightBlockerIds} />

      {dc.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Application</span>
            <code className="inline-code">
              {dc.appName ?? dc.applicationId ?? "—"}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Webhook URL</span>
            <div className="channel-copy-row">
              <code className="inline-code channel-copy-code">
                {dc.webhookUrl}
              </code>
              <button
                className="button ghost channel-copy-btn"
                onClick={() => handleCopy("webhook", dc.webhookUrl)}
              >
                {copied === "webhook" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Endpoint</span>
            <code className="inline-code">
              {dc.endpointConfigured ? "configured" : "not confirmed"}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">/ask command</span>
            <code className="inline-code">
              {dc.commandRegistered ? "registered" : "not registered"}
            </code>
            {!dc.commandRegistered ? (
              <button
                className="button ghost channel-inline-action"
                disabled={pending}
                onClick={() => void handleRegisterCommand()}
              >
                Register
              </button>
            ) : null}
          </div>
          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => {
                setPanelError(null);
                setEditing(true);
              }}
            >
              Update credentials
            </button>
            {dc.inviteUrl ? (
              <a
                className="button secondary"
                href={dc.inviteUrl}
                target="_blank"
                rel="noreferrer"
              >
                Invite bot
              </a>
            ) : null}
            <button
              className="button ghost"
              disabled={pending}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form className="channel-wizard" onSubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
          <p className="channel-wizard-title">
            {editing ? "Update Credentials" : "Connect Discord"}
          </p>

          {!editing ? (
            <p className="muted-copy">
              Paste the bot token from{" "}
              <a
                href="https://discord.com/developers/applications?new_application=true"
                target="_blank"
                rel="noreferrer"
                className="channel-link"
              >
                Discord Developer Portal
              </a>{" "}
              → Bot → Reset Token.
            </p>
          ) : null}

          <div className="stack">
            <span className="field-label">Bot token</span>
            <div className="channel-token-row">
              <input
                className="text-input"
                type={showToken ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder="Paste bot token"
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
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={autoEndpoint}
              onChange={(event) => setAutoEndpoint(event.target.checked)}
              disabled={pending}
            />
            <span>Auto-configure interactions endpoint</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={autoCommand}
              onChange={(event) => setAutoCommand(event.target.checked)}
              disabled={pending}
            />
            <span>Register /ask command</span>
          </label>
          {editing ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={forceOverwrite}
                onChange={(event) =>
                  setForceOverwrite(event.target.checked)
                }
                disabled={pending}
              />
              <span>Force overwrite existing endpoint</span>
            </label>
          ) : null}

          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={pending || !dc.connectability.canConnect || !botToken.trim()}
            >
              {saving ? "Saving\u2026" : editing ? "Update Credentials" : "Save Credentials"}
            </button>
            {editing ? (
              <button
                type="button"
                className="button ghost"
                disabled={pending}
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
