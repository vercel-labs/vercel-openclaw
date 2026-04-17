import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { SlackPanel } from "./slack-panel";

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

const RUN_ACTION_SUCCESS: RunAction = async () => true;
const RUN_ACTION_FAILURE: RunAction = async () => false;
const REQUEST_JSON_SUCCESS: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });
const REQUEST_JSON_FAILURE: RequestJson = async () => ({
  ok: false,
  error: "HTTP 500",
  meta: { requestId: "test", action: "test", label: "test", status: 500, code: "http-error" as const, retryable: true },
});

function makeStatus(
  slackOverrides: Partial<StatusPayload["channels"]["slack"]> = {},
): StatusPayload {
  return {
    authMode: "admin-secret",
    storeBackend: "redis",
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
        webhookUrl: "https://openclaw.example/api/channels/slack/webhook",
        configuredAt: null,
        team: null,
        user: null,
        botId: null,
        hasSigningSecret: false,
        hasBotToken: false,
        lastError: null,
        connectability: makeConnectability("slack"),
        installMethod: "manual",
        installUrl: null,
        appCredentialsConfigured: false,
        appCredentialsSource: "none",
        appId: null,
        appName: null,
        appCreatedAt: null,
        ...slackOverrides,
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
        webhookUrl: "",
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
      ...DEFAULT_STATUS_RESTORE_TARGET,
    },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
  };
}

/* ── Unconfigured form (manual mode) ── */

test("SlackPanel renders connect form when unconfigured (manual mode)", () => {
  const html = renderToStaticMarkup(
    <SlackPanel
      status={makeStatus()}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Connect Slack"), "shows connect title");
  assert.ok(html.includes("Signing Secret"), "shows signing secret field");
  assert.ok(html.includes("Bot Token"), "shows bot token field");
  assert.ok(html.includes("Connect"), "shows connect button");
});

/* ── OAuth install button ── */

test("SlackPanel renders Install to Slack button when OAuth credentials configured", () => {
  const html = renderToStaticMarkup(
    <SlackPanel
      status={makeStatus({
        appCredentialsConfigured: true,
        installMethod: "oauth",
        installUrl: "/api/channels/slack/install",
      })}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Install to Slack"), "shows install button");
  assert.ok(html.includes("/api/channels/slack/install"), "install button links to install route");
  assert.ok(html.includes("or configure manually"), "shows manual fallback option");
  assert.ok(!html.includes("Signing Secret"), "does not show credential fields by default");
});

/* ── Connected card ── */

test("SlackPanel renders connected card with consistent action ordering", () => {
  const html = renderToStaticMarkup(
    <SlackPanel
      status={makeStatus({
        configured: true,
        team: "TestWorkspace",
        botId: "B123",
        webhookUrl: "https://openclaw.example/api/channels/slack/webhook",
        connectability: makeConnectability("slack"),
      })}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Connected · TestWorkspace"), "connected header includes team");
  assert.ok(html.includes("connected"), "pill shows connected status");
  assert.ok(html.includes("Update credentials"), "has update credentials action");
  assert.ok(html.includes("Disconnect"), "has disconnect action");

  const updateIdx = html.indexOf("Update credentials");
  const disconnectIdx = html.indexOf("Disconnect");
  assert.ok(updateIdx < disconnectIdx, "Update credentials appears before Disconnect");
});

/* ── Connected card with OAuth reinstall ── */

test("SlackPanel shows Reinstall to Slack when connected with OAuth credentials", () => {
  const html = renderToStaticMarkup(
    <SlackPanel
      status={makeStatus({
        configured: true,
        team: "TestWorkspace",
        botId: "B123",
        appCredentialsConfigured: true,
        installMethod: "oauth",
        installUrl: "/api/channels/slack/install",
        connectability: makeConnectability("slack"),
      })}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Reinstall to Slack"), "shows reinstall button");
  assert.ok(html.includes("Update credentials"), "still shows update credentials");
  assert.ok(html.includes("Disconnect"), "still shows disconnect");
});

/* ── Type contract: failure stubs satisfy RunAction and RequestJson ── */

test("SlackPanel accepts failure-shaped RunAction and RequestJson stubs", () => {
  const html = renderToStaticMarkup(
    <SlackPanel
      status={makeStatus({
        configured: true,
        team: "TestWorkspace",
        connectability: makeConnectability("slack"),
      })}
      busy={false}
      runAction={RUN_ACTION_FAILURE}
      requestJson={REQUEST_JSON_FAILURE}
    />,
  );

  assert.ok(html.includes("Connected"), "renders connected state with failure stubs");
  assert.ok(html.includes("Disconnect"), "disconnect button present with failure stubs");
});
