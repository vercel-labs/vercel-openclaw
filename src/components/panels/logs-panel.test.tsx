import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { SingleStatus } from "@/shared/types";

import type { ReadJsonDeps } from "@/components/admin-request-core";
import { LogsPanel } from "./logs-panel";

const READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
};

function makeConnectability(
  channel: ChannelConnectability["channel"],
): ChannelConnectability {
  return {
    channel,
    mode: "webhook-proxied",
    canConnect: true,
    status: "pass",
    webhookUrl: null,
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
    connectability: makeConnectability("slack"),
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
};

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
    restoreTarget: { ...DEFAULT_STATUS_RESTORE_TARGET },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: StatusPayload): string {
  return renderToStaticMarkup(<LogsPanel active status={status} readDeps={READ_DEPS} />);
}

// ---------------------------------------------------------------------------
// Empty-state messaging reflects lifecycle status
// ---------------------------------------------------------------------------

describe("LogsPanel empty-state messaging", () => {
  test("shows startup message during booting", () => {
    const html = renderPanel(makeStatus({ status: "booting" }));
    assert.ok(html.includes("starting up"), `expected startup message, got: ${html.slice(0, 300)}`);
  });

  test("shows startup message during setup", () => {
    const html = renderPanel(makeStatus({ status: "setup" }));
    assert.ok(html.includes("starting up"), `expected startup message, got: ${html.slice(0, 300)}`);
  });

  test("shows startup message during restoring", () => {
    const html = renderPanel(makeStatus({ status: "restoring" }));
    assert.ok(html.includes("starting up"), `expected startup message, got: ${html.slice(0, 300)}`);
  });

  test("shows creating message during creating", () => {
    const html = renderPanel(makeStatus({ status: "creating" }));
    assert.ok(html.includes("being created"), `expected creating message, got: ${html.slice(0, 300)}`);
  });

  test("shows stopped message when stopped", () => {
    const html = renderPanel(makeStatus({ status: "stopped" }));
    assert.ok(html.includes("stopped"), `expected stopped message, got: ${html.slice(0, 300)}`);
  });

  test("shows error message when in error state", () => {
    const html = renderPanel(makeStatus({ status: "error" }));
    assert.ok(html.includes("error state"), `expected error message, got: ${html.slice(0, 300)}`);
  });

  test("shows uninitialized message when uninitialized", () => {
    const html = renderPanel(makeStatus({ status: "uninitialized" }));
    assert.ok(html.includes("not been created"), `expected uninitialized message, got: ${html.slice(0, 300)}`);
  });
});

// ---------------------------------------------------------------------------
// Error banner visibility
// ---------------------------------------------------------------------------

describe("LogsPanel error banner", () => {
  const statesWithBanner: SingleStatus[] = ["stopped", "error"];
  const statesWithoutBanner: SingleStatus[] = ["running", "setup", "booting", "restoring", "creating", "uninitialized"];

  for (const status of statesWithBanner) {
    test(`shows error banner for "${status}"`, () => {
      const html = renderPanel(makeStatus({ status }));
      assert.ok(html.includes("not running"), `expected error banner for ${status}`);
    });
  }

  for (const status of statesWithoutBanner) {
    test(`does not show error banner for "${status}"`, () => {
      const html = renderPanel(makeStatus({ status }));
      assert.ok(!html.includes("Sandbox is not running"), `unexpected error banner for ${status}`);
    });
  }
});
