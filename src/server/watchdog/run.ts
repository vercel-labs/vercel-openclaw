import {
  buildDeploymentContract,
  type DeploymentContract,
} from "@/server/deployment-contract";
import { getCurrentDeploymentId } from "@/server/launch-verify/state";
import { logError, logInfo, logWarn } from "@/server/log";
import {
  createOperationContext,
} from "@/server/observability/operation-context";
import { getPublicOrigin } from "@/server/public-url";
import {
  CRON_NEXT_WAKE_KEY,
  ensureSandboxReady,
  isBusyStatus,
  prepareRestoreTarget,
  probeGatewayReady,
  reconcileSandboxHealth,
  reconcileStaleRunningStatus,
  type ProbeResult,
  type SandboxHealthResult,
} from "@/server/sandbox/lifecycle";
import {
  runRestoreOracleCycle,
  type RestoreOracleCycleResult,
} from "@/server/sandbox/restore-oracle";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import type {
  CronRestoreOutcome,
  OperationContext,
  SingleMeta,
} from "@/shared/types";
import type { WatchdogCheck, WatchdogReport } from "@/shared/watchdog";
import {
  readWatchdogReport,
  writeWatchdogReport,
} from "@/server/watchdog/state";

export type RunSandboxWatchdogOptions = {
  request: Request;
  repair?: boolean;
  schedule?: (callback: () => Promise<void> | void) => void;
};

export type WatchdogDeps = {
  buildContract: (options: { request?: Request }) => Promise<DeploymentContract>;
  getMeta: () => Promise<SingleMeta>;
  probe: () => Promise<ProbeResult>;
  reconcileStale: () => Promise<SingleMeta>;
  reconcile: (options: {
    origin: string;
    reason: string;
    schedule?: (callback: () => Promise<void> | void) => void;
    op?: OperationContext;
  }) => Promise<SandboxHealthResult>;
  ensureReady: (options: {
    origin: string;
    reason: string;
  }) => Promise<SingleMeta>;
  readPrevious: () => Promise<WatchdogReport>;
  writeReport: (report: WatchdogReport) => Promise<WatchdogReport>;
  getCronNextWakeMs: () => Promise<number | null>;
  clearCronNextWake: () => Promise<void>;
  runRestoreOracle: (input: {
    origin: string;
    reason: string;
    force?: boolean;
    minIdleMs?: number;
    op?: OperationContext;
  }) => Promise<RestoreOracleCycleResult>;
  now: () => number;
};

const WATCHDOG_CRON_WAKE_CHECK_ID = "cron.wake" as const;
const WATCHDOG_CRON_WAKE_CLEAR_OUTCOMES = new Set<CronRestoreOutcome>([
  "no-store-jobs",
  "already-present",
  "restored-verified",
]);

const defaultDeps: WatchdogDeps = {
  buildContract: buildDeploymentContract,
  getMeta: getInitializedMeta,
  probe: probeGatewayReady,
  reconcileStale: reconcileStaleRunningStatus,
  reconcile: reconcileSandboxHealth,
  ensureReady: ensureSandboxReady,
  readPrevious: readWatchdogReport,
  writeReport: writeWatchdogReport,
  getCronNextWakeMs: () => getStore().getValue<number>(CRON_NEXT_WAKE_KEY()),
  clearCronNextWake: () => getStore().deleteValue(CRON_NEXT_WAKE_KEY()),
  runRestoreOracle: (input) =>
    runRestoreOracleCycle(input, {
      getMeta: getInitializedMeta,
      mutate: mutateMeta,
      probe: probeGatewayReady,
      prepare: prepareRestoreTarget,
      now: () => Date.now(),
    }),
  now: () => Date.now(),
};

export async function runSandboxWatchdog(
  options: RunSandboxWatchdogOptions,
  deps: WatchdogDeps = defaultDeps,
): Promise<WatchdogReport> {
  const startedAt = deps.now();
  const deploymentId = getCurrentDeploymentId();
  const checks: WatchdogCheck[] = [];

  const addCheck = (
    id: WatchdogCheck["id"],
    status: WatchdogCheck["status"],
    stepStartedAt: number,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    const check: WatchdogCheck = {
      id,
      status,
      durationMs: Math.max(0, deps.now() - stepStartedAt),
      message,
    };
    if (data) check.data = data;
    checks.push(check);
  };

  let previous: WatchdogReport = {
    deploymentId,
    ranAt: null,
    status: "idle",
    sandboxStatus: "uninitialized",
    triggeredRepair: false,
    consecutiveFailures: 0,
    lastError: null,
    checks: [],
  };
  let meta: SingleMeta = { status: "uninitialized" } as SingleMeta;
  let status: WatchdogReport["status"] = "idle";
  let triggeredRepair = false;
  let lastError: string | null = null;

  try {
    previous = await deps.readPrevious();
    meta = await deps.getMeta();

    // Check deployment contract
    const contractStartedAt = deps.now();
    const contract = await deps.buildContract({ request: options.request });
    const failingRequirementIds = contract.requirements
      .filter((requirement) => requirement.status === "fail")
      .map((requirement) => requirement.id);

    if (failingRequirementIds.length > 0) {
      lastError = `Deployment contract failing: ${failingRequirementIds.join(", ")}`;
      addCheck("contract", "fail", contractStartedAt, lastError);
    } else {
      addCheck(
        "contract",
        "pass",
        contractStartedAt,
        `Deployment contract passed with ${contract.requirements.length} evaluated requirements.`,
      );
    }

    // Detect stuck busy states: restoring/creating with no sandboxId for >90s.
    if (isBusyStatus(meta.status) && !meta.sandboxId) {
      const ageMs = deps.now() - meta.updatedAt;
      const threshold = 90_000;

      if (ageMs > threshold) {
        const stuckMsg = `Sandbox stuck in ${meta.status} for ${Math.round(ageMs / 1000)}s with no sandboxId.`;
        addCheck("probe", "fail", deps.now(), stuckMsg);
        lastError = stuckMsg;

        if (options.repair !== false) {
          const repairStartedAt = deps.now();
          try {
            const watchdogOp = createOperationContext({
              trigger: "watchdog",
              reason: "watchdog:stuck_busy",
            });
            const result = await deps.reconcile({
              origin: getPublicOrigin(options.request),
              reason: "watchdog:stuck_busy",
              schedule: options.schedule,
              op: watchdogOp,
            });
            triggeredRepair = true;
            addCheck("reconcile", "pass", repairStartedAt,
              `Stuck ${meta.status} recovery triggered (result: ${result.status}).`);
            status = "repairing";
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            addCheck("reconcile", "fail", repairStartedAt, `Stuck recovery failed: ${errMsg}`);
            status = "failed";
          }
        } else {
          addCheck("reconcile", "skip", deps.now(), "Repair disabled for this run.");
          status = "failed";
        }
      } else {
        addCheck("probe", "skip", deps.now(),
          `Sandbox status is ${meta.status} (age ${Math.round(ageMs / 1000)}s, threshold ${Math.round(threshold / 1000)}s); waiting for operation.`);
        addCheck("reconcile", "skip", deps.now(), "Operation still within threshold.");
        status = failingRequirementIds.length > 0 ? "failed" : "idle";
      }
    } else if (meta.status !== "running" || !meta.sandboxId) {
      addCheck(
        "probe",
        "skip",
        deps.now(),
        `Sandbox status is ${meta.status}; watchdog does not wake idle sandboxes.`,
      );
      addCheck(
        "reconcile",
        "skip",
        deps.now(),
        "No repair needed because metadata does not claim the sandbox is running.",
      );
      status = failingRequirementIds.length > 0 ? "failed" : "idle";
    } else {
      // Before probing the gateway, check whether the sandbox is actually
      // still running via the SDK.  When the platform auto-sleeps a sandbox
      // after its timeout, metadata still says "running" — probing and then
      // repairing would needlessly restore it.
      const staleCheckStart = deps.now();
      const reconciledMeta = await deps.reconcileStale();
      if (reconciledMeta.status !== "running") {
        addCheck("probe", "skip", staleCheckStart,
          `SDK reports sandbox is ${reconciledMeta.status}; metadata reconciled from stale running state.`);
        addCheck("reconcile", "skip", deps.now(),
          "No repair needed — sandbox naturally slept after timeout.");
        meta = reconciledMeta;
        status = failingRequirementIds.length > 0 ? "failed" : "idle";
      } else {

      const probeStartedAt = deps.now();
      const probe = await deps.probe();

      if (probe.ready) {
        addCheck("probe", "pass", probeStartedAt, "Gateway probe returned the openclaw-app marker.");
        addCheck("reconcile", "skip", deps.now(), "Probe passed; no repair scheduled.");

        // Restore oracle: attempt to seal a fresh restore target when idle
        const restorePrepareStartedAt = deps.now();
        try {
          const oracle = await deps.runRestoreOracle({
            origin: getPublicOrigin(options.request),
            reason: "watchdog:restore-prepare",
          });

          const oracleData: Record<string, unknown> = {
            blockedReason: oracle.blockedReason,
            decision: oracle.decision,
          };

          if (oracle.executed && oracle.prepare?.ok) {
            triggeredRepair = true;
            addCheck(
              "restore.prepare",
              "pass",
              restorePrepareStartedAt,
              oracle.prepare.snapshotId
                ? `Prepared fresh restore target ${oracle.prepare.snapshotId}.`
                : "Prepared fresh restore target.",
              oracleData,
            );
            meta = await deps.getMeta();
            status = failingRequirementIds.length > 0 ? "failed" : "repairing";
          } else if (oracle.executed) {
            const message =
              oracle.prepare?.actions.find((a) => a.status === "failed")?.message ??
              "Restore prepare failed.";
            addCheck("restore.prepare", "fail", restorePrepareStartedAt, message, oracleData);
            lastError = message;
            status = "failed";
          } else {
            const message =
              oracle.blockedReason === "already-ready"
                ? "Restore target already reusable."
                : `Skipped: ${oracle.blockedReason ?? "unknown"}.`;
            addCheck("restore.prepare", "skip", restorePrepareStartedAt, message, oracleData);
            status = failingRequirementIds.length > 0 ? "failed" : "ok";
          }
        } catch (oracleError) {
          const errMsg = oracleError instanceof Error ? oracleError.message : String(oracleError);
          addCheck("restore.prepare", "fail", restorePrepareStartedAt, `Oracle error: ${errMsg}`);
          lastError = errMsg;
          status = "failed";
        }
      } else {
        lastError =
          probe.error ??
          `Gateway probe failed (status=${probe.statusCode ?? "unknown"} markerFound=${probe.markerFound ?? false}).`;
        addCheck("probe", "fail", probeStartedAt, lastError);

        if (options.repair === false) {
          addCheck("reconcile", "skip", deps.now(), "Repair disabled for this run.");
          status = "failed";
        } else {
          const reconcileStartedAt = deps.now();
          const watchdogOp = createOperationContext({
            trigger: "watchdog",
            reason: "watchdog:probe_failed",
            sandboxId: meta.sandboxId,
            status: meta.status,
          });
          const reconciliation = await deps.reconcile({
            origin: getPublicOrigin(options.request),
            reason: "watchdog",
            schedule: options.schedule,
            op: watchdogOp,
          });

          triggeredRepair = reconciliation.repaired;

          if (reconciliation.status === "recovering" || reconciliation.repaired) {
            addCheck("reconcile", "pass", reconcileStartedAt, `Recovery scheduled from status ${meta.status}.`);
            status = failingRequirementIds.length > 0 ? "failed" : "repairing";
          } else {
            addCheck("reconcile", "fail", reconcileStartedAt,
              reconciliation.error ?? "Health reconciliation did not schedule recovery.");
            status = "failed";
          }
        }
      }
      } // close SDK stale-check else
    }

    // Cron wake: if sandbox is stopped or recoverable from an error snapshot and
    // OpenClaw has a cron job due, wake it. OpenClaw's native cron scheduler
    // handles everything once the sandbox is running.
    const cronCheckStartedAt = deps.now();
    if (
      (meta.status === "stopped" && meta.snapshotId) ||
      (meta.status === "error" && meta.snapshotId)
    ) {
      const cronNextWakeMs = await deps.getCronNextWakeMs();
      if (cronNextWakeMs && cronNextWakeMs <= deps.now()) {
        try {
          const origin = getPublicOrigin(options.request);
          const wakeMeta = await deps.ensureReady({ origin, reason: "watchdog:cron-wake" });

          const cronRestoreOutcome = wakeMeta.lastRestoreMetrics?.cronRestoreOutcome;
          const shouldClearWakeKey =
            cronRestoreOutcome !== undefined &&
            WATCHDOG_CRON_WAKE_CLEAR_OUTCOMES.has(cronRestoreOutcome);

          if (shouldClearWakeKey) {
            await deps.clearCronNextWake();
          } else {
            logWarn("watchdog.cron_wake_key_retained", {
              reason: cronRestoreOutcome
                ? "Cron restore outcome requires retry; retaining wake key"
                : "Cron restore outcome missing after wake; retaining wake key",
              cronRestoreOutcome: cronRestoreOutcome ?? "unknown",
            });
          }
          triggeredRepair = true;
          addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "pass", cronCheckStartedAt,
            shouldClearWakeKey
              ? `Cron job due — woke sandbox; cron restore outcome ${cronRestoreOutcome}.`
              : cronRestoreOutcome
                ? `Cron job due — woke sandbox but cron restore outcome ${cronRestoreOutcome}; wake key retained.`
                : "Cron job due — woke sandbox but cron restore outcome missing; wake key retained.");
          status = "repairing";
          meta = wakeMeta;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastError = `Cron wake failed: ${errMsg}`;
          addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "fail", cronCheckStartedAt, lastError);
          status = "failed";
        }
      } else {
        const msg = cronNextWakeMs
          ? `Next cron wake in ${Math.ceil((cronNextWakeMs - deps.now()) / 60000)} min.`
          : "No cron wake scheduled.";
        addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "skip", cronCheckStartedAt, msg);
      }
    } else {
      addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "skip", cronCheckStartedAt,
        `Sandbox is ${meta.status}; cron wake not needed.`);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logError("watchdog.run_failed", {
      error: lastError,
    });
    status = "failed";
  }

  const report: WatchdogReport = {
    deploymentId,
    ranAt: new Date(startedAt).toISOString(),
    status,
    sandboxStatus: meta.status,
    triggeredRepair,
    consecutiveFailures:
      status === "failed" ? previous.consecutiveFailures + 1 : 0,
    lastError,
    checks,
  };

  logInfo("watchdog.run_completed", {
    deploymentId,
    status,
    sandboxStatus: meta.status,
    triggeredRepair,
    consecutiveFailures: report.consecutiveFailures,
  });

  return deps.writeReport(report);
}
