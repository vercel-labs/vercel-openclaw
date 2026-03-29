import { logInfo } from "@/server/log";
import { getStore } from "@/server/store/store";
import { watchdogReportKey } from "@/server/store/keyspace";
import { getCurrentDeploymentId } from "@/server/launch-verify/state";
import type { WatchdogReport } from "@/shared/watchdog";

export function defaultWatchdogReport(
  deploymentId = getCurrentDeploymentId(),
): WatchdogReport {
  return {
    deploymentId,
    ranAt: null,
    status: "idle",
    sandboxStatus: "uninitialized",
    triggeredRepair: false,
    consecutiveFailures: 0,
    lastError: null,
    checks: [],
  };
}

export async function readWatchdogReport(): Promise<WatchdogReport> {
  const deploymentId = getCurrentDeploymentId();
  const stored = await getStore().getValue<WatchdogReport>(watchdogReportKey());

  if (!stored || stored.deploymentId !== deploymentId) {
    return defaultWatchdogReport(deploymentId);
  }

  return stored;
}

export async function writeWatchdogReport(
  report: WatchdogReport,
): Promise<WatchdogReport> {
  await getStore().setValue(watchdogReportKey(), report);

  logInfo("watchdog.report_written", {
    deploymentId: report.deploymentId,
    status: report.status,
    triggeredRepair: report.triggeredRepair,
    consecutiveFailures: report.consecutiveFailures,
  });

  return report;
}
