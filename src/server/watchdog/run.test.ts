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

function makeDeps(overrides: Partial<Parameters<typeof runSandboxWatchdog>[1]> = {}) {
  return {
    buildContract: async () => ({
      ok: true,
      authMode: "deployment-protection" as const,
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
    readPrevious: async () => PREVIOUS,
    writeReport: async (next: WatchdogReport) => next,
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
  assert.equal(
    report.checks.find((check) => check.id === "reconcile")?.status,
    "pass",
  );
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
  assert.equal(
    report.checks.find((check) => check.id === "probe")?.status,
    "skip",
  );
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
  assert.equal(report.consecutiveFailures, 3); // previous was 2
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
