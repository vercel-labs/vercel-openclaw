import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { DiscordPanel } from "./discord-panel";

function makeConnectability(
  channel: ChannelConnectability["channel"],
): ChannelConnectability {
  return {
    channel,
    mode: "webhook-proxied",
    canConnect: true,
    status: "pass",
    webhookUrl: `https://openclaw.example/api/channels/${channel}/webhook`,
    issues: [],
  };
}

const RUN_ACTION: RunAction = async () => true;
const REQUEST_JSON: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });

function makeStatus(
  discordOverrides: Partial<StatusPayload["channels"]["discord"]> = {},
): StatusPayload {
  return {
    authMode: "admin-secret",
    storeBackend: "upstash",
    persistentStore: true,
    status: "running",
    sandboxId: "sbx-test",
    snapshotId: "snap-test",
    gatewayReady: true,
    gatewayStatus: "ready",
    gatewayCheckedAt: null,
    gatewayUrl: "/gateway",
    lastError: null,
    lastKeepaliveAt: null,
    sleepAfterMs: 300_000,
    heartbeatIntervalMs: 15_000,
    timeoutRemainingMs: 120_000,
    timeoutSource: "estimated",
    setupProgress: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 0,
      lastIngestedAt: null,
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
    },
    channels: {
      slack: {
        configured: false,
        webhookUrl: "",
        configuredAt: null,
        team: null,
        user: null,
        botId: null,
        hasSigningSecret: false,
        hasBotToken: false,
        lastError: null,
        connectability: makeConnectability("slack"),
      },
      telegram: {
        configured: false,
        webhookUrl: null,
        botUsername: null,
        configuredAt: null,
        lastError: null,
        status: "disconnected",
        commandSyncStatus: "unsynced",
        commandsRegisteredAt: null,
        commandSyncError: null,
        connectability: makeConnectability("telegram"),
      },
      discord: {
        configured: false,
        webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
        applicationId: null,
        publicKey: null,
        configuredAt: null,
        appName: null,
        botUsername: null,
        endpointConfigured: false,
        endpointUrl: null,
        endpointError: null,
        commandRegistered: false,
        commandId: null,
        inviteUrl: null,
        isPublicUrl: false,
        connectability: makeConnectability("discord"),
        ...discordOverrides,
      },
      whatsapp: {
        configured: false,
        mode: "webhook-proxied",
        webhookUrl: null,
        status: "unconfigured",
        configuredAt: null,
        displayName: null,
        linkedPhone: null,
        lastError: null,
        requiresRunningSandbox: false,
        loginVia: "/gateway",
        connectability: makeConnectability("whatsapp"),
      },
    },
    restoreTarget: {
      restorePreparedStatus: "unknown",
      restorePreparedReason: null,
      restorePreparedAt: null,
      snapshotDynamicConfigHash: null,
      runtimeDynamicConfigHash: null,
      snapshotAssetSha256: null,
      runtimeAssetSha256: null,
    },
    user: { sub: "admin", name: "Admin" },
  };
}

function renderPanel(status: StatusPayload): string {
  return renderToStaticMarkup(
    <DiscordPanel
      status={status}
      busy={false}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
    />,
  );
}

/* ── No fake progress ── */

test("DiscordPanel does not render simulated multi-phase progress during connect", () => {
  const html = renderPanel(makeStatus());

  // No progress-step or setup-phase class names
  assert.ok(!html.includes("progress-step"), "no progress-step elements in setup form");
  assert.ok(!html.includes("setup-phase"), "no setup-phase elements in setup form");

  // The setup form is a simple credential entry, not a wizard with phases
  assert.ok(html.includes("Connect Discord"), "shows connect title");
  assert.ok(html.includes("Bot token"), "shows bot token field");
  assert.ok(/>Connect<\/button>/.test(html), "primary action button is Connect");

  // Legacy label must not appear
  assert.equal(
    (html.match(/Save Credentials/g) ?? []).length,
    0,
    "legacy Save Credentials label is gone",
  );
});

/* ── Connected card structure ── */

test("DiscordPanel renders connected card with consistent action ordering", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      appName: "TestBot",
      applicationId: "app-123",
      webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
      endpointConfigured: true,
      commandRegistered: true,
      inviteUrl: "https://discord.com/oauth2/authorize?client_id=app-123",
      connectability: makeConnectability("discord"),
    }),
  );

  // Header shows connected state
  assert.ok(html.includes("Connected · TestBot"), "connected header includes app name");
  assert.ok(html.includes("connected"), "pill shows connected status");

  // Exactly 3 detail rows: Application, Webhook URL (via ChannelCopyValue which wraps ChannelInfoRow), Health
  const detailRows = html.match(/channel-detail-row/g) ?? [];
  assert.equal(detailRows.length, 3, `connected card shows exactly 3 detail rows (found ${detailRows.length})`);
  assert.ok(html.includes("Application"), "shows application row");
  assert.ok(html.includes("Webhook URL"), "shows webhook URL row");
  assert.ok(html.includes("Health"), "shows health row");
  assert.ok(html.includes("Endpoint configured"), "health row includes endpoint status");
  assert.ok(html.includes("/ask registered"), "health row includes command status");

  // Legacy separate rows must not exist
  assert.ok(!/>Endpoint<\/span>/.test(html), "does not render a separate Endpoint row");
  assert.ok(!html.includes("/ask command"), "does not render a separate /ask command row");

  // Action ordering: Update credentials → Disconnect (with optional Invite bot in between)
  assert.ok(html.includes("Update credentials"), "has update credentials action");
  assert.ok(html.includes("Disconnect"), "has disconnect action");

  // Update credentials appears before Disconnect
  const updateIdx = html.indexOf("Update credentials");
  const disconnectIdx = html.indexOf("Disconnect");
  assert.ok(updateIdx < disconnectIdx, "Update credentials appears before Disconnect");
});

test("DiscordPanel shows webhook URL with copy affordance", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
      endpointConfigured: true,
      connectability: makeConnectability("discord"),
    }),
  );

  assert.ok(html.includes("channel-copy-row"), "webhook URL has a copy row");
  assert.ok(html.includes("Copy"), "copy button is present");
  assert.ok(
    html.includes("https://openclaw.example/api/channels/discord/webhook"),
    "webhook URL value is rendered",
  );
});

test("DiscordPanel unconfigured form includes checkbox options", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Auto-configure interactions endpoint"), "auto-endpoint checkbox");
  assert.ok(html.includes("Register /ask command"), "auto-command checkbox");
  // Force overwrite only appears in editing mode, not initial connect
  assert.ok(!html.includes("Force overwrite"), "no force overwrite on initial connect");
});

/* ── Type contract: failure stubs satisfy RunAction and RequestJson ── */

const RUN_ACTION_FAILURE: RunAction = async () => false;
const REQUEST_JSON_FAILURE: RequestJson = async () => ({
  ok: false,
  error: "HTTP 500",
  meta: { requestId: "test", action: "test", label: "test", status: 500, code: "http-error" as const, retryable: true },
});

/* ── Conditional endpoint row when endpointUrl diverges from webhookUrl ── */

test("DiscordPanel shows separate Endpoint row when endpointUrl differs from webhookUrl", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      appName: "TestBot",
      applicationId: "app-123",
      webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
      endpointUrl: "https://old-deploy.example/api/channels/discord/webhook",
      endpointConfigured: true,
      commandRegistered: true,
      inviteUrl: "https://discord.com/oauth2/authorize?client_id=app-123",
      connectability: makeConnectability("discord"),
    }),
  );

  // 4 detail rows: Application, Webhook URL, Endpoint (divergent), Health
  const detailRows = html.match(/channel-detail-row/g) ?? [];
  assert.equal(detailRows.length, 4, `expected 4 detail rows when endpoint diverges (found ${detailRows.length})`);
  assert.ok(html.includes("Endpoint"), "shows separate Endpoint row");
  assert.ok(
    html.includes("https://old-deploy.example/api/channels/discord/webhook"),
    "endpoint row shows the divergent URL",
  );
});

test("DiscordPanel hides Endpoint row when endpointUrl matches webhookUrl", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      appName: "TestBot",
      applicationId: "app-123",
      webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
      endpointUrl: "https://openclaw.example/api/channels/discord/webhook",
      endpointConfigured: true,
      commandRegistered: true,
      connectability: makeConnectability("discord"),
    }),
  );

  const detailRows = html.match(/channel-detail-row/g) ?? [];
  assert.equal(detailRows.length, 3, `expected 3 detail rows when endpoint matches (found ${detailRows.length})`);
  assert.ok(!/>Endpoint<\/span>/.test(html), "no separate Endpoint row when URLs match");
});

/* ── Type contract: failure stubs satisfy RunAction and RequestJson ── */

test("DiscordPanel accepts failure-shaped RunAction and RequestJson stubs", () => {
  const html = renderToStaticMarkup(
    <DiscordPanel
      status={makeStatus({
        configured: true,
        appName: "TestBot",
        webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
        connectability: makeConnectability("discord"),
      })}
      busy={false}
      runAction={RUN_ACTION_FAILURE}
      requestJson={REQUEST_JSON_FAILURE}
    />,
  );

  assert.ok(html.includes("Connected"), "renders connected state with failure stubs");
  assert.ok(html.includes("Disconnect"), "disconnect button present with failure stubs");
});
