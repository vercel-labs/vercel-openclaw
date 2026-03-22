export type LaunchVerificationPhaseId =
  | "preflight"
  | "queuePing"
  | "ensureRunning"
  | "chatCompletions"
  | "wakeFromSleep";

export type LaunchVerificationPhaseStatus = "pass" | "fail" | "skip" | "running";

export type LaunchVerificationPhase = {
  id: LaunchVerificationPhaseId;
  status: LaunchVerificationPhaseStatus;
  durationMs: number;
  message: string;
  error?: string;
};

export type LaunchVerificationRuntime = {
  packageSpec: string;
  installedVersion: string | null;
  drift: boolean;
  expectedConfigHash: string | null;
  lastRestoreConfigHash: string | null;
  dynamicConfigVerified: boolean | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
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
  warningChannelIds: Array<"slack" | "telegram" | "discord">;
  /**
   * Correct name for the same data. Prefer this field in new code.
   */
  failingChannelIds?: Array<"slack" | "telegram" | "discord">;
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
  failingChannelIds: Array<"slack" | "telegram" | "discord">;
  dynamicConfigVerified: boolean | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  repaired: boolean | null;
  configReconciled: boolean | null;
  configReconcileReason?: string;
};

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
