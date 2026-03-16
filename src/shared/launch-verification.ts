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
};

export type LaunchVerificationSandboxHealth = {
  repaired: boolean;
};

export type LaunchVerificationPayload = {
  ok: boolean;
  mode: "safe" | "destructive";
  startedAt: string;
  completedAt: string;
  phases: LaunchVerificationPhase[];
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
