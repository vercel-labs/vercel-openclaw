import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { TelegramPanel } from "./telegram-panel";

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
  telegramOverrides: Partial<StatusPayload["channels"]["telegram"]> = {},
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
        webhookUrl: "",
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
        ...telegramOverrides,
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

/* ── Unconfigured form ── */

test("TelegramPanel renders connect form when unconfigured", () => {
  const html = renderToStaticMarkup(
    <TelegramPanel
      status={makeStatus()}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Connect Telegram"), "shows connect title");
  assert.ok(html.includes("Bot token"), "shows bot token field");
  assert.ok(html.includes("Connect"), "shows connect button");
});

/* ── Connected card ── */

test("TelegramPanel renders connected card with consistent action ordering", () => {
  const html = renderToStaticMarkup(
    <TelegramPanel
      status={makeStatus({
        configured: true,
        botUsername: "test_bot",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        status: "connected",
        commandSyncStatus: "synced",
        connectability: makeConnectability("telegram"),
      })}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("Connected · @test_bot"), "connected header includes bot username");
  assert.ok(html.includes("connected"), "pill shows connected status");
  assert.ok(html.includes("Update credentials"), "has update credentials action");
  assert.ok(html.includes("Sync commands"), "has sync commands action");
  assert.ok(html.includes("Disconnect"), "has disconnect action");

  const updateIdx = html.indexOf("Update credentials");
  const disconnectIdx = html.indexOf("Disconnect");
  assert.ok(updateIdx < disconnectIdx, "Update credentials appears before Disconnect");
});

/* ── Type contract: failure stubs satisfy RunAction and RequestJson ── */

test("TelegramPanel accepts failure-shaped RunAction and RequestJson stubs", () => {
  const html = renderToStaticMarkup(
    <TelegramPanel
      status={makeStatus({
        configured: true,
        botUsername: "test_bot",
        status: "connected",
        connectability: makeConnectability("telegram"),
      })}
      busy={false}
      runAction={RUN_ACTION_FAILURE}
      requestJson={REQUEST_JSON_FAILURE}
    />,
  );

  assert.ok(html.includes("Connected"), "renders connected state with failure stubs");
  assert.ok(html.includes("Disconnect"), "disconnect button present with failure stubs");
});

/* ── Error state display ── */

test("TelegramPanel shows error pill when status is error", () => {
  const html = renderToStaticMarkup(
    <TelegramPanel
      status={makeStatus({
        configured: true,
        botUsername: "broken_bot",
        status: "error",
        lastError: "Webhook registration failed",
        connectability: makeConnectability("telegram"),
      })}
      busy={false}
      runAction={RUN_ACTION_SUCCESS}
      requestJson={REQUEST_JSON_SUCCESS}
    />,
  );

  assert.ok(html.includes("error"), "shows error pill");
  assert.ok(html.includes("Webhook registration failed"), "shows error message");
});
