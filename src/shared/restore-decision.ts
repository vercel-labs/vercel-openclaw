import type {
  RestoreOracleStatus,
  RestorePreparedReason,
  RestorePreparedStatus,
  SingleStatus,
} from "@/shared/types";

export type RestoreDecisionAction = "ensure-running" | "prepare-destructive";

export type RestoreDecisionReason =
  | "snapshot-missing"
  | "runtime-config-stale"
  | "runtime-assets-stale"
  | "snapshot-config-stale"
  | "snapshot-config-unknown"
  | "snapshot-assets-stale"
  | "snapshot-assets-unknown"
  | `restore-target-${RestorePreparedStatus}`
  | "sandbox-not-running"
  | "sandbox-recently-active"
  | "gateway-not-ready"
  | "already-running"
  | "already-ready";

export type RestoreDecision = {
  schemaVersion: 1;
  source: "inspect" | "prepare" | "oracle" | "watchdog";
  destructive: boolean;
  reusable: boolean;
  needsPrepare: boolean;
  blocking: boolean;
  reasons: RestoreDecisionReason[];
  requiredActions: RestoreDecisionAction[];
  nextAction: RestoreDecisionAction | null;
  status: SingleStatus;
  sandboxId: string | null;
  snapshotId: string | null;
  restorePreparedStatus: RestorePreparedStatus;
  restorePreparedReason: RestorePreparedReason | null;
  oracleStatus: RestoreOracleStatus | null;
  idleMs: number | null;
  minIdleMs: number | null;
  probeReady: boolean | null;
  desiredDynamicConfigHash: string;
  snapshotDynamicConfigHash: string | null;
  runtimeDynamicConfigHash: string | null;
  desiredAssetSha256: string;
  snapshotAssetSha256: string | null;
  runtimeAssetSha256: string | null;
};
