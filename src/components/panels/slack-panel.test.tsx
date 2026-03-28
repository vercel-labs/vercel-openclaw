import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
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
const REQUEST_JSON_SUCCESS: RequestJson = async () => ({ ok: true, data: null });
const REQUEST_JSON_FAILURE: RequestJson = async () => ({
  ok: false,
  error: "HTTP 500",
});

function makeStatus(
  slackOverrides: Partial<StatusPayload["channels"]["slack"]> = {},
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
        webhookUrl: "https://openclaw.example/api/channels/slack/webhook",
        configuredAt: null,
        team: null,
        user: null,
        botId: null,
        hasSigningSecret: false,
        hasBotToken: false,
        lastError: null,
        connectability: makeConnectability("slack"),
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

/* ── Unconfigured form ── */

test("SlackPanel renders connect form when unconfigured", () => {
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
  assert.ok(html.includes("Save Credentials"), "shows save button");
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
