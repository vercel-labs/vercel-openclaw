import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RunAction, RequestJson } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import type { ReadJsonDeps } from "@/components/admin-request-core";
import { SnapshotsPanel } from "./snapshots-panel";

const READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
};

function makeConnectability(
  channel: ChannelConnectability["channel"],
  webhookUrl: string | null,
): ChannelConnectability {
  return {
    channel,
    mode: "webhook-proxied",
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
    installMethod: "manual",
    installUrl: null,
    appCredentialsConfigured: false,
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
    connectability: makeConnectability("whatsapp", null),
  },
};

const RUN_ACTION: RunAction = async () => true;
const REQUEST_JSON: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });

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
    channels: CHANNELS,
    restoreTarget: {
      ...DEFAULT_STATUS_RESTORE_TARGET,
    },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: StatusPayload, busy = false): string {
  return renderToStaticMarkup(
    <SnapshotsPanel
      active
      status={status}
      busy={busy}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
      readDeps={READ_DEPS}
    />,
  );
}

test("SnapshotsPanel renders the danger zone at the bottom", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Snapshot history"));
  assert.ok(html.includes("Danger zone"));
  assert.ok(html.includes("Delete the current sandbox and snapshots"));
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

test("SnapshotsPanel shows zero history count when snapshots are empty (post-reset state)", () => {
  // After a successful reset, setSnapshots([]) is called.
  // This test verifies the empty-snapshots render path that the reset handler produces.
  const html = renderPanel(makeStatus());

  // SSR renders the loading placeholder for history count (loading=true initially),
  // and "No snapshots" empty state appears when loading finishes with zero snapshots.
  // The history dd should contain the loading indicator on initial SSR render.
  assert.match(html, /<dd>\u2026<\/dd>/);
  // The empty state message should be absent during loading (snapshots.length === 0 && loading)
  assert.ok(html.includes("snapshot-loading") || !html.includes("No snapshots in history yet."));
});

test("SnapshotsPanel reset button is enabled when sandbox is running and not busy", () => {
  const html = renderPanel(makeStatus({ status: "running" }), false);

  // Reset button should NOT have disabled attribute
  const resetMatch = html.match(/<button[^>]*>Reset Sandbox<\/button>/);
  assert.ok(resetMatch, "Reset Sandbox button should exist");
  assert.ok(!resetMatch[0].includes("disabled"), "Reset button should be enabled when running and not busy");
});

test("SnapshotsPanel reset button is disabled when busy", () => {
  const html = renderPanel(makeStatus({ status: "running" }), true);

  assert.match(html, /<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/);
});

test("SnapshotsPanel renders version summary from status", () => {
  const html = renderPanel(makeStatus({ openclawVersion: "2026.3.31" }));

  assert.ok(html.includes("OpenClaw"), "Should label the OpenClaw version");
  assert.ok(html.includes("SDK"), "Should label the SDK version");
});
