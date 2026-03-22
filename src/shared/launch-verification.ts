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
};

export type LaunchVerificationDiagnostics = {
  blocking: boolean;
  failingCheckIds: string[];
  requiredActionIds: string[];
  recommendedActionIds: string[];
  warningChannelIds: Array<"slack" | "telegram" | "discord">;
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
