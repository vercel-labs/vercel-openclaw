import {
  buildDeploymentContract,
  type DeploymentContract,
} from "@/server/deployment-contract";
import { getCurrentDeploymentId } from "@/server/launch-verify/state";
import { logError, logInfo } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  probeGatewayReady,
  reconcileSandboxHealth,
  type ProbeResult,
  type SandboxHealthResult,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";
import type { SingleMeta } from "@/shared/types";
import type { WatchdogCheck, WatchdogReport } from "@/shared/watchdog";
import {
  readWatchdogReport,
  writeWatchdogReport,
} from "@/server/watchdog/state";

export type RunSandboxWatchdogOptions = {
  request: Request;
  repair?: boolean;
};

export type WatchdogDeps = {
  buildContract: (options: { request?: Request }) => Promise<DeploymentContract>;
  getMeta: () => Promise<SingleMeta>;
  probe: () => Promise<ProbeResult>;
  reconcile: (options: {
    origin: string;
    reason: string;
  }) => Promise<SandboxHealthResult>;
  readPrevious: () => Promise<WatchdogReport>;
  writeReport: (report: WatchdogReport) => Promise<WatchdogReport>;
  now: () => number;
};

const defaultDeps: WatchdogDeps = {
  buildContract: buildDeploymentContract,
  getMeta: getInitializedMeta,
  probe: probeGatewayReady,
  reconcile: reconcileSandboxHealth,
  readPrevious: readWatchdogReport,
  writeReport: writeWatchdogReport,
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
  ): void => {
    checks.push({
      id,
      status,
      durationMs: Math.max(0, deps.now() - stepStartedAt),
      message,
    });
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

    // Only probe running sandboxes — do not wake intentionally stopped ones
    if (meta.status !== "running" || !meta.sandboxId) {
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
      const probeStartedAt = deps.now();
      const probe = await deps.probe();

      if (probe.ready) {
        addCheck(
          "probe",
          "pass",
          probeStartedAt,
          "Gateway probe returned the openclaw-app marker.",
        );
        addCheck(
          "reconcile",
          "skip",
          deps.now(),
          "Probe passed; no repair scheduled.",
        );
        status = failingRequirementIds.length > 0 ? "failed" : "ok";
      } else {
        lastError =
          probe.error ??
          `Gateway probe failed (status=${probe.statusCode ?? "unknown"} markerFound=${probe.markerFound ?? false}).`;
        addCheck("probe", "fail", probeStartedAt, lastError);

        if (options.repair === false) {
          addCheck(
            "reconcile",
            "skip",
            deps.now(),
            "Repair disabled for this run.",
          );
          status = "failed";
        } else {
          const reconcileStartedAt = deps.now();
          const reconciliation = await deps.reconcile({
            origin: getPublicOrigin(options.request),
            reason: "watchdog",
          });

          triggeredRepair = reconciliation.repaired;

          if (reconciliation.status === "recovering" || reconciliation.repaired) {
            addCheck(
              "reconcile",
              "pass",
              reconcileStartedAt,
              `Recovery scheduled from status ${meta.status}.`,
            );
            status = failingRequirementIds.length > 0 ? "failed" : "repairing";
          } else {
            addCheck(
              "reconcile",
              "fail",
              reconcileStartedAt,
              reconciliation.error ??
                "Health reconciliation did not schedule recovery.",
            );
            status = "failed";
          }
        }
      }
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
