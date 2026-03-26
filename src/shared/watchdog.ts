import type { SingleMeta } from "@/shared/types";

export type WatchdogCheckId = "contract" | "probe" | "reconcile" | "cron.wake" | "restore.prepare";
export type WatchdogCheckStatus = "pass" | "fail" | "skip";
export type WatchdogStatus = "idle" | "ok" | "repairing" | "failed";

export type WatchdogCheck = {
  id: WatchdogCheckId;
  status: WatchdogCheckStatus;
  durationMs: number;
  message: string;
  data?: Record<string, unknown>;
};

export type WatchdogReport = {
  deploymentId: string;
  ranAt: string | null;
  status: WatchdogStatus;
  sandboxStatus: SingleMeta["status"];
  triggeredRepair: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  checks: WatchdogCheck[];
};
