import assert from "node:assert/strict";
import { test } from "node:test";

import type { SingleMeta } from "@/shared/types";
import type { WatchdogReport } from "@/shared/watchdog";
import { runSandboxWatchdog } from "@/server/watchdog/run";

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

function findCheck(report: WatchdogReport, id: string) {
  return report.checks.find((check) => (check.id as string) === id);
}

function makeDeps(overrides: Partial<Parameters<typeof runSandboxWatchdog>[1]> = {}) {
  return {
    buildContract: async () => ({
      ok: true,
      authMode: "admin-secret" as const,
      storeBackend: "upstash" as const,
      aiGatewayAuth: "oidc" as const,
      openclawPackageSpec: "openclaw@1.2.3",
      requirements: [],
    }),
    getMeta: async () =>
      ({ status: "running", sandboxId: "sbx_123" }) as SingleMeta,
    probe: async () => ({ ready: true }),
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
        return { status: "running" } as SingleMeta;
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
        return { status: "running" } as SingleMeta;
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
