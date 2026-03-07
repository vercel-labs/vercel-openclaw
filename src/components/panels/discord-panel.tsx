import { useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";

type SetupPhase = "idle" | "validating" | "saving" | "endpoint" | "command" | "done";

type DiscordPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function DiscordPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: DiscordPanelProps) {
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [autoEndpoint, setAutoEndpoint] = useState(true);
  const [autoCommand, setAutoCommand] = useState(true);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [copied, setCopied] = useState<string | null>(null);

  const { confirm, dialogProps } = useConfirm();
  const dc = status.channels.discord;
  const pending = busy || (setupPhase !== "idle" && setupPhase !== "done");

  function clearDrafts(): void {
    setBotToken("");
    setShowToken(false);
    setForceOverwrite(false);
    setPanelError(null);
    setSetupPhase("idle");
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim() || pending) return;
    setPanelError(null);

    try {
      setSetupPhase("validating");
      await delay(120);
      setSetupPhase("saving");
      await delay(120);
      if (autoEndpoint) {
        setSetupPhase("endpoint");
        await delay(120);
      }
      if (autoCommand) {
        setSetupPhase("command");
      }

      await requestJson("/api/channels/discord", {
        label: "Save Discord",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botToken: botToken.trim(),
          autoConfigureEndpoint: autoEndpoint,
          autoRegisterCommand: autoCommand,
          forceOverwriteEndpoint: forceOverwrite,
        }),
      });

      setSetupPhase("done");
      setEditing(false);
      setTimeout(() => {
        setSetupPhase("idle");
        clearDrafts();
      }, 600);
    } catch (error) {
      setSetupPhase("idle");
      setPanelError(
        error instanceof Error ? error.message : "Failed to connect",
      );
    }
  }

  async function handleRegisterCommand(): Promise<void> {
    setPanelError(null);
    try {
      await runAction("/api/channels/discord/register-command", {
        label: "Register Discord command",
        method: "POST",
      });
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to register command",
      );
    }
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
    try {
      await runAction("/api/channels/discord", {
        label: "Disconnect Discord",
        method: "DELETE",
      });
      clearDrafts();
      setEditing(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to disconnect",
      );
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

      {dc.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-status-checklist">
            <div className="channel-check-item">
              <span
                className={`channel-check-dot ${dc.configured ? "good" : "bad"}`}
              />
              <span>Token validated</span>
            </div>
            <div className="channel-check-item">
              <span
                className={`channel-check-dot ${dc.endpointConfigured ? "good" : "warn"}`}
              />
              <span>
                Interactions endpoint{" "}
                {dc.endpointConfigured ? "configured" : "not confirmed"}
              </span>
            </div>
            <div className="channel-check-item">
              <span
                className={`channel-check-dot ${dc.commandRegistered ? "good" : "warn"}`}
              />
              <span>
                /ask command{" "}
                {dc.commandRegistered ? "registered" : "not registered"}
              </span>
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
            <div className="channel-check-item">
              <span className="channel-check-dot good" />
              <span>Bot invite</span>
              {dc.inviteUrl ? (
                <a
                  className="button ghost channel-inline-action"
                  href={dc.inviteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Invite bot
                </a>
              ) : null}
            </div>
          </div>

          {dc.queueDepth > 0 ? (
            <div className="channel-queue-badge">
              <ChannelPill variant="good">{dc.queueDepth} queued</ChannelPill>
            </div>
          ) : null}

          <details className="channel-details">
            <summary>Details</summary>
            <div className="channel-details-body">
              <div className="channel-detail-row">
                <span className="field-label">Application ID</span>
                <div className="channel-copy-row">
                  <code className="inline-code channel-copy-code">
                    {dc.applicationId ?? "—"}
                  </code>
                  <button
                    className="button ghost channel-copy-btn"
                    onClick={() =>
                      handleCopy("app-id", dc.applicationId)
                    }
                    disabled={!dc.applicationId}
                  >
                    {copied === "app-id" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="channel-detail-row">
                <span className="field-label">Public Key</span>
                <div className="channel-copy-row">
                  <code className="inline-code channel-copy-code">
                    {dc.publicKey ?? "—"}
                  </code>
                  <button
                    className="button ghost channel-copy-btn"
                    onClick={() =>
                      handleCopy("pub-key", dc.publicKey)
                    }
                    disabled={!dc.publicKey}
                  >
                    {copied === "pub-key" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="channel-detail-row">
                <span className="field-label">Webhook URL</span>
                <div className="channel-copy-row">
                  <code className="inline-code channel-copy-code">
                    {dc.webhookUrl}
                  </code>
                  <button
                    className="button ghost channel-copy-btn"
                    onClick={() =>
                      handleCopy("webhook", dc.webhookUrl)
                    }
                  >
                    {copied === "webhook" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
          </details>

          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => {
                setPanelError(null);
                setEditing(true);
              }}
            >
              Update token
            </button>
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
        <div className="channel-wizard">
          <p className="channel-wizard-title">
            {editing ? "Update Bot Token" : "Connect Discord Bot"}
          </p>

          {!editing ? (
            <div className="channel-wizard-steps">
              <div className="channel-wizard-step">
                <span className="channel-step-number">1</span>
                <div className="channel-step-body">
                  <span className="muted-copy">
                    Create a Discord app + bot
                  </span>
                  <div style={{ marginTop: 8 }}>
                    <a
                      className="button secondary"
                      href="https://discord.com/developers/applications?new_application=true"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Discord Developer Portal
                    </a>
                  </div>
                </div>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">2</span>
                <span className="muted-copy">
                  Copy Bot Token: Developer Portal → Bot → Reset Token / Copy.
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">3</span>
                <span className="muted-copy">
                  Paste token below and click Connect.
                </span>
              </div>
            </div>
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
              />
              <button
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

          {(setupPhase !== "idle" && setupPhase !== "done") || setupPhase === "done" ? (
            <div className="channel-setup-progress">
              <span className="field-label">Setup progress</span>
              <div className="channel-progress-list">
                <ProgressStep
                  label="Validating token..."
                  phase="validating"
                  current={setupPhase}
                />
                <ProgressStep
                  label="Saving credentials..."
                  phase="saving"
                  current={setupPhase}
                />
                <ProgressStep
                  label="Configuring endpoint..."
                  phase="endpoint"
                  current={setupPhase}
                  enabled={autoEndpoint}
                />
                <ProgressStep
                  label="Registering /ask..."
                  phase="command"
                  current={setupPhase}
                  enabled={autoCommand}
                />
              </div>
            </div>
          ) : null}

          <div className="inline-actions">
            <button
              className="button primary"
              disabled={pending || !botToken.trim()}
              onClick={() => void handleConnect()}
            >
              {pending ? "Connecting..." : "Connect"}
            </button>
            {editing ? (
              <button
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
        </div>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}

const PHASE_ORDER: SetupPhase[] = ["validating", "saving", "endpoint", "command"];

function ProgressStep({
  label,
  phase,
  current,
  enabled = true,
}: {
  label: string;
  phase: SetupPhase;
  current: SetupPhase;
  enabled?: boolean;
}) {
  if (!enabled) {
    return (
      <div className="channel-progress-step skipped">
        <span className="channel-progress-dot skipped" />
        <span>{label}</span>
      </div>
    );
  }

  const phaseIdx = PHASE_ORDER.indexOf(phase);
  const currentIdx = PHASE_ORDER.indexOf(current);
  const isDone = current === "done" || (currentIdx >= 0 && phaseIdx < currentIdx);
  const isActive = current === phase;

  return (
    <div
      className={`channel-progress-step ${isDone ? "complete" : isActive ? "active" : "pending"}`}
    >
      <span
        className={`channel-progress-dot ${isDone ? "good" : isActive ? "active" : "pending"}`}
      />
      <span>{label}</span>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
