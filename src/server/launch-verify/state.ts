import { createHash } from "node:crypto";

import { logInfo } from "@/server/log";
import { getStore } from "@/server/store/store";
import { launchVerifyReadinessKey } from "@/server/store/keyspace";
import type {
  ChannelReadiness,
  LaunchVerificationPayload,
} from "@/shared/launch-verification";
import { isChannelReady } from "@/shared/launch-verification";

export function getCurrentDeploymentId(): string {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (deploymentId) return deploymentId;

  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (commitSha) return commitSha;

  // Deterministic local fallback based on working directory + node version
  return `local-${createHash("sha256").update(`${process.cwd()}:${process.version}`).digest("hex").slice(0, 12)}`;
}

function defaultReadiness(deploymentId: string): ChannelReadiness {
  return {
    deploymentId,
    ready: false,
    verifiedAt: null,
    mode: null,
    wakeFromSleepPassed: false,
    failingPhaseId: null,
    phases: [],
  };
}

let _readinessOverrideForTesting: ChannelReadiness | null | undefined;

export function _setChannelReadinessOverrideForTesting(
  override: ChannelReadiness | null,
): void {
  _readinessOverrideForTesting = override ?? undefined;
}

export async function readChannelReadiness(): Promise<ChannelReadiness> {
  if (_readinessOverrideForTesting !== undefined) {
    return _readinessOverrideForTesting ?? defaultReadiness(getCurrentDeploymentId());
  }
  const currentId = getCurrentDeploymentId();
  const stored = await getStore().getValue<ChannelReadiness>(launchVerifyReadinessKey());

  if (!stored || stored.deploymentId !== currentId) {
    logInfo("launch_verify.readiness_miss", {
      reason: stored ? "deployment_changed" : "no_stored_readiness",
      currentDeploymentId: currentId,
      storedDeploymentId: stored?.deploymentId ?? null,
    });
    return defaultReadiness(currentId);
  }

  return stored;
}

export async function writeChannelReadiness(
  payload: LaunchVerificationPayload,
): Promise<ChannelReadiness> {
  const deploymentId = getCurrentDeploymentId();
  const ready = isChannelReady(payload);
  const wakePhase = payload.phases.find((p) => p.id === "wakeFromSleep");
  const firstFailing = payload.phases.find((p) => p.status === "fail");

  const readiness: ChannelReadiness = {
    deploymentId,
    ready,
    verifiedAt: payload.completedAt,
    mode: payload.mode,
    wakeFromSleepPassed: wakePhase?.status === "pass",
    failingPhaseId: firstFailing?.id ?? null,
    phases: payload.phases,
  };

  await getStore().setValue(launchVerifyReadinessKey(), readiness);

  logInfo("launch_verify.readiness_written", {
    deploymentId,
    ready,
    mode: payload.mode,
    wakeFromSleepPassed: readiness.wakeFromSleepPassed,
    failingPhaseId: readiness.failingPhaseId,
  });

  return readiness;
}
