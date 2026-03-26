import { logInfo, logWarn } from "@/server/log";
import type {
  PrepareRestoreResult,
  ProbeResult,
} from "@/server/sandbox/lifecycle";
import {
  buildRestoreDecision,
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import type { RestoreDecision } from "@/shared/restore-decision";
import type { RestoreTargetAttestation } from "@/shared/launch-verification";
import type { RestoreTargetPlan } from "@/shared/launch-verification";
import type {
  OperationContext,
  RestorePreparedReason,
  SingleMeta,
} from "@/shared/types";

const DEFAULT_RESTORE_ORACLE_MIN_IDLE_MS = 5 * 60_000;

export type RestoreOracleBlockedReason =
  | "already-ready"
  | "already-running"
  | "sandbox-not-running"
  | "sandbox-recently-active"
  | "gateway-not-ready";

export type RestoreOracleCycleResult = {
  executed: boolean;
  blockedReason: RestoreOracleBlockedReason | null;
  idleMs: number | null;
  minIdleMs: number;
  attestation: RestoreTargetAttestation;
  plan: RestoreTargetPlan;
  prepare: PrepareRestoreResult | null;
  decision: RestoreDecision;
};

export type RestoreOracleDeps = {
  getMeta: () => Promise<SingleMeta>;
  mutate: (
    mutator: (meta: SingleMeta) => SingleMeta | void,
  ) => Promise<SingleMeta>;
  probe: (options?: { timeoutMs?: number }) => Promise<ProbeResult>;
  prepare: (input: {
    origin: string;
    reason: string;
    destructive?: boolean;
    op?: OperationContext;
  }) => Promise<PrepareRestoreResult>;
  now: () => number;
};

function toIdleMs(lastAccessedAt: number | null, now: number): number | null {
  return typeof lastAccessedAt === "number"
    ? Math.max(0, now - lastAccessedAt)
    : null;
}

function blockedMessage(
  reason: RestoreOracleBlockedReason,
  idleMs: number | null,
  minIdleMs: number,
): string {
  switch (reason) {
    case "already-ready":
      return "Restore target already reusable.";
    case "already-running":
      return "Restore oracle already running in another worker.";
    case "sandbox-not-running":
      return "Sandbox is not running; destructive prepare skipped.";
    case "sandbox-recently-active":
      return `Sandbox was active ${idleMs ?? 0}ms ago; need at least ${minIdleMs}ms of idle time.`;
    case "gateway-not-ready":
      return "Gateway is not healthy enough to seal a fresh restore target.";
  }
}

async function markOracleBlocked(
  deps: RestoreOracleDeps,
  message: string,
  now: number,
): Promise<void> {
  await deps.mutate((meta) => {
    if (meta.restoreOracle.status !== "running") {
      meta.restoreOracle.status = "blocked";
    }
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastBlockedReason = message;
    meta.restoreOracle.lastResult = "blocked";
  });
}

async function markOracleReady(
  deps: RestoreOracleDeps,
  now: number,
  lastResult: "already-ready" | "prepared",
): Promise<void> {
  await deps.mutate((meta) => {
    meta.restoreOracle.status = "ready";
    meta.restoreOracle.pendingReason = null;
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastBlockedReason = null;
    meta.restoreOracle.lastError = null;
    meta.restoreOracle.consecutiveFailures = 0;
    meta.restoreOracle.lastResult = lastResult;
  });
}

async function markOracleFailed(
  deps: RestoreOracleDeps,
  now: number,
  errorMessage: string,
): Promise<void> {
  await deps.mutate((meta) => {
    meta.restoreOracle.status = "failed";
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastError = errorMessage;
    meta.restoreOracle.lastResult = "failed";
    meta.restoreOracle.consecutiveFailures =
      (meta.restoreOracle.consecutiveFailures ?? 0) + 1;
  });
}

async function beginOracleRun(
  deps: RestoreOracleDeps,
  now: number,
  pendingReason: RestorePreparedReason | null,
): Promise<void> {
  await deps.mutate((meta) => {
    if (meta.restoreOracle.status === "running") {
      throw new Error("RESTORE_ORACLE_ALREADY_RUNNING");
    }
    meta.restoreOracle.status = "running";
    meta.restoreOracle.pendingReason = pendingReason;
    meta.restoreOracle.lastStartedAt = now;
    meta.restoreOracle.lastBlockedReason = null;
    meta.restoreOracle.lastError = null;
  });
}

export async function runRestoreOracleCycle(
  input: {
    origin: string;
    reason: string;
    force?: boolean;
    minIdleMs?: number;
    op?: OperationContext;
  },
  deps: RestoreOracleDeps,
): Promise<RestoreOracleCycleResult> {
  const now = deps.now();
  const minIdleMs = input.minIdleMs ?? DEFAULT_RESTORE_ORACLE_MIN_IDLE_MS;
  const meta = await deps.getMeta();
  const attestation = buildRestoreTargetAttestation(meta);
  const plan = buildRestoreTargetPlan({
    attestation,
    status: meta.status,
    sandboxId: meta.sandboxId,
  });
  const idleMs = toIdleMs(meta.lastAccessedAt, now);

  /** Build a decision snapshot with the oracle-specific context known so far. */
  const makeDecision = (opts?: {
    meta?: SingleMeta;
    probeReady?: boolean | null;
  }): RestoreDecision =>
    buildRestoreDecision({
      meta: opts?.meta ?? meta,
      source: "oracle",
      destructive: true,
      idleMs: toIdleMs((opts?.meta ?? meta).lastAccessedAt, now),
      minIdleMs,
      probeReady: opts?.probeReady ?? null,
    });

  await deps.mutate((next) => {
    next.restoreOracle.lastEvaluatedAt = now;
  });

  logInfo("sandbox.restore_oracle.cycle_evaluated", {
    reason: input.reason,
    force: input.force ?? false,
    idleMs,
    minIdleMs,
    reusable: attestation.reusable,
    oracleStatus: meta.restoreOracle.status,
    sandboxStatus: meta.status,
  });

  if (attestation.reusable) {
    await markOracleReady(deps, now, "already-ready");
    const updatedMeta = await deps.getMeta();
    const decision = makeDecision({ meta: updatedMeta });
    logInfo("sandbox.restore_oracle.already_ready", {
      reason: input.reason,
    });
    logDecision(decision);
    return {
      executed: false,
      blockedReason: "already-ready",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
      decision,
    };
  }

  if (meta.restoreOracle.status === "running") {
    const decision = makeDecision();
    const message = blockedMessage("already-running", idleMs, minIdleMs);
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "already-running",
      message,
    });
    logDecision(decision);
    return {
      executed: false,
      blockedReason: "already-running",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
      decision,
    };
  }

  if (meta.status !== "running" || !meta.sandboxId) {
    const message = blockedMessage("sandbox-not-running", idleMs, minIdleMs);
    await markOracleBlocked(deps, message, now);
    const updatedMeta = await deps.getMeta();
    const decision = makeDecision({ meta: updatedMeta });
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "sandbox-not-running",
      sandboxStatus: meta.status,
      message,
    });
    logDecision(decision);
    return {
      executed: false,
      blockedReason: "sandbox-not-running",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
      decision,
    };
  }

  if (!input.force && idleMs !== null && idleMs < minIdleMs) {
    const message = blockedMessage(
      "sandbox-recently-active",
      idleMs,
      minIdleMs,
    );
    await markOracleBlocked(deps, message, now);
    const updatedMeta = await deps.getMeta();
    const decision = makeDecision({ meta: updatedMeta });
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "sandbox-recently-active",
      idleMs,
      minIdleMs,
      message,
    });
    logDecision(decision);
    return {
      executed: false,
      blockedReason: "sandbox-recently-active",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
      decision,
    };
  }

  const probe = await deps.probe();
  if (!probe.ready) {
    const message =
      probe.error ?? blockedMessage("gateway-not-ready", idleMs, minIdleMs);
    await markOracleBlocked(deps, message, now);
    const updatedMeta = await deps.getMeta();
    const decision = makeDecision({ meta: updatedMeta, probeReady: false });
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "gateway-not-ready",
      probeError: probe.error ?? null,
      message,
    });
    logDecision(decision);
    return {
      executed: false,
      blockedReason: "gateway-not-ready",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
      decision,
    };
  }

  try {
    await beginOracleRun(deps, now, meta.restorePreparedReason);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RESTORE_ORACLE_ALREADY_RUNNING"
    ) {
      const decision = makeDecision({ probeReady: true });
      logInfo("sandbox.restore_oracle.blocked", {
        reason: "already-running",
        message: "Lost CAS race for oracle lock.",
      });
      logDecision(decision);
      return {
        executed: false,
        blockedReason: "already-running",
        idleMs,
        minIdleMs,
        attestation,
        plan,
        prepare: null,
        decision,
      };
    }
    throw error;
  }

  logInfo("sandbox.restore_oracle.run_started", {
    reason: input.reason,
    force: input.force ?? false,
    idleMs,
    minIdleMs,
    attestationReasons: attestation.reasons,
    restorePreparedStatus: meta.restorePreparedStatus,
    restorePreparedReason: meta.restorePreparedReason,
  });

  try {
    const prepare = await deps.prepare({
      origin: input.origin,
      reason: input.reason,
      destructive: true,
      op: input.op,
    });

    if (!prepare.ok) {
      const errorMessage = `prepare failed: ${prepare.reason ?? "unknown"}`;
      await markOracleFailed(deps, deps.now(), errorMessage);
      const updatedMeta = await deps.getMeta();
      const decision = makeDecision({ meta: updatedMeta, probeReady: true });
      logWarn("sandbox.restore_oracle.run_failed", {
        error: errorMessage,
        state: prepare.state,
        snapshotId: prepare.snapshotId,
      });
      logDecision(decision);
      return {
        executed: true,
        blockedReason: null,
        idleMs,
        minIdleMs,
        attestation,
        plan,
        prepare,
        decision,
      };
    }

    await markOracleReady(deps, deps.now(), "prepared");
    const updatedMeta = await deps.getMeta();
    const decision = makeDecision({ meta: updatedMeta, probeReady: true });
    logInfo("sandbox.restore_oracle.run_completed", {
      snapshotId: prepare.snapshotId,
      state: prepare.state,
      reason: prepare.reason,
    });
    logDecision(decision);

    return {
      executed: true,
      blockedReason: null,
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare,
      decision,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markOracleFailed(deps, deps.now(), errorMessage);
    logWarn("sandbox.restore_oracle.run_threw", { error: errorMessage });
    throw error;
  }
}

function logDecision(decision: RestoreDecision): void {
  logInfo("sandbox.restore.decision", {
    source: decision.source,
    destructive: decision.destructive,
    reusable: decision.reusable,
    needsPrepare: decision.needsPrepare,
    blocking: decision.blocking,
    reasons: decision.reasons,
    requiredActions: decision.requiredActions,
    nextAction: decision.nextAction,
    status: decision.status,
    sandboxId: decision.sandboxId,
    snapshotId: decision.snapshotId,
    idleMs: decision.idleMs,
    minIdleMs: decision.minIdleMs,
    probeReady: decision.probeReady,
  });
}
