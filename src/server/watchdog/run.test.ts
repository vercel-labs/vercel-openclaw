import assert from "node:assert/strict";
import { test } from "node:test";

import type { RestoreOracleCycleResult } from "@/server/sandbox/restore-oracle";
import type { RestoreDecision } from "@/shared/restore-decision";
import type { SingleMeta } from "@/shared/types";
import type { WatchdogReport } from "@/shared/watchdog";
import { runSandboxWatchdog } from "@/server/watchdog/run";

function stubDecision(overrides: Partial<RestoreDecision> = {}): RestoreDecision {
  return {
    schemaVersion: 1,
    source: "oracle",
    destructive: true,
    reusable: false,
    needsPrepare: true,
    blocking: true,
    reasons: [],
    requiredActions: [],
    nextAction: null,
    status: "running",
    sandboxId: "sbx_123",
    snapshotId: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    oracleStatus: "idle",
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

/** Build a partial oracle result — only the fields the watchdog actually reads. */
function oracleResult(partial: Record<string, unknown>): RestoreOracleCycleResult {
  return partial as unknown as RestoreOracleCycleResult;
}

const PREVIOUS: WatchdogReport = {
  deploymentId: "dpl_test",
  ranAt: "2026-03-16T07:40:00.000Z",
  status: "ok",
  sandboxStatus: "running",
  triggeredRepair: false,
  consecutiveFailures: 2,
  lastError: null,
  checks: [],
};

function findCheck(report: WatchdogReport, id: WatchdogReport["checks"][number]["id"]) {
  return report.checks.find((check) => check.id === id);
}

function makeDeps(overrides: Partial<Parameters<typeof runSandboxWatchdog>[1]> = {}) {
  return {
    buildContract: async () => ({
      ok: true,
      authMode: "admin-secret" as const,
      storeBackend: "upstash" as const,
      aiGatewayAuth: "oidc" as const,
      openclawPackageSpec: "openclaw@1.2.3",
      openclawPackageSpecSource: "explicit" as const,
      requirements: [],
    }),
    getMeta: async () =>
      ({ status: "running", sandboxId: "sbx_123" }) as SingleMeta,
    probe: async () => ({ ready: true }),
    reconcileStale: async () =>
      ({ status: "running", sandboxId: "sbx_123" }) as SingleMeta,
    reconcile: async () => ({
      status: "recovering" as const,
      repaired: true,
      meta: { status: "booting" } as SingleMeta,
    }),
    ensureReady: async () => ({ status: "running" }) as SingleMeta,
    readPrevious: async () => PREVIOUS,
    writeReport: async (next: WatchdogReport) => next,
    getCronNextWakeMs: async () => null as number | null,
    clearCronNextWake: async () => {},
    runRestoreOracle: async () => oracleResult({
      executed: false,
      blockedReason: "already-ready",
      idleMs: null,
      minIdleMs: 300_000,
      attestation: { reusable: true, needsPrepare: false, reasons: [] },
      plan: { schemaVersion: 1, status: "ready", blocking: false, reasons: [], actions: [] },
      prepare: null,
      decision: stubDecision({ reusable: true, needsPrepare: false, blocking: false }),
    }),
    prepareHotSpare: async () => ({
      ok: true,
      reason: "skipped" as const,
      candidateSandboxId: null,
    }),
    now: (() => {
      let current = 0;
      return () => (current += 10);
    })(),
    ...overrides,
  };
}

test("running sandbox with healthy probe reports ok", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps(),
  );

  assert.equal(report.status, "ok");
  assert.equal(report.triggeredRepair, false);
  assert.equal(report.consecutiveFailures, 0);
  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
});

test("running sandbox with failed probe schedules repair", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      probe: async () => ({ ready: false, error: "ECONNREFUSED" }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  assert.equal(report.consecutiveFailures, 0);
  assert.equal(findCheck(report, "reconcile")?.status, "pass");
});

test("stopped sandbox stays idle and skips repair", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null }) as SingleMeta,
    }),
  );

  assert.equal(report.status, "idle");
  assert.equal(report.triggeredRepair, false);
  assert.equal(findCheck(report, "probe")?.status, "skip");
  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
});

test("failed probe with repair disabled reports failed", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog"), repair: false },
    makeDeps({
      probe: async () => ({ ready: false, error: "timeout" }),
    }),
  );

  assert.equal(report.status, "failed");
  assert.equal(report.triggeredRepair, false);
  assert.equal(report.consecutiveFailures, 3);
});

test("consecutive failures increment on failure and reset on success", async () => {
  const failReport = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog"), repair: false },
    makeDeps({
      probe: async () => ({ ready: false, error: "timeout" }),
    }),
  );
  assert.equal(failReport.consecutiveFailures, 3);

  const okReport = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps(),
  );
  assert.equal(okReport.consecutiveFailures, 0);
});

test("stopped sandbox with due cron job wakes sandbox", async () => {
  let ensureCalled = false;
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1, // in the past (now() starts at 10+)
      ensureReady: async () => {
        ensureCalled = true;
        return {
          status: "running",
          lastRestoreMetrics: {
            cronRestoreOutcome: "no-store-jobs",
          },
        } as SingleMeta;
      },
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(ensureCalled, true);
  assert.equal(cronCleared, true);
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("woke sandbox"));
  assert.equal(report.triggeredRepair, true);
  assert.equal(report.sandboxStatus, "running");
});

test("error status with snapshot and due cron job wakes sandbox", async () => {
  let ensureCalled = false;
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "error", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => {
        ensureCalled = true;
        return {
          status: "running",
          lastRestoreMetrics: {
            cronRestoreOutcome: "no-store-jobs",
          },
        } as SingleMeta;
      },
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(ensureCalled, true);
  assert.equal(cronCleared, true);
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.equal(report.triggeredRepair, true);
});

test("stopped persistent sandbox (sandboxId, no snapshotId) with due cron job wakes", async () => {
  let ensureCalled = false;
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: "oc-test-123", snapshotId: null }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => {
        ensureCalled = true;
        return {
          status: "running",
          lastRestoreMetrics: {
            cronRestoreOutcome: "already-present",
          },
        } as SingleMeta;
      },
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(ensureCalled, true);
  assert.equal(cronCleared, true);
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("woke sandbox"));
  assert.equal(report.triggeredRepair, true);
});

test("stopped sandbox with future cron job skips wake", async () => {
  let ensureCalled = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => Number.MAX_SAFE_INTEGER,
      ensureReady: async () => {
        ensureCalled = true;
        return { status: "running" } as SingleMeta;
      },
    }),
  );

  assert.equal(ensureCalled, false);
  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("min"));
});

test("stopped sandbox with null cron wake skips correctly", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => null,
    }),
  );

  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("No cron wake"));
});

test("cron wake retains wake key when store has jobs but cron restore failed", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1, // in the past
      ensureReady: async () => ({
        status: "running",
        lastRestoreMetrics: {
          cronRestoreOutcome: "restore-failed",
        },
      }) as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, false, "Wake key must be retained when cron restore fails");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("restore-failed"));
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("wake key retained"));
  assert.equal(report.triggeredRepair, true);
});

test("cron wake retains wake key when cron restore is unverified", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1, // in the past
      ensureReady: async () => ({
        status: "running",
        lastRestoreMetrics: {
          cronRestoreOutcome: "restore-unverified",
        },
      }) as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, false, "Wake key must be retained when cron restore is unverified");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("restore-unverified"));
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("wake key retained"));
  assert.equal(report.triggeredRepair, true);
});

test("cron wake clears wake key when cron restore already present", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => ({
        status: "running",
        lastRestoreMetrics: {
          cronRestoreOutcome: "already-present",
        },
      }) as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, true, "Wake key should be cleared when cron jobs are already present");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("already-present"));
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("woke sandbox"));
});

test("cron wake clears wake key when cron restore verified", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => ({
        status: "running",
        lastRestoreMetrics: {
          cronRestoreOutcome: "restored-verified",
        },
      }) as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, true, "Wake key should be cleared when cron restore is verified");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("restored-verified"));
});

test("cron wake retains wake key when cron restore outcome is undefined", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => ({
        status: "running",
      }) as unknown as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, false, "Wake key must be retained when cron restore outcome is undefined");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("wake key retained"));
  assert.equal(report.triggeredRepair, true);
});

test("cron wake retains wake key when cron restore outcome is store-invalid", async () => {
  let cronCleared = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null, snapshotId: "snap_123" }) as SingleMeta,
      getCronNextWakeMs: async () => 1,
      ensureReady: async () => ({
        status: "running",
        lastRestoreMetrics: {
          cronRestoreOutcome: "store-invalid",
        },
      }) as SingleMeta,
      clearCronNextWake: async () => {
        cronCleared = true;
      },
    }),
  );

  assert.equal(cronCleared, false, "Wake key must be retained when cron restore outcome is store-invalid");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("store-invalid"));
  assert.ok(findCheck(report, "cron.wake")?.message?.includes("wake key retained"));
  assert.equal(report.triggeredRepair, true);
});

test("stuck-busy recovery passes schedule callback to reconcile", async () => {
  let receivedSchedule: unknown = undefined;
  const fakeSchedule = () => {};
  const baseTime = Date.now();

  const report = await runSandboxWatchdog(
    {
      request: new Request("https://app.test/api/cron/watchdog"),
      schedule: fakeSchedule,
    },
    makeDeps({
      now: () => baseTime,
      getMeta: async () =>
        ({
          status: "restoring",
          sandboxId: null,
          updatedAt: baseTime - 120_000, // 2 minutes ago — past the 90s threshold
        }) as SingleMeta,
      reconcile: async (options) => {
        receivedSchedule = options.schedule;
        return {
          status: "recovering" as const,
          repaired: false,
          meta: { status: "restoring" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(receivedSchedule, fakeSchedule, "schedule callback must be forwarded to reconcile");
  assert.equal(report.status, "repairing");
  assert.equal(findCheck(report, "reconcile")?.status, "pass");
});

test("auto-slept sandbox reconciled to stopped without repair", async () => {
  let probeCalled = false;
  let reconcileCalled = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      // SDK reports sandbox is no longer running (auto-slept)
      reconcileStale: async () =>
        ({ status: "stopped", sandboxId: null }) as SingleMeta,
      probe: async () => {
        probeCalled = true;
        return { ready: false, error: "should not be called" };
      },
      reconcile: async () => {
        reconcileCalled = true;
        return {
          status: "recovering" as const,
          repaired: true,
          meta: { status: "booting" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(probeCalled, false, "Gateway probe must not be called when SDK says sandbox stopped");
  assert.equal(reconcileCalled, false, "Repair must not be triggered for naturally slept sandbox");
  assert.equal(report.status, "idle");
  assert.equal(report.sandboxStatus, "stopped");
  assert.equal(report.triggeredRepair, false);
  assert.equal(findCheck(report, "probe")?.status, "skip");
  assert.ok(findCheck(report, "probe")?.message?.includes("SDK reports sandbox is stopped"));
  assert.equal(findCheck(report, "reconcile")?.status, "skip");
});

test("probe-failed recovery passes schedule callback to reconcile", async () => {
  let receivedSchedule: unknown = undefined;
  const fakeSchedule = () => {};

  const report = await runSandboxWatchdog(
    {
      request: new Request("https://app.test/api/cron/watchdog"),
      schedule: fakeSchedule,
    },
    makeDeps({
      probe: async () => ({ ready: false, error: "ECONNREFUSED" }),
      reconcile: async (options) => {
        receivedSchedule = options.schedule;
        return {
          status: "recovering" as const,
          repaired: true,
          meta: { status: "booting" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(receivedSchedule, fakeSchedule, "schedule callback must be forwarded to reconcile");
  assert.equal(report.status, "repairing");
});

// ===========================================================================
// Restore oracle integration (restore.prepare check)
// ===========================================================================

test("restore.prepare: skip when oracle reports already-ready", async () => {
  const decision = stubDecision({ reusable: true, needsPrepare: false, blocking: false });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: false,
        blockedReason: "already-ready",
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: true, needsPrepare: false, reasons: [] },
        plan: { schemaVersion: 1, status: "ready", blocking: false, reasons: [], actions: [] },
        prepare: null,
        decision,
      }),
    }),
  );

  assert.equal(report.status, "ok");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "skip");
  assert.ok(check.message.includes("already reusable"));

  // Structured data includes decision
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.blockedReason, "already-ready");
  assert.equal((check.data.decision as RestoreDecision).reusable, true);
});

test("restore.prepare: skip when sandbox recently active", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale", "sandbox-recently-active"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: false,
        blockedReason: "sandbox-recently-active",
        idleMs: 60_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: null,
        decision,
      }),
    }),
  );

  assert.equal(report.status, "ok");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "skip");
  assert.ok(check.message.includes("sandbox-recently-active"));

  // Structured data includes decision with reasons and required actions
  assert.ok(check.data, "check should have structured data");
  assert.deepEqual(
    (check.data.decision as RestoreDecision).requiredActions,
    ["prepare-destructive"],
  );
  assert.ok((check.data.decision as RestoreDecision).reasons.includes("snapshot-config-stale"));
});

test("restore.prepare: pass when oracle executes and prepares successfully", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
          ok: true,
          destructive: true,
          state: "ready",
          reason: "prepared",
          snapshotId: "snap_fresh",
          snapshotDynamicConfigHash: "hash",
          runtimeDynamicConfigHash: "hash",
          snapshotAssetSha256: "sha",
          runtimeAssetSha256: "sha",
          preparedAt: Date.now(),
          actions: [],
        },
        decision,
      }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "pass");
  assert.ok(check.message.includes("snap_fresh"));

  // Structured data present on pass
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.blockedReason, null);
  assert.ok((check.data.decision as RestoreDecision).reasons.includes("snapshot-config-stale"));

  // Hot-spare fields populated from default (skipped) prepareHotSpare
  assert.equal(check.data.hotSpareReason, "skipped");
  assert.equal(check.data.hotSpareCandidateSandboxId, null);
});

test("restore.prepare: pass with hot-spare created after oracle prepare", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
          ok: true,
          destructive: true,
          state: "ready",
          reason: "prepared",
          snapshotId: "snap_fresh",
          snapshotDynamicConfigHash: "hash",
          runtimeDynamicConfigHash: "hash",
          snapshotAssetSha256: "sha",
          runtimeAssetSha256: "sha",
          preparedAt: Date.now(),
          actions: [],
        },
        decision,
      }),
      prepareHotSpare: async () => ({
        ok: true,
        reason: "created" as const,
        candidateSandboxId: "oc-spare-single-abc",
      }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "pass");

  // Hot-spare result fields present in structured data
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.hotSpareCandidateSandboxId, "oc-spare-single-abc");
  assert.equal(check.data.hotSpareReason, "created");
});

test("restore.prepare: fail when oracle executes but prepare fails", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
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
          actions: [{ id: "snapshot", status: "failed", message: "Snapshot timed out." }],
        },
        decision,
      }),
    }),
  );

  assert.equal(report.status, "failed");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "fail");
  assert.ok(check.message.includes("Snapshot timed out"));

  // Structured data present on failure
  assert.ok(check.data, "check should have structured data");
  assert.deepEqual(
    (check.data.decision as RestoreDecision).requiredActions,
    ["prepare-destructive"],
  );
});

test("restore.prepare: fail when oracle throws", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => {
        throw new Error("Sandbox API unreachable");
      },
    }),
  );

  assert.equal(report.status, "failed");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "fail");
  assert.ok(check.message.includes("Sandbox API unreachable"));
});
