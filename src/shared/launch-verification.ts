import type { ChannelName } from "@/shared/channels";
import type { RestorePreparedStatus, RestorePreparedReason } from "@/shared/types";

// ---------------------------------------------------------------------------
// Restore target attestation — canonical machine-readable restore contract
// ---------------------------------------------------------------------------

export type RestoreTargetAttestation = {
  desiredDynamicConfigHash: string;
  desiredAssetSha256: string;
  snapshotDynamicConfigHash: string | null;
  runtimeDynamicConfigHash: string | null;
  snapshotAssetSha256: string | null;
  runtimeAssetSha256: string | null;
  restorePreparedStatus: RestorePreparedStatus;
  restorePreparedReason: string | null;
  restorePreparedAt: number | null;
  runtimeConfigFresh: boolean | null;
  snapshotConfigFresh: boolean | null;
  runtimeAssetsFresh: boolean | null;
  snapshotAssetsFresh: boolean | null;
  reusable: boolean;
  needsPrepare: boolean;
  reasons: string[];
};

// ---------------------------------------------------------------------------
// Restore oracle — deterministic plan from attestation + sandbox state
// ---------------------------------------------------------------------------

export type RestoreTargetPlanAction = {
  id: "ensure-running" | "prepare-destructive";
  priority: "required" | "recommended";
  title: string;
  description: string;
  request: {
    method: "GET" | "POST";
    path: string;
    body: Record<string, unknown> | null;
  };
};

export type RestoreTargetPlan = {
  schemaVersion: 1;
  status: "ready" | "needs-prepare";
  blocking: boolean;
  reasons: string[];
  actions: RestoreTargetPlanAction[];
};

export type RestoreTargetInspectionPayload = {
  ok: boolean;
  generatedAt: string;
  attestation: RestoreTargetAttestation;
  preview: {
    ok: boolean;
    destructive: boolean;
    state: RestorePreparedStatus;
    reason: RestorePreparedReason | null;
    snapshotId: string | null;
    snapshotDynamicConfigHash: string | null;
    runtimeDynamicConfigHash: string | null;
    snapshotAssetSha256: string | null;
    runtimeAssetSha256: string | null;
    preparedAt: number | null;
    actions: Array<{
      id:
        | "ensure-running"
        | "reconcile-dynamic-config"
        | "sync-static-assets"
        | "verify-ready"
        | "snapshot"
        | "stamp-meta";
      status: "completed" | "skipped" | "failed";
      message: string;
    }>;
  };
  plan: RestoreTargetPlan;
};

// ---------------------------------------------------------------------------
// Launch verification types
// ---------------------------------------------------------------------------

export type LaunchVerificationPhaseId =
  | "preflight"
  | "queuePing"
  | "ensureRunning"
  | "chatCompletions"
  | "wakeFromSleep"
  | "restorePrepared";

export type LaunchVerificationPhaseStatus = "pass" | "fail" | "skip" | "running";

export type LaunchVerificationPhaseCode =
  | "phase.pass"
  | "phase.fail"
  | "phase.skip"
  | "restorePrepared.already-reusable"
  | "restorePrepared.prepared"
  | "restorePrepared.blocked"
  | "restorePrepared.prepare-failed"
  | "restorePrepared.not-reusable-after-prepare";

export type RestorePreparedPhaseResolutionCode =
  | "already-reusable"
  | "prepared"
  | "blocked"
  | "prepare-failed"
  | "not-reusable-after-prepare";

export type RestorePreparedPhaseEvidence = {
  kind: "restorePrepared";
  resolution: RestorePreparedPhaseResolution;
  blockedReason: string | null;
  initialAttestation: RestoreTargetAttestation;
  finalAttestation: RestoreTargetAttestation;
  plan: RestoreTargetPlan;
  prepare: RestorePreparedPhaseResolutionInput["prepare"];
};

export type LaunchVerificationPhaseDetails = RestorePreparedPhaseEvidence;

export type LaunchVerificationPhase = {
  id: LaunchVerificationPhaseId;
  status: LaunchVerificationPhaseStatus;
  durationMs: number;
  message: string;
  error?: string;
  code?: LaunchVerificationPhaseCode;
  details?: LaunchVerificationPhaseDetails;
};

export type LaunchVerificationRuntime = {
  packageSpec: string;
  installedVersion: string | null;
  drift: boolean;
  expectedConfigHash: string | null;
  lastRestoreConfigHash: string | null;
  dynamicConfigVerified: boolean | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  restorePreparedStatus: RestorePreparedStatus;
  restorePreparedReason: RestorePreparedReason | null;
  snapshotDynamicConfigHash: string | null;
  runtimeDynamicConfigHash: string | null;
  snapshotAssetSha256: string | null;
  runtimeAssetSha256: string | null;
  restoreAttestation?: RestoreTargetAttestation;
  restorePlan?: RestoreTargetPlan;
};

export type LaunchVerificationSandboxHealth = {
  repaired: boolean;
  configReconciled?: boolean | null;
  configReconcileReason?:
    | "already-fresh"
    | "rewritten-and-restarted"
    | "rewrite-failed"
    | "restart-failed"
    | "sandbox-unavailable"
    | "error"
    | "skipped";
};

export type LaunchVerificationDiagnostics = {
  blocking: boolean;
  failingCheckIds: string[];
  requiredActionIds: string[];
  recommendedActionIds: string[];
  /**
   * Deprecated compatibility field.
   * Historically named "warningChannelIds" even though it contains channels
   * whose prerequisite status is fail.
   */
  warningChannelIds: ChannelName[];
  /**
   * Correct name for the same data. Prefer this field in new code.
   */
  failingChannelIds?: ChannelName[];
  skipPhaseIds: LaunchVerificationPhaseId[];
};

export type LaunchVerificationPayload = {
  ok: boolean;
  mode: "safe" | "destructive";
  startedAt: string;
  completedAt: string;
  phases: LaunchVerificationPhase[];
  diagnostics?: LaunchVerificationDiagnostics;
  runtime?: LaunchVerificationRuntime;
  sandboxHealth?: LaunchVerificationSandboxHealth;
};

export type ChannelReadiness = {
  deploymentId: string;
  ready: boolean;
  verifiedAt: string | null;
  mode: "safe" | "destructive" | null;
  wakeFromSleepPassed: boolean;
  failingPhaseId: LaunchVerificationPhaseId | null;
  phases: LaunchVerificationPhase[];
};

// ---------------------------------------------------------------------------
// NDJSON stream event types
// ---------------------------------------------------------------------------

export type LaunchVerificationPhaseEvent = {
  type: "phase";
  phase: LaunchVerificationPhase;
  seq: number;
  final: boolean;
};

export type LaunchVerificationSummaryEvent = {
  type: "summary";
  payload: LaunchVerificationDiagnostics;
};

export type LaunchVerificationResultEvent = {
  type: "result";
  payload: LaunchVerificationPayload & { channelReadiness?: ChannelReadiness };
};

export type LaunchVerificationStreamEvent =
  | LaunchVerificationPhaseEvent
  | LaunchVerificationSummaryEvent
  | LaunchVerificationResultEvent;

// ---------------------------------------------------------------------------
// Completion log shape — used by both JSON and NDJSON terminal log lines
// ---------------------------------------------------------------------------

export type LaunchVerifyCompletionLog = {
  ok: boolean;
  mode: "safe" | "destructive";
  phaseCount: number;
  totalMs: number;
  channelReady: boolean;
  failingCheckIds: string[];
  requiredActionIds: string[];
  recommendedActionIds: string[];
  failingChannelIds: ChannelName[];
  dynamicConfigVerified: boolean | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  repaired: boolean | null;
  configReconciled: boolean | null;
  configReconcileReason?: string;
  restoreReusable: boolean | null;
  restoreNeedsPrepare: boolean | null;
  restoreReasonIds: string[];
  restorePlanActionIds: string[];
};

// ---------------------------------------------------------------------------
// Restore seal resolution — pure function for restorePrepared phase verdict
// ---------------------------------------------------------------------------

export type RestorePreparedPhaseResolutionInput = {
  blockedReason: string | null;
  initialAttestation: RestoreTargetAttestation;
  finalAttestation: RestoreTargetAttestation;
  prepare: {
    ok: boolean;
    snapshotId: string | null;
    actions: Array<{
      status: "completed" | "skipped" | "failed";
      message: string;
    }>;
  } | null;
};

export type RestorePreparedPhaseResolution = {
  ok: boolean;
  code: RestorePreparedPhaseResolutionCode;
  message: string;
};

function formatRestorePreparedBlockedMessage(blockedReason: string): string {
  switch (blockedReason) {
    case "already-ready":
      return "Restore target already reusable.";
    case "already-running":
      return "Restore oracle already running in another worker.";
    case "sandbox-not-running":
      return "Sandbox is not running; destructive prepare skipped.";
    case "sandbox-recently-active":
      return "Sandbox was recently active; destructive prepare skipped.";
    case "gateway-not-ready":
      return "Gateway is not healthy enough to seal a fresh restore target.";
    default:
      return `Restore prepare blocked: ${blockedReason}.`;
  }
}

export function resolveRestorePreparedPhase(
  input: RestorePreparedPhaseResolutionInput,
): RestorePreparedPhaseResolution {
  if (input.initialAttestation.reusable) {
    return {
      ok: true,
      code: "already-reusable",
      message: "Restore target already reusable.",
    };
  }

  if (input.finalAttestation.reusable) {
    return {
      ok: true,
      code: "prepared",
      message:
        input.prepare?.snapshotId != null
          ? `Prepared fresh restore target ${input.prepare.snapshotId}.`
          : "Prepared fresh restore target.",
    };
  }

  if (input.prepare && !input.prepare.ok) {
    const failedAction = input.prepare.actions.find(
      (action) => action.status === "failed",
    );
    return {
      ok: false,
      code: "prepare-failed",
      message: failedAction?.message ?? "Restore preparation failed.",
    };
  }

  if (input.blockedReason) {
    return {
      ok: false,
      code: "blocked",
      message: formatRestorePreparedBlockedMessage(input.blockedReason),
    };
  }

  return {
    ok: false,
    code: "not-reusable-after-prepare",
    message: "Restore target is still not reusable after destructive prepare.",
  };
}

export type RestorePreparedPhaseEvidenceInput =
  RestorePreparedPhaseResolutionInput & {
    plan: RestoreTargetPlan;
  };

export function buildRestorePreparedPhaseEvidence(
  input: RestorePreparedPhaseEvidenceInput,
): RestorePreparedPhaseEvidence {
  return {
    kind: "restorePrepared",
    resolution: resolveRestorePreparedPhase(input),
    blockedReason: input.blockedReason,
    initialAttestation: input.initialAttestation,
    finalAttestation: input.finalAttestation,
    plan: input.plan,
    prepare: input.prepare,
  };
}

const REQUIRED_PHASE_IDS: LaunchVerificationPhaseId[] = [
  "preflight",
  "queuePing",
  "ensureRunning",
  "chatCompletions",
  "wakeFromSleep",
];

export function isChannelReady(payload: LaunchVerificationPayload): boolean {
  if (payload.mode !== "destructive") return false;
  const phaseMap = new Map(payload.phases.map((p) => [p.id, p.status]));
  return REQUIRED_PHASE_IDS.every((id) => phaseMap.get(id) === "pass");
}
