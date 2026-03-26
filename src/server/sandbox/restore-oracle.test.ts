import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeGatewayConfigHash } from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import {
  runRestoreOracleCycle,
  type RestoreOracleDeps,
} from "@/server/sandbox/restore-oracle";
import type { PrepareRestoreResult } from "@/server/sandbox/lifecycle";
import type { RestoreDecision } from "@/shared/restore-decision";
import { createDefaultMeta, type SingleMeta } from "@/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultMetaForHashes = createDefaultMeta(1_000_000, "gw-token");
const desiredDynamicConfigHash = computeGatewayConfigHash({
  telegramBotToken: defaultMetaForHashes.channels.telegram?.botToken,
  telegramWebhookSecret: defaultMetaForHashes.channels.telegram?.webhookSecret,
  slackCredentials: defaultMetaForHashes.channels.slack
    ? {
        botToken: defaultMetaForHashes.channels.slack.botToken,
        signingSecret: defaultMetaForHashes.channels.slack.signingSecret,
      }
    : undefined,
  whatsappConfig: defaultMetaForHashes.channels.whatsapp
    ? {
        accessToken: defaultMetaForHashes.channels.whatsapp.accessToken,
        phoneNumberId: defaultMetaForHashes.channels.whatsapp.phoneNumberId,
        verifyToken: defaultMetaForHashes.channels.whatsapp.verifyToken,
        appSecret: defaultMetaForHashes.channels.whatsapp.appSecret,
      }
    : undefined,
});
const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

function baseMeta(overrides: Partial<SingleMeta> = {}): SingleMeta {
  const base = createDefaultMeta(1_000_000, "gw-token");
  return {
    ...base,
    status: "running",
    sandboxId: "sbx_123",
    snapshotId: "snap_old",
    lastAccessedAt: 0,
    snapshotDynamicConfigHash: "stale-snapshot-hash",
    runtimeDynamicConfigHash: "fresh-runtime-hash",
    snapshotAssetSha256: "stale-asset-hash",
    runtimeAssetSha256: "fresh-runtime-asset-hash",
    restorePreparedStatus: "dirty",
    restorePreparedReason: "dynamic-config-changed",
    restorePreparedAt: null,
    restoreOracle: {
      status: "idle",
      pendingReason: "dynamic-config-changed",
      lastEvaluatedAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastBlockedReason: null,
      lastError: null,
      consecutiveFailures: 0,
      lastResult: null,
    },
    ...overrides,
  };
}

function buildDeps(
  meta: SingleMeta,
  overrides: Partial<RestoreOracleDeps> = {},
): {
  deps: RestoreOracleDeps;
  getMeta: () => SingleMeta;
  setMeta: (next: SingleMeta) => void;
} {
  let current = meta;

  const deps: RestoreOracleDeps = {
    getMeta: async () => current,
    mutate: async (fn) => {
      const draft = structuredClone(current);
      const result = fn(draft);
      current = (result ?? draft) as SingleMeta;
      return current;
    },
    probe: async () => ({ ready: true }),
    prepare: async () => {
      throw new Error("prepare should not run");
    },
    now: () => 1_000_000,
    ...overrides,
  };

  return {
    deps,
    getMeta: () => current,
    setMeta: (next) => {
      current = next;
    },
  };
}

function stubDecision(overrides: Partial<RestoreDecision> = {}): RestoreDecision {
  return {
    schemaVersion: 1,
    source: "prepare",
    destructive: true,
    reusable: false,
    needsPrepare: true,
    blocking: true,
    reasons: [],
    requiredActions: [],
    nextAction: null,
    status: "stopped",
    sandboxId: null,
    snapshotId: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    oracleStatus: null,
    idleMs: null,
    minIdleMs: null,
    probeReady: null,
    desiredDynamicConfigHash: "stub",
    snapshotDynamicConfigHash: null,
    runtimeDynamicConfigHash: null,
    desiredAssetSha256: "stub",
    snapshotAssetSha256: null,
    runtimeAssetSha256: null,
    ...overrides,
  };
}

const successPrepare: PrepareRestoreResult = {
  ok: true,
  destructive: true,
  state: "ready",
  reason: "prepared",
  snapshotId: "snap_new",
  snapshotDynamicConfigHash: desiredDynamicConfigHash,
  runtimeDynamicConfigHash: desiredDynamicConfigHash,
  snapshotAssetSha256: desiredAssetSha256,
  runtimeAssetSha256: desiredAssetSha256,
  preparedAt: 1_000_000,
  actions: [],
  decision: stubDecision({ reusable: true, needsPrepare: false, blocking: false }),
};

const failedPrepare: PrepareRestoreResult = {
  ok: false,
  destructive: true,
  state: "failed",
  reason: "prepare-failed",
  snapshotId: null,
  snapshotDynamicConfigHash: null,
  runtimeDynamicConfigHash: null,
  snapshotAssetSha256: null,
  runtimeAssetSha256: null,
  preparedAt: null,
  actions: [],
  decision: stubDecision({ reusable: false, reasons: ["restore-target-failed"] }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRestoreOracleCycle", () => {
  test("skips when restore target is already reusable", async () => {
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    const meta = baseMeta({
      snapshotDynamicConfigHash: desiredConfigHash,
      runtimeDynamicConfigHash: desiredConfigHash,
      snapshotAssetSha256: desiredAssetSha256,
      runtimeAssetSha256: desiredAssetSha256,
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-ready");
    assert.equal(result.attestation.reusable, true);
    assert.equal(result.prepare, null);
    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.lastResult, "already-ready");

    // Decision reflects already-reusable state
    assert.equal(result.decision.schemaVersion, 1);
    assert.equal(result.decision.source, "oracle");
    assert.equal(result.decision.reusable, true);
    assert.equal(result.decision.needsPrepare, false);
    assert.equal(result.decision.blocking, false);
    assert.deepEqual(result.decision.requiredActions, []);
    assert.equal(result.decision.nextAction, null);
  });

  test("blocks when sandbox was active too recently", async () => {
    const meta = baseMeta({
      lastAccessedAt: 990_000,
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      {
        origin: "https://app.example.com",
        reason: "test",
        minIdleMs: 30_000,
      },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "sandbox-recently-active");
    assert.equal(result.idleMs, 10_000);
    assert.equal(result.minIdleMs, 30_000);
    assert.equal(getMeta().restoreOracle.status, "blocked");
    assert.equal(getMeta().restoreOracle.lastResult, "blocked");
    assert.ok(
      getMeta().restoreOracle.lastBlockedReason?.includes("10000ms ago"),
    );

    // Decision captures recent-activity blocking with exact context
    assert.equal(result.decision.reusable, false);
    assert.ok(result.decision.reasons.includes("sandbox-recently-active"));
    assert.equal(result.decision.nextAction, "prepare-destructive");
    assert.deepEqual(result.decision.requiredActions, ["prepare-destructive"]);
    assert.equal(result.decision.idleMs, 10_000);
    assert.equal(result.decision.minIdleMs, 30_000);
  });

  test("blocks when sandbox is not running", async () => {
    const meta = baseMeta({
      status: "stopped",
      sandboxId: null,
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "sandbox-not-running");
    assert.equal(getMeta().restoreOracle.status, "blocked");

    // Decision captures sandbox-not-running with ensure-running as next action
    assert.equal(result.decision.reusable, false);
    assert.ok(result.decision.reasons.includes("sandbox-not-running"));
    assert.deepEqual(result.decision.requiredActions, [
      "ensure-running",
      "prepare-destructive",
    ]);
    assert.equal(result.decision.nextAction, "ensure-running");
    assert.equal(result.decision.oracleStatus, "blocked");
  });

  test("blocks when oracle is already running", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "running",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 500_000,
        lastStartedAt: 500_000,
        lastCompletedAt: null,
        lastBlockedReason: null,
        lastError: null,
        consecutiveFailures: 0,
        lastResult: null,
      },
    });

    const { deps } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-running");
  });

  test("blocks when gateway probe fails", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      probe: async () => ({ ready: false, error: "Connection refused" }),
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "gateway-not-ready");
    assert.equal(getMeta().restoreOracle.status, "blocked");
    assert.equal(
      getMeta().restoreOracle.lastBlockedReason,
      "Connection refused",
    );

    // Decision captures gateway-not-ready with probeReady=false
    assert.equal(result.decision.reusable, false);
    assert.ok(result.decision.reasons.includes("gateway-not-ready"));
    assert.equal(result.decision.probeReady, false);
  });

  test("executes prepare when sandbox is running, idle, dirty, and probe-ready", async () => {
    const meta = baseMeta({
      lastAccessedAt: 0,
    });

    let prepareCalled = false;
    const { deps, getMeta, setMeta } = buildDeps(meta, {
      prepare: async (input) => {
        prepareCalled = true;
        assert.equal(input.destructive, true);
        assert.equal(input.origin, "https://app.example.com");
        setMeta({
          ...getMeta(),
          snapshotId: successPrepare.snapshotId,
          snapshotDynamicConfigHash: successPrepare.snapshotDynamicConfigHash,
          runtimeDynamicConfigHash: successPrepare.runtimeDynamicConfigHash,
          snapshotAssetSha256: successPrepare.snapshotAssetSha256,
          runtimeAssetSha256: successPrepare.runtimeAssetSha256,
          restorePreparedStatus: successPrepare.state,
          restorePreparedReason: successPrepare.reason,
          restorePreparedAt: successPrepare.preparedAt,
        });
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "watchdog:restore-prepare" },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
    assert.equal(result.prepare?.ok, true);
    assert.equal(result.prepare?.snapshotId, "snap_new");
    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.lastResult, "prepared");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 0);
    assert.equal(result.decision.reusable, true);
    assert.equal(result.decision.oracleStatus, "ready");
    assert.equal(result.decision.snapshotId, "snap_new");
    assert.deepEqual(result.decision.requiredActions, []);
    assert.equal(result.decision.nextAction, null);
  });

  test("records failure when prepare returns ok=false", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => failedPrepare,
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
    assert.equal(result.prepare?.ok, false);
    assert.equal(getMeta().restoreOracle.status, "failed");
    assert.equal(getMeta().restoreOracle.lastResult, "failed");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 1);
    assert.ok(getMeta().restoreOracle.lastError?.includes("prepare failed"));
    assert.equal(result.decision.oracleStatus, "failed");
  });

  test("records failure and rethrows when prepare throws", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => {
        throw new Error("Sandbox API unreachable");
      },
    });

    await assert.rejects(
      () =>
        runRestoreOracleCycle(
          { origin: "https://app.example.com", reason: "test" },
          deps,
        ),
      { message: "Sandbox API unreachable" },
    );

    assert.equal(getMeta().restoreOracle.status, "failed");
    assert.equal(getMeta().restoreOracle.lastResult, "failed");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 1);
    assert.equal(
      getMeta().restoreOracle.lastError,
      "Sandbox API unreachable",
    );
  });

  test("force=true bypasses idle gating", async () => {
    const meta = baseMeta({
      lastAccessedAt: 999_999,
    });

    let prepareCalled = false;
    const { deps, getMeta, setMeta } = buildDeps(meta, {
      prepare: async () => {
        prepareCalled = true;
        setMeta({
          ...getMeta(),
          snapshotId: successPrepare.snapshotId,
          snapshotDynamicConfigHash: successPrepare.snapshotDynamicConfigHash,
          runtimeDynamicConfigHash: successPrepare.runtimeDynamicConfigHash,
          snapshotAssetSha256: successPrepare.snapshotAssetSha256,
          runtimeAssetSha256: successPrepare.runtimeAssetSha256,
          restorePreparedStatus: successPrepare.state,
          restorePreparedReason: successPrepare.reason,
          restorePreparedAt: successPrepare.preparedAt,
        });
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      {
        origin: "https://app.example.com",
        reason: "launch-verify:restore-prepare",
        force: true,
        minIdleMs: 300_000,
      },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
  });

  test("consecutive failures increment on repeated failures", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "failed",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 800_000,
        lastStartedAt: 800_000,
        lastCompletedAt: 800_000,
        lastBlockedReason: null,
        lastError: "previous error",
        consecutiveFailures: 2,
        lastResult: "failed",
      },
    });

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => failedPrepare,
    });

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.consecutiveFailures, 3);
  });

  test("successful prepare resets consecutive failures", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "failed",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 800_000,
        lastStartedAt: 800_000,
        lastCompletedAt: 800_000,
        lastBlockedReason: null,
        lastError: "previous error",
        consecutiveFailures: 5,
        lastResult: "failed",
      },
    });

    const { deps, getMeta, setMeta } = buildDeps(meta, {
      prepare: async () => {
        setMeta({
          ...getMeta(),
          snapshotId: successPrepare.snapshotId,
          snapshotDynamicConfigHash: successPrepare.snapshotDynamicConfigHash,
          runtimeDynamicConfigHash: successPrepare.runtimeDynamicConfigHash,
          snapshotAssetSha256: successPrepare.snapshotAssetSha256,
          runtimeAssetSha256: successPrepare.runtimeAssetSha256,
          restorePreparedStatus: successPrepare.state,
          restorePreparedReason: successPrepare.reason,
          restorePreparedAt: successPrepare.preparedAt,
        });
        return successPrepare;
      },
    });

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 0);
    assert.equal(getMeta().restoreOracle.lastError, null);
  });

  test("sets lastEvaluatedAt on every cycle", async () => {
    const meta = baseMeta({
      status: "stopped",
      sandboxId: null,
    });

    const { deps, getMeta } = buildDeps(meta);

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.lastEvaluatedAt, 1_000_000);
  });

  test("null lastAccessedAt does not block idle gating", async () => {
    const meta = baseMeta({
      lastAccessedAt: null,
    });

    let prepareCalled = false;
    const { deps, getMeta, setMeta } = buildDeps(meta, {
      prepare: async () => {
        prepareCalled = true;
        setMeta({
          ...getMeta(),
          snapshotId: successPrepare.snapshotId,
          snapshotDynamicConfigHash: successPrepare.snapshotDynamicConfigHash,
          runtimeDynamicConfigHash: successPrepare.runtimeDynamicConfigHash,
          snapshotAssetSha256: successPrepare.snapshotAssetSha256,
          runtimeAssetSha256: successPrepare.runtimeAssetSha256,
          restorePreparedStatus: successPrepare.state,
          restorePreparedReason: successPrepare.reason,
          restorePreparedAt: successPrepare.preparedAt,
        });
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test", minIdleMs: 300_000 },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.idleMs, null);
  });

  test("CAS race on beginOracleRun returns already-running", async () => {
    const meta = baseMeta();

    // Simulate a race: the first mutate in beginOracleRun sees status !== "running",
    // but by the time it runs the mutator, another worker has set it to "running".
    let mutateCallCount = 0;
    const { deps } = buildDeps(meta, {
      mutate: async (fn) => {
        mutateCallCount++;
        // The 2nd mutate call is beginOracleRun. Simulate a race by setting
        // status to "running" just before the mutator runs.
        if (mutateCallCount === 2) {
          meta.restoreOracle.status = "running";
        }
        const draft = structuredClone(meta);
        fn(draft);
        return meta;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-running");
  });
});
