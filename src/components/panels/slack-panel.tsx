import { useEffect, useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
  SlackTestPayload,
  LiveConfigSyncPayload,
} from "@/components/admin-types";
import type { ChannelPillModel } from "@/components/panels/channel-panel-shared";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  ChannelSecretField,
  PortStatusRow,
  getChannelActionLabel,
} from "@/components/panels/channel-panel-shared";
import type { PortCheck } from "@/app/api/admin/sandbox-diag/route";

type SlackPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
  portCheck?: PortCheck | null;
};

function getSlackPill(configured: boolean): ChannelPillModel {
  return {
    label: configured ? "connected" : "offline",
    variant: configured ? "good" : "idle",
  };
}

function getInstallErrorMessage(code: string): string {
  switch (code) {
    case "missing_app_credentials":
      return "Slack app credentials (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET) are not configured.";
    case "connect_blocked":
      return "Channel connection is blocked by deployment prerequisites.";
    case "access_denied":
      return "Slack installation was cancelled.";
    case "state_mismatch":
    case "context_expired":
      return "OAuth session expired. Please try again.";
    case "token_exchange_failed":
      return "Failed to exchange authorization code with Slack.";
    case "auth_test_failed":
      return "Slack token validation failed after install.";
    default:
      return `Slack install failed: ${code}`;
  }
}

type SlackInstallNotice = {
  message: string;
};

function readSlackInstallNotice(search: string): SlackInstallNotice | null {
  const params = new URLSearchParams(search);
  const err = params.get("slack_install_error");
  if (err) {
    return { message: getInstallErrorMessage(err) };
  }
  const outcome = params.get("slack_install_warning");
  const reason = params.get("slack_install_reason");
  const operatorMessage = params.get("slack_install_message");
  if (outcome !== "degraded" && outcome !== "failed") {
    return null;
  }
  if (operatorMessage) {
    return { message: operatorMessage };
  }
  if (reason === "config_written_restart_failed") {
    return {
      message:
        "Slack was installed, but the running sandbox did not restart cleanly. Live routes may be stale until the next successful restart.",
    };
  }
  return {
    message:
      outcome === "failed"
        ? "Slack was installed, but config sync failed. The sandbox may still be serving stale configuration."
        : "Slack was installed, but live config sync completed in a degraded state.",
  };
}

const SLACK_INSTALL_PARAMS = [
  "slack_install_error",
  "slack_install_warning",
  "slack_install_reason",
  "slack_install_message",
] as const;

export function SlackPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
  portCheck,
}: SlackPanelProps) {
  const [signingSecret, setSigningSecret] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testResult, setTestResult] = useState<SlackTestPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [configToken, setConfigToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [showConfigToken, setShowConfigToken] = useState(false);
  const [showRefreshToken, setShowRefreshToken] = useState(false);
  const [appName, setAppName] = useState("");
  const [createAppBusy, setCreateAppBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("slack_install_error")) return null;
    const notice = readSlackInstallNotice(window.location.search);
    return notice?.message ?? null;
  });
  const [liveConfigWarning, setLiveConfigWarning] = useState<string | null>(
    () => {
      if (typeof window === "undefined") return null;
      const params = new URLSearchParams(window.location.search);
      if (params.has("slack_install_error")) return null;
      const notice = readSlackInstallNotice(window.location.search);
      return notice?.message ?? null;
    },
  );
  const [copied, setCopied] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);

  // Clean Slack install query params from URL without triggering a reload.
  // State was read in useState initializers above (pure computation);
  // the side effect (replaceState) lives here in useEffect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!SLACK_INSTALL_PARAMS.some((key) => params.has(key))) return;
    const clean = new URL(window.location.href);
    for (const key of SLACK_INSTALL_PARAMS) {
      clean.searchParams.delete(key);
    }
    window.history.replaceState({}, "", clean.toString());
  }, []);

  const { confirm, dialogProps } = useConfirm();
  const sl = status.channels.slack;
  const botTokenValid = /^xoxb-/.test(botToken.trim());
  const oauthAvailable = sl.appCredentialsConfigured;

  function clearDrafts(): void {
    setSigningSecret("");
    setBotToken("");
    setShowSecret(false);
    setShowToken(false);
    setTestResult(null);
    setPanelError(null);
    setShowManualForm(false);
  }

  async function handleTestToken(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson<SlackTestPayload>(
      "/api/channels/slack/test",
      {
        label: "Test Slack token",
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
    setLiveConfigWarning(null);
    const result = await requestJson<{ liveConfigSync?: LiveConfigSyncPayload }>(
      "/api/channels/slack",
      {
        label: getChannelActionLabel("slack", editing ? "update" : "connect"),
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signingSecret: signingSecret.trim(),
          botToken: botToken.trim(),
        }),
      },
    );
    if (result.ok) {
      const sync = result.meta.liveConfigSync;
      if (sync && (sync.outcome === "degraded" || sync.outcome === "failed")) {
        setLiveConfigWarning(
          sync.operatorMessage ??
            "Credentials saved, but the running sandbox did not restart cleanly.",
        );
      }
      clearDrafts();
      setEditing(false);
    } else {
      setPanelError(result.error);
    }
  }

  async function handleCreateApp(): Promise<void> {
    if (!configToken.trim()) return;
    setPanelError(null);
    setCreateAppBusy(true);
    try {
      const result = await requestJson<{
        appId: string;
        appName: string;
        installUrl: string;
      }>("/api/channels/slack/app", {
        label: "Create Slack app",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configToken: configToken.trim(),
          refreshToken: refreshToken.trim() || undefined,
          appName: appName.trim() || undefined,
        }),
      });
      if (result.ok && result.data?.installUrl) {
        window.location.href = result.data.installUrl;
        return;
      }
      if (!result.ok) {
        setPanelError(result.error);
      }
    } finally {
      setCreateAppBusy(false);
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
      label: getChannelActionLabel("slack", "disconnect"),
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

  // ── Connected view ──
  const connectedView = (
    <div className="channel-connected-view">
      <ChannelInfoRow label="Workspace">
        <code className="inline-code">
          {sl.team ?? "—"}
          {sl.botId ? ` · ${sl.botId}` : ""}
        </code>
      </ChannelInfoRow>
      {sl.projectScope && sl.projectName ? (
        <ChannelInfoRow label="Owned by">
          <code className="inline-code">
            {sl.projectScope}/{sl.projectName}
          </code>
        </ChannelInfoRow>
      ) : null}
      <ChannelCopyValue
        label="Webhook URL"
        value={sl.webhookUrl}
        copied={copied}
        onCopy={handleCopyWebhook}
      />
      {portCheck ? <PortStatusRow port={portCheck} /> : null}
      <div className="inline-actions">
        {oauthAvailable ? (
          <a
            className="button secondary"
            href={sl.installUrl ?? "/api/channels/slack/install"}
          >
            Reinstall to Slack
          </a>
        ) : null}
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
  );

  // ── OAuth install view (unconfigured, credentials available) ──
  const oauthInstallView = (
    <div className="channel-wizard">
      <p className="channel-wizard-title">Connect Slack</p>
      <a
        className="button primary"
        href={sl.installUrl ?? "/api/channels/slack/install"}
      >
        Install to Slack
      </a>
      <div className="inline-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="button ghost"
          onClick={() => setShowManualForm(true)}
        >
          or configure manually
        </button>
      </div>
    </div>
  );

  // ── Create-new-app view (unconfigured, no credentials stored yet) ──
  const createAppView = (
    <div className="channel-wizard">
      <p className="channel-wizard-title">Connect Slack</p>
      <section className="channel-subwizard">
        <h4 style={{ margin: "0 0 4px" }}>Create a new Slack app</h4>
        <p className="muted-copy">
          Paste a Slack App Configuration Token and we&apos;ll mint a workspace
          app for you. Grab one at{" "}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noreferrer"
          >
            api.slack.com/apps
          </a>{" "}
          → Your Apps → Generate Token.
        </p>
        <ChannelSecretField
          label="App Configuration Token"
          value={configToken}
          onChange={setConfigToken}
          placeholder="xoxe.xoxp-..."
          shown={showConfigToken}
          onToggleShown={() => setShowConfigToken((v) => !v)}
          help="Used once to call apps.manifest.create. Not stored."
        />
        <ChannelSecretField
          label="Refresh Token (optional)"
          value={refreshToken}
          onChange={setRefreshToken}
          placeholder="xoxe-1-..."
          shown={showRefreshToken}
          onToggleShown={() => setShowRefreshToken((v) => !v)}
          help="Lets us auto-rotate the config token if it's expired."
        />
        <div className="stack">
          <span className="field-label">App name (optional)</span>
          <input
            className="text-input"
            type="text"
            autoComplete="off"
            value={appName}
            onChange={(event) => setAppName(event.target.value)}
            placeholder="Defaults to project name"
          />
          <span className="muted-copy">
            Overrides the human-facing Slack app name only. Bot handle and
            slash command stay tied to this Vercel project.
          </span>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || createAppBusy || !configToken.trim()}
            onClick={() => void handleCreateApp()}
          >
            {createAppBusy ? "Creating app…" : "Create Slack app"}
          </button>
        </div>
      </section>
      <div className="inline-actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="button ghost"
          onClick={() => setShowManualForm(true)}
        >
          or use an existing app
        </button>
      </div>
    </div>
  );

  // ── Manual credential form ──
  const manualForm = (
    <form className="channel-wizard" onSubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
      <p className="channel-wizard-title">
        {editing ? "Update Credentials" : "Connect Slack"}
      </p>

      <ChannelSecretField
        label="Signing Secret"
        value={signingSecret}
        onChange={setSigningSecret}
        placeholder="Signing Secret"
        shown={showSecret}
        onToggleShown={() => setShowSecret((v) => !v)}
        help="Basic Information → App Credentials → Signing Secret"
      />

      <ChannelSecretField
        label="Bot Token"
        value={botToken}
        onChange={(v) => {
          setBotToken(v);
          setTestResult(null);
        }}
        placeholder="xoxb-..."
        shown={showToken}
        onToggleShown={() => setShowToken((v) => !v)}
        help="OAuth & Permissions → Bot User OAuth Token (starts with xoxb-)"
        validationMessage={
          botToken.trim() && !botTokenValid
            ? "Bot token must start with xoxb-"
            : null
        }
      />

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
          {editing ? "Update" : "Connect"}
        </button>
        {editing || (oauthAvailable && showManualForm) ? (
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
  );

  // ── Decide which view to show ──
  let content: React.ReactNode;
  if (sl.configured && !editing) {
    content = connectedView;
  } else if (editing) {
    content = manualForm;
  } else if (oauthAvailable && !showManualForm) {
    content = oauthInstallView;
  } else if (!oauthAvailable && !showManualForm) {
    content = (
      <>
        {createAppView}
        <hr
          style={{
            margin: "16px 0",
            border: "none",
            borderTop: "1px solid var(--border-color, #ddd)",
          }}
        />
        {manualForm}
      </>
    );
  } else {
    content = manualForm;
  }

  return (
    <ChannelCardFrame
      channel="slack"
      configured={sl.configured}
      channelClassName="channel-slack"
      title="Slack"
      summary={
        sl.configured
          ? `Connected${sl.team ? ` · ${sl.team}` : ""}`
          : "Not configured"
      }
      pill={getSlackPill(sl.configured)}
      errors={[panelError, liveConfigWarning, sl.lastError]}
      connectability={sl.connectability}
      suppressedIds={preflightBlockerIds}
    >
      {content}
      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
