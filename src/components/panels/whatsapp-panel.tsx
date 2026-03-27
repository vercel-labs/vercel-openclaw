"use client";

import { useState, useSyncExternalStore } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type {
  RunAction,
  RequestJson,
  StatusPayload,
} from "@/components/admin-types";

type WhatsAppPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
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

export function WhatsAppPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
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
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { confirm, dialogProps } = useConfirm();
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getOriginSnapshot,
    () => null,
  );

  const webhookUrl = getWhatsAppWebhookUrl(origin);
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
    try {
      await requestJson("/api/channels/whatsapp", {
        label: "Save WhatsApp",
        successMessage: "WhatsApp connected",
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
      clearDraft();
      setEditing(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to save WhatsApp credentials",
      );
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
    try {
      await runAction("/api/channels/whatsapp", {
        label: "Disconnect WhatsApp",
        successMessage: "WhatsApp disconnected",
        method: "DELETE",
      });
      clearDraft();
      setEditing(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to disconnect WhatsApp",
      );
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
    <section className="channel-card channel-whatsapp">
      <div className="channel-head">
        <div>
          <h3>WhatsApp</h3>
          <p className="muted-copy">
            {wa.configured
              ? `Connected${wa.displayName ? ` · ${wa.displayName}` : ""}${wa.linkedPhone ? ` · ${wa.linkedPhone}` : ""}`
              : "Not configured"}
          </p>
        </div>
        <ChannelPill
          variant={wa.configured ? (wa.status === "error" ? "bad" : "good") : "idle"}
        >
          {wa.configured ? wa.status.replace("-", " ") : "offline"}
        </ChannelPill>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {wa.lastError ? <p className="error-banner">{wa.lastError}</p> : null}
      <ConnectabilityNotice connectability={wa.connectability} />

      {wa.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Verification endpoint</span>
            <div className="channel-copy-row">
              <code className="inline-code channel-copy-code">
                {webhookUrl ?? "Unavailable until this admin UI has a public origin"}
              </code>
              <button
                className="button ghost channel-copy-btn"
                onClick={handleCopyWebhook}
                disabled={!webhookUrl}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Webhook status</span>
            <code className="inline-code">{wa.status}</code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Sandbox requirement</span>
            <code className="inline-code">
              {wa.requiresRunningSandbox
                ? "Running sandbox required for delivery"
                : "Always available"}
            </code>
          </div>
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
            <button
              className="button ghost"
              disabled={busy || refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh().finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
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
            {editing ? "Update WhatsApp Credentials" : "Connect WhatsApp Business"}
          </p>

          {!editing ? (
            <div className="channel-wizard-steps">
              <div className="channel-wizard-step">
                <span className="channel-step-number">1</span>
                <span className="muted-copy">
                  Create or open your Meta app and copy the WhatsApp Business API credentials.
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">2</span>
                <span className="muted-copy">
                  Paste the five values below and save the channel config.
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">3</span>
                <span className="muted-copy">
                  Register the verification endpoint shown below in the Meta webhook settings.
                </span>
              </div>
            </div>
          ) : null}

          <CredentialField
            label="Phone Number ID"
            value={draft.phoneNumberId}
            placeholder="123456789012345"
            onChange={(value) => updateDraft("phoneNumberId", value)}
          />

          <CredentialField
            label="Access Token"
            value={draft.accessToken}
            placeholder="EAAG..."
            onChange={(value) => updateDraft("accessToken", value)}
            isSecret
            shown={showSecrets.accessToken}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                accessToken: !current.accessToken,
              }))
            }
          />

          <CredentialField
            label="Verify Token"
            value={draft.verifyToken}
            placeholder="custom-verify-token"
            onChange={(value) => updateDraft("verifyToken", value)}
            isSecret
            shown={showSecrets.verifyToken}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                verifyToken: !current.verifyToken,
              }))
            }
          />

          <CredentialField
            label="App Secret"
            value={draft.appSecret}
            placeholder="app-secret"
            onChange={(value) => updateDraft("appSecret", value)}
            isSecret
            shown={showSecrets.appSecret}
            onToggleShown={() =>
              setShowSecrets((current) => ({
                ...current,
                appSecret: !current.appSecret,
              }))
            }
          />

          <CredentialField
            label="Business Account ID"
            value={draft.businessAccountId}
            placeholder="optional"
            onChange={(value) => updateDraft("businessAccountId", value)}
          />

          <div className="stack">
            <span className="field-label">
              {editing ? "Verification endpoint" : "4. Verification endpoint"}
            </span>
            <p className="muted-copy">
              Use this URL as the Meta webhook callback for WhatsApp verification.
            </p>
            <div className="channel-copy-row">
              <code className="inline-code channel-copy-code">
                {webhookUrl ?? "Unavailable until this admin UI has a public origin"}
              </code>
              <button
                type="button"
                className="button ghost channel-copy-btn"
                onClick={handleCopyWebhook}
                disabled={!webhookUrl}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !canSave}
            >
              {editing ? "Update Credentials" : "Save Credentials"}
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
          {!wa.connectability.canConnect ? (
            <p className="muted-copy">
              Resolve the deployment blockers above before saving WhatsApp credentials.
            </p>
          ) : null}
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}

function CredentialField({
  label,
  value,
  placeholder,
  onChange,
  isSecret = false,
  shown = false,
  onToggleShown,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  isSecret?: boolean;
  shown?: boolean;
  onToggleShown?: () => void;
}) {
  return (
    <div className="stack">
      <span className="field-label">{label}</span>
      <div className="channel-token-row">
        <input
          className="text-input"
          type={isSecret && !shown ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
        />
        {isSecret ? (
          <button
            type="button"
            className="button ghost channel-toggle-btn"
            onClick={onToggleShown}
          >
            {shown ? "Hide" : "Show"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
