import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RequestJson } from "@/components/admin-types";
import type { ReadJsonDeps } from "@/components/admin-request-core";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { FirewallPanel } from "./firewall-panel";

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

const READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
};

const REQUEST_JSON: RequestJson = async () => ({
  ok: true,
  data: null,
  meta: {
    requestId: "test",
    action: "test",
    label: "test",
    status: 200,
    refreshed: false,
  },
});

function makeStatus(overrides: Partial<StatusPayload> = {}): StatusPayload {
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
    channels: CHANNELS,
    restoreTarget: { ...DEFAULT_STATUS_RESTORE_TARGET },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(
  status: StatusPayload,
  busy = false,
): string {
  return renderToStaticMarkup(
    <FirewallPanel
      active
      status={status}
      busy={busy}
      requestJson={REQUEST_JSON}
      refresh={async () => {}}
      readDeps={READ_DEPS}
    />,
  );
}

test("FirewallPanel renders the policy section", () => {
  const html = renderPanel(makeStatus());
  assert.ok(html.includes("Firewall policy"));
  assert.ok(html.includes("Observed activity"));
});

test("FirewallPanel renders mode pills", () => {
  const html = renderPanel(makeStatus());
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("learning"));
  assert.ok(html.includes("enforcing"));
});

test("FirewallPanel shows learning-active indicator when in learning mode", () => {
  const html = renderPanel(makeStatus({ firewall: { ...makeStatus().firewall, mode: "learning" } }));
  assert.ok(html.includes("Learning active"));
});

test("FirewallPanel shows no events message when events are empty", () => {
  const html = renderPanel(makeStatus());
  assert.ok(html.includes("No firewall events yet"));
});

test("FirewallPanel requires readDeps prop", () => {
  const html = renderToStaticMarkup(
    <FirewallPanel
      active
      status={makeStatus()}
      busy={false}
      requestJson={REQUEST_JSON}
      refresh={async () => {}}
      readDeps={{
        setStatus: () => {},
        toastError: () => {},
      }}
    />,
  );
  assert.ok(html.includes("Firewall policy"));
});

// ---------------------------------------------------------------------------
// Stale-data banners are absent on initial render
// ---------------------------------------------------------------------------

test("FirewallPanel does not show report stale banner on initial render", () => {
  const html = renderPanel(makeStatus());
  assert.ok(
    !html.includes("Latest refresh failed"),
    "report stale banner should not appear initially",
  );
  assert.ok(
    !html.includes("Failed to load firewall report"),
    "report error banner should not appear initially",
  );
});

test("FirewallPanel does not show firewall logs stale banner on initial render", () => {
  const html = renderPanel(makeStatus());
  assert.ok(
    !html.includes("Failed to load firewall logs"),
    "firewall logs error banner should not appear initially",
  );
});
