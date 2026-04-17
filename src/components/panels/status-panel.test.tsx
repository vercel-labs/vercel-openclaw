import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RunAction } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import {
  deriveEffectiveStatus,
  getAutoSleepDisplay,
  StatusPanel,
} from "./status-panel";

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

const DEFAULT_RESTORE_TARGET: StatusPayload["restoreTarget"] =
  DEFAULT_STATUS_RESTORE_TARGET;

const DEFAULT_LIFECYCLE: StatusPayload["lifecycle"] =
  DEFAULT_STATUS_LIFECYCLE;

const RUN_ACTION: RunAction = async () => true;

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
    restoreTarget: DEFAULT_RESTORE_TARGET,
    lifecycle: DEFAULT_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: StatusPayload, pendingAction: string | null = null): string {
  return renderToStaticMarkup(
    <StatusPanel
      status={status}
      busy={pendingAction !== null}
      pendingAction={pendingAction}
      runAction={RUN_ACTION}
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
    }),
  );

  assert.ok(html.includes("Restore Sandbox"));
});

test("StatusPanel renders Open Gateway as the main green running action", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Stop"));
  assert.match(html, /<a[^>]*class="button success"[^>]*>Open Gateway<\/a>/);
});

test("StatusPanel hides gateway card when status is unknown", () => {
  const html = renderPanel(
    makeStatus({
      timeoutRemainingMs: 125_000,
      timeoutSource: "estimated",
      gatewayStatus: "unknown",
    }),
  );

  assert.ok(html.includes("Auto-sleep"));
  assert.ok(html.includes("3m (estimated)"));
  // "Open Gateway" button is fine — we're checking the metrics card isn't shown
  assert.ok(!html.includes(">Unknown<"), "gateway Unknown value should not render as a metric");
});

test("StatusPanel shows gateway card when status is ready", () => {
  const now = Date.now();
  const html = renderPanel(
    makeStatus({
      gatewayStatus: "ready",
      gatewayCheckedAt: now - 120_000,
    }),
  );

  assert.ok(html.includes("Gateway"));
  assert.ok(html.includes("Ready"));
  assert.ok(html.includes("Checked 2m ago"));
});

test("StatusPanel shows stopped layout (no auto-sleep card) when timeout is expired", () => {
  const html = renderPanel(
    makeStatus({
      timeoutRemainingMs: 0,
      timeoutSource: "estimated",
    }),
  );

  // When asleep, auto-sleep is not shown — the panel uses the stopped layout
  assert.ok(!html.includes("Auto-sleep"), "auto-sleep should not appear in stopped layout");
  // But the badge shows asleep
  assert.ok(html.includes("Asleep"));
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

test("StatusPanel shows channel summary when channels are configured", () => {
  const html = renderPanel(
    makeStatus({
      channels: {
        ...CHANNELS,
        slack: { ...CHANNELS.slack, configured: true },
        telegram: { ...CHANNELS.telegram, configured: true },
      },
    }),
  );

  assert.ok(html.includes("Channels"));
  assert.ok(html.includes("Slack, Telegram"));
});

test("StatusPanel shows restore estimate from lifecycle metrics", () => {
  const html = renderPanel(
    makeStatus({
      status: "stopped",
      lifecycle: {
        ...DEFAULT_LIFECYCLE,
        lastRestoreMetrics: {
          sandboxCreateMs: 2000,
          tokenWriteMs: 100,
          assetSyncMs: 500,
          startupScriptMs: 300,
          forcePairMs: 200,
          firewallSyncMs: 100,
          localReadyMs: 3000,
          publicReadyMs: 1000,
          totalMs: 8200,
          skippedStaticAssetSync: false,
          assetSha256: "abc",
          vcpus: 2,
          recordedAt: Date.now(),
        },
      },
    }),
  );

  assert.ok(html.includes("~8s on 2 vCPUs"));
});

test("StatusPanel shows last active time when stopped", () => {
  const html = renderPanel(
    makeStatus({
      status: "stopped",
      lastKeepaliveAt: Date.now() - 120_000,
    }),
  );

  assert.ok(html.includes("Last active"));
  assert.ok(html.includes("2m ago"));
});

test("StatusPanel shows token health warning when failures exist", () => {
  const html = renderPanel(
    makeStatus({
      status: "stopped",
      lifecycle: {
        ...DEFAULT_LIFECYCLE,
        consecutiveTokenRefreshFailures: 3,
        breakerOpenUntil: null,
      },
    }),
  );

  assert.ok(html.includes("Token health"));
  assert.ok(html.includes("3 consecutive failures"));
});

test("StatusPanel shows firewall mode when running and not disabled", () => {
  const html = renderPanel(
    makeStatus({
      firewall: {
        mode: "enforcing",
        allowlist: ["example.com", "api.example.com"],
        learned: [],
        events: [],
        updatedAt: 0,
        lastIngestedAt: null,
        learningStartedAt: null,
        commandsObserved: 0,
        wouldBlock: [],
      },
    }),
  );

  assert.ok(html.includes("Firewall"));
  assert.ok(html.includes("Enforcing"));
  assert.ok(html.includes("2 domains"));
});

test("StatusPanel shows sandbox ID when running", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Sandbox"));
  assert.ok(html.includes("sbx-test"));
});

test("StatusPanel hides auto-sleep card when stopped", () => {
  const html = renderPanel(
    makeStatus({
      status: "stopped",
      timeoutRemainingMs: null,
      timeoutSource: "none",
    }),
  );

  assert.ok(!html.includes("Auto-sleep"));
});
