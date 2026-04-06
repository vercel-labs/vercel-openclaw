"use client";

import { useState, useSyncExternalStore } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  RunAction,
  RequestJson,
  StatusPayload,
} from "@/components/admin-types";
import type { ChannelPillModel } from "@/components/panels/channel-panel-shared";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  ChannelSecretField,
  ChannelTextField,
  getChannelActionLabel,
} from "@/components/panels/channel-panel-shared";

type WhatsAppPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

type WhatsAppDraft = {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  businessAccountId: string;
};

const EMPTY_DRAFT: WhatsAppDraft = {
  phoneNumberId: "",
  accessToken: "",
  verifyToken: "",
  appSecret: "",
  businessAccountId: "",
};

export function getWhatsAppWebhookUrl(
  origin: string | null | undefined,
): string | null {
  if (!origin) {
    return null;
  }

  try {
    return new URL("/api/channels/whatsapp/webhook", origin).toString();
  } catch {
    return null;
  }
}

function subscribeToOrigin(): () => void {
  return () => {};
}

function getOriginSnapshot(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function getWhatsAppPill(args: {
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

export function WhatsAppPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
}: WhatsAppPanelProps) {
  const wa = status.channels.whatsapp;
  const [draft, setDraft] = useState<WhatsAppDraft>(EMPTY_DRAFT);
  const [showSecrets, setShowSecrets] = useState({
    accessToken: false,
    verifyToken: false,
    appSecret: false,
  });
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { confirm, dialogProps } = useConfirm();
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getOriginSnapshot,
    () => null,
  );

  const webhookUrl =
    wa.webhookUrl ??
    wa.connectability.webhookUrl ??
    getWhatsAppWebhookUrl(origin);
  const hasDraft =
    draft.phoneNumberId.trim().length > 0 ||
    draft.accessToken.trim().length > 0 ||
    draft.verifyToken.trim().length > 0 ||
    draft.appSecret.trim().length > 0 ||
    draft.businessAccountId.trim().length > 0;
  const canSave =
    wa.connectability.canConnect &&
    draft.phoneNumberId.trim().length > 0 &&
    draft.accessToken.trim().length > 0 &&
    draft.verifyToken.trim().length > 0 &&
    draft.appSecret.trim().length > 0;

  function updateDraft<K extends keyof WhatsAppDraft>(
    key: K,
    value: WhatsAppDraft[K],
  ): void {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function clearDraft(): void {
    setDraft(EMPTY_DRAFT);
    setShowSecrets({
      accessToken: false,
      verifyToken: false,
      appSecret: false,
    });
  }

  async function handleConnect(): Promise<void> {
    if (!canSave) {
      return;
    }

    setPanelError(null);
    const result = await requestJson("/api/channels/whatsapp", {
      label: getChannelActionLabel("whatsapp", editing ? "update" : "connect"),
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        phoneNumberId: draft.phoneNumberId.trim(),
        accessToken: draft.accessToken.trim(),
        verifyToken: draft.verifyToken.trim(),
        appSecret: draft.appSecret.trim(),
        businessAccountId: draft.businessAccountId.trim() || undefined,
      }),
    });
    if (result.ok) {
      clearDraft();
      setEditing(false);
    } else {
      setPanelError(result.error);
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect WhatsApp?",
      description:
        "This removes the WhatsApp Business credentials and stops webhook verification for this channel.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) {
      return;
    }

    setPanelError(null);
    const success = await runAction("/api/channels/whatsapp", {
      label: getChannelActionLabel("whatsapp", "disconnect"),
      method: "DELETE",
    });
    if (success) {
      clearDraft();
      setEditing(false);
    }
  }

  function handleCopyWebhook(): void {
    if (!webhookUrl) {
      return;
    }

    void navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function startEditing(): void {
    setPanelError(null);
    clearDraft();
    setEditing(true);
  }

  function cancelEditing(): void {
    clearDraft();
    setPanelError(null);
    setEditing(false);
  }

  return (
    <ChannelCardFrame
      channel="whatsapp"
      configured={wa.configured}
      channelClassName="channel-whatsapp"
      title="WhatsApp (experimental)"
      summary={
        wa.configured
          ? `Connected${wa.displayName ? ` · ${wa.displayName}` : ""}${wa.linkedPhone ? ` · ${wa.linkedPhone}` : ""}`
          : "Not configured"
      }
      pill={getWhatsAppPill({ configured: wa.configured, status: wa.status })}
      errors={[panelError, wa.lastError]}
      connectability={wa.connectability}
      suppressedIds={preflightBlockerIds}
    >
      {wa.configured && !editing ? (
        <div className="channel-connected-view">
          <ChannelInfoRow label="Business account">
            <code className="inline-code">
              {wa.displayName ?? wa.linkedPhone ?? "configured"}
            </code>
          </ChannelInfoRow>
          <ChannelCopyValue
            label="Webhook URL"
            value={webhookUrl}
            copied={copied}
            onCopy={handleCopyWebhook}
          />
          <ChannelInfoRow label="Health">
            <code className="inline-code">
              {wa.status.replace("-", " ")}
            </code>
          </ChannelInfoRow>
          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={startEditing}
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
        <form
          className="channel-wizard"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConnect();
          }}
        >
          <p className="channel-wizard-title">
            {editing ? "Update Credentials" : "Connect WhatsApp"}
          </p>

          {!editing ? (
            <p className="muted-copy">
              Paste credentials from the{" "}
              <a
                href="https://developers.facebook.com/apps/"
                target="_blank"
                rel="noreferrer"
                className="channel-link"
              >
                Meta Developer Portal
              </a>{" "}
              WhatsApp product.
            </p>
          ) : null}

          <ChannelTextField
            label="Phone Number ID"
            value={draft.phoneNumberId}
            placeholder="123456789012345"
            onChange={(value) => updateDraft("phoneNumberId", value)}
          />

          <ChannelSecretField
            label="Access Token"
            value={draft.accessToken}
            placeholder="EAAG..."
            shown={showSecrets.accessToken}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                accessToken: !current.accessToken,
              }))
            }
            onChange={(value) => updateDraft("accessToken", value)}
          />

          <ChannelSecretField
            label="Verify Token"
            value={draft.verifyToken}
            placeholder="custom-verify-token"
            shown={showSecrets.verifyToken}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                verifyToken: !current.verifyToken,
              }))
            }
            onChange={(value) => updateDraft("verifyToken", value)}
          />

          <ChannelSecretField
            label="App Secret"
            value={draft.appSecret}
            placeholder="app-secret"
            shown={showSecrets.appSecret}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                appSecret: !current.appSecret,
              }))
            }
            onChange={(value) => updateDraft("appSecret", value)}
          />

          <ChannelTextField
            label="Business Account ID"
            value={draft.businessAccountId}
            placeholder="optional"
            onChange={(value) => updateDraft("businessAccountId", value)}
          />

          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !canSave}
            >
              {editing ? "Update" : "Connect"}
            </button>
            {editing || hasDraft ? (
              <button
                type="button"
                className="button ghost"
                onClick={editing ? cancelEditing : clearDraft}
              >
                {editing ? "Cancel" : "Clear"}
              </button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
