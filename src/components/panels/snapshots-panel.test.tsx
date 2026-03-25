import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { SnapshotsPanel } from "./snapshots-panel";

function makeConnectability(
  channel: ChannelConnectability["channel"],
  webhookUrl: string | null,
): ChannelConnectability {
  return {
    channel,
    canConnect: true,
    status: "pass",
    webhookUrl,
    issues: [],
  };
}

const CHANNELS: StatusPayload["channels"] = {
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
    connectability: makeConnectability("slack", ""),
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
    connectability: makeConnectability("telegram", null),
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
    connectability: makeConnectability("discord", ""),
  },
};

const RUN_ACTION: RunAction = async () => {};
const REQUEST_JSON: RequestJson = async () => null;

function makeStatus(overrides: Partial<StatusPayload> = {}): StatusPayload {
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
    channels: CHANNELS,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: StatusPayload, busy = false): string {
  return renderToStaticMarkup(
    <SnapshotsPanel
      status={status}
      busy={busy}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
    />,
  );
}

test("SnapshotsPanel renders the danger zone at the bottom", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Snapshot history"));
  assert.ok(html.includes("Danger zone"));
  assert.ok(html.includes("Delete the current sandbox and all saved snapshots"));
  assert.match(html, /<button[^>]*>Reset Sandbox<\/button>/);
});

test("SnapshotsPanel disables reset while the sandbox is uninitialized or transitioning", () => {
  const uninitializedHtml = renderPanel(
    makeStatus({
      status: "uninitialized",
      sandboxId: null,
      snapshotId: null,
    }),
  );
  const setupHtml = renderPanel(makeStatus({ status: "setup" }));

  assert.match(uninitializedHtml, /<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/);
  assert.match(setupHtml, /<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/);
});
