import { useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import type { ChannelPillModel } from "@/components/panels/channel-panel-shared";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  ChannelSecretField,
} from "@/components/panels/channel-panel-shared";

type DiscordPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

function getDiscordPill(configured: boolean): ChannelPillModel {
  return {
    label: configured ? "connected" : "offline",
    variant: configured ? "good" : "idle",
  };
}

function getDiscordHealth(args: {
  endpointConfigured?: boolean;
  commandRegistered?: boolean;
}): string {
  const endpoint = args.endpointConfigured
    ? "Endpoint configured"
    : "Endpoint pending";
  const command = args.commandRegistered
    ? "/ask registered"
    : "/ask pending";
  return `${endpoint} · ${command}`;
}

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
  const [copiedField, setCopiedField] = useState<"webhook" | "endpoint" | null>(null);

  const { confirm, dialogProps } = useConfirm();
  const dc = status.channels.discord;
  const pending = busy || saving;

  function clearDrafts(): void {
    setBotToken("");
    setShowToken(false);
    setAutoEndpoint(true);
    setAutoCommand(true);
    setForceOverwrite(false);
    setPanelError(null);
    setSaving(false);
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim() || pending) return;
    setPanelError(null);
    setSaving(true);

    const result = await requestJson("/api/channels/discord", {
      label: editing ? "Update Discord credentials" : "Connect Discord",
      successMessage: editing ? "Discord credentials updated" : "Discord connected",
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

  function handleCopyValue(
    value: string | null | undefined,
    field: "webhook" | "endpoint",
  ): void {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 2000);
  }

  return (
    <ChannelCardFrame
      channelClassName="channel-discord"
      title="Discord"
      summary={
        dc.configured
          ? `Connected${dc.appName ? ` · ${dc.appName}` : ""}`
          : "Not configured"
      }
      pill={getDiscordPill(dc.configured)}
      errors={[panelError, dc.endpointError]}
      connectability={dc.connectability}
      suppressedIds={preflightBlockerIds}
    >
      {dc.configured && !editing ? (
        <div className="channel-connected-view">
          <ChannelInfoRow label="Application">
            <code className="inline-code">
              {dc.appName ?? dc.applicationId ?? "—"}
            </code>
          </ChannelInfoRow>
          <ChannelCopyValue
            label="Webhook URL"
            value={dc.webhookUrl}
            copied={copiedField === "webhook"}
            onCopy={() => handleCopyValue(dc.webhookUrl, "webhook")}
          />
          {dc.endpointUrl != null &&
            dc.endpointUrl.trim().length > 0 &&
            dc.endpointUrl !== dc.webhookUrl ? (
            <ChannelCopyValue
              label="Endpoint"
              value={dc.endpointUrl}
              copied={copiedField === "endpoint"}
              onCopy={() => handleCopyValue(dc.endpointUrl, "endpoint")}
            />
          ) : null}
          <ChannelInfoRow
            label="Health"
            action={
              !dc.commandRegistered ? (
                <button
                  className="button ghost channel-inline-action"
                  disabled={pending}
                  onClick={() => void handleRegisterCommand()}
                >
                  Register
                </button>
              ) : null
            }
          >
            <code className="inline-code">
              {getDiscordHealth({
                endpointConfigured: dc.endpointConfigured,
                commandRegistered: dc.commandRegistered,
              })}
            </code>
          </ChannelInfoRow>
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

          <ChannelSecretField
            label="Bot token"
            value={botToken}
            onChange={setBotToken}
            placeholder="Paste bot token"
            shown={showToken}
            onToggleShown={() => setShowToken((v) => !v)}
          />

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
              {saving ? "Saving\u2026" : editing ? "Update" : "Connect"}
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
    </ChannelCardFrame>
  );
}
