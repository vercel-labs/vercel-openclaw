import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RunAction } from "@/components/admin-types";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { getStatusRequestPath } from "../admin-shell";
import {
  deriveEffectiveStatus,
  getAutoSleepDisplay,
  StatusPanel,
} from "./status-panel";

type LifecycleAwareStatus = StatusPayload & {
  lifecycle?: {
    restoreHistory?: unknown[];
  };
  snapshotHistory?: unknown[];
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
const CHECK_HEALTH = async () => {};

function makeStatus(overrides: Partial<LifecycleAwareStatus> = {}): LifecycleAwareStatus {
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
      restorePreparedStatus: "unknown",
      restorePreparedReason: null,
      restorePreparedAt: null,
      snapshotDynamicConfigHash: null,
      runtimeDynamicConfigHash: null,
      snapshotAssetSha256: null,
      runtimeAssetSha256: null,
    },
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: LifecycleAwareStatus, pendingAction: string | null = null): string {
  return renderToStaticMarkup(
    <StatusPanel
      status={status}
      busy={pendingAction !== null}
      pendingAction={pendingAction}
      runAction={RUN_ACTION}
      checkHealth={CHECK_HEALTH}
    />,
  );
}

test("StatusPanel renders first-run callout and create action when sandbox is uninitialized", () => {
  const html = renderPanel(
    makeStatus({
      status: "uninitialized",
      sandboxId: null,
      snapshotId: null,
      gatewayReady: false,
      timeoutRemainingMs: null,
      lifecycle: { restoreHistory: [] },
    }),
  );

  assert.ok(html.includes("Create your sandbox"));
  assert.ok(html.includes("Create Sandbox"));
  assert.ok(
    html.includes(
      "This first start creates a new sandbox and installs OpenClaw. It can take a minute the first time.",
    ),
  );
});

test("StatusPanel renders first-run setup progress detail", () => {
  const html = renderPanel(
    makeStatus({
      status: "setup",
      snapshotId: null,
      gatewayReady: false,
      setupProgress: {
        attemptId: "attempt-1",
        active: true,
        phase: "installing-openclaw",
        phaseLabel: "Installing OpenClaw",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        preview: "npm notice added 1 package",
        lines: [
          { ts: Date.now(), stream: "stdout", text: "npm info using node" },
          { ts: Date.now(), stream: "stdout", text: "npm notice added 1 package" },
        ],
      },
      lifecycle: { restoreHistory: [] },
    }),
  );

  assert.ok(html.includes("Installing OpenClaw"));
  assert.ok(html.includes("Current phase"));
  assert.ok(html.includes("Recent setup logs"));
  assert.ok(html.includes("[stdout] npm notice added 1 package"));
});

test("StatusPanel renders restore action when errored with a snapshot", () => {
  const html = renderPanel(
    makeStatus({
      status: "error",
      lifecycle: { restoreHistory: [{ totalMs: 1000 }] },
    }),
  );

  assert.ok(html.includes("Restore Sandbox"));
});

test("StatusPanel renders Open Gateway as the main green running action", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Check health"));
  assert.ok(html.includes("Stop"));
  assert.match(html, /<a[^>]*class="button success"[^>]*>Open Gateway<\/a>/);
});

test("StatusPanel renders minute-only auto-sleep and gateway check metadata", () => {
  const now = Date.now();
  const html = renderPanel(
    makeStatus({
      timeoutRemainingMs: 125_000,
      timeoutSource: "estimated",
      gatewayStatus: "unknown",
      gatewayCheckedAt: now - 120_000,
    }),
  );

  assert.ok(html.includes("Auto-sleep"));
  assert.ok(html.includes("3m (estimated)"));
  assert.ok(html.includes("Gateway"));
  assert.ok(html.includes("Unknown"));
  assert.ok(html.includes("Checked 2m ago"));
  assert.ok(!html.includes("Last keepalive"));
});

test("StatusPanel renders past estimated sleep warning when timeout is expired", () => {
  const html = renderPanel(
    makeStatus({
      timeoutRemainingMs: 0,
      timeoutSource: "estimated",
    }),
  );

  assert.ok(html.includes("Past estimated sleep time"));
  assert.ok(html.includes("sandbox may be asleep"));
});

test("StatusPanel shows asleep badge and restart action after estimated timeout elapses", () => {
  const html = renderPanel(
    makeStatus({
      timeoutRemainingMs: 0,
      timeoutSource: "estimated",
    }),
  );

  assert.ok(html.includes("Asleep"));
  assert.ok(html.includes("Start Sandbox"));
  assert.ok(!html.includes(">Open Gateway</a>"));
  assert.ok(!html.includes(">Stop</button>"));
});

test("StatusPanel disables check health button while the health probe is pending", () => {
  const html = renderPanel(makeStatus(), "Check health");

  assert.match(html, /<button[^>]*disabled=""[^>]*>Checking health…<\/button>/);
});

test("getStatusRequestPath uses passive polling by default and live health on demand", () => {
  assert.equal(getStatusRequestPath(), "/api/status");
  assert.equal(getStatusRequestPath(false), "/api/status");
  assert.equal(getStatusRequestPath(true), "/api/status?health=1");
});

test("getAutoSleepDisplay shows source labels and estimated sleep warning", () => {
  assert.equal(
    getAutoSleepDisplay({ timeoutSource: "estimated" }, 65_000),
    "2m (estimated)",
  );
  assert.equal(
    getAutoSleepDisplay({ timeoutSource: "live" }, 65_000),
    "2m (live)",
  );
  assert.equal(
    getAutoSleepDisplay({ timeoutSource: "estimated" }, 0),
    "Past estimated sleep time — sandbox may be asleep",
  );
  assert.equal(getAutoSleepDisplay({ timeoutSource: "none" }, null), "Unknown");
});

test("StatusPanel keeps failed setup progress visible when status is error", () => {
  const html = renderPanel(
    makeStatus({
      status: "error",
      lastError: "gateway never became ready",
      setupProgress: {
        attemptId: "a1",
        active: false,
        phase: "failed",
        phaseLabel: "Starting gateway",
        startedAt: 1,
        updatedAt: 2,
        preview: "gateway never became ready",
        lines: [
          { ts: 3, stream: "stderr", text: "gateway never became ready" },
        ],
      },
    }),
  );

  // Failed step rail is visible
  assert.ok(html.includes('data-state="failed"'), "failed step rail should render");
  assert.ok(html.includes("Starting gateway"), "phase label should be visible");
  // Recent setup logs are visible
  assert.ok(html.includes("Recent setup logs"), "setup logs disclosure should render");
  assert.ok(
    html.includes("[stderr] gateway never became ready"),
    "log line should be visible",
  );
  // Error banner also renders
  assert.ok(html.includes("Gateway didn&#x27;t respond in time"), "error banner should render");
});

test("deriveEffectiveStatus returns asleep only for expired estimated running status", () => {
  assert.equal(deriveEffectiveStatus("running", 0, "estimated"), "asleep");
  assert.equal(deriveEffectiveStatus("running", 5_000, "estimated"), "running");
  assert.equal(deriveEffectiveStatus("running", 0, "live"), "running");
  assert.equal(deriveEffectiveStatus("stopped", 0, "estimated"), "stopped");
  assert.equal(deriveEffectiveStatus("running", null, "estimated"), "running");
});
