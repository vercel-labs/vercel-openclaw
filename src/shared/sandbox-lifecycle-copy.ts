import type { SingleStatus } from "@/shared/types";

const LIFECYCLE_PROGRESS_LABELS: Partial<Record<SingleStatus, string>> = {
  creating: "Creating sandbox…",
  setup: "Installing OpenClaw…",
  restoring: "Restoring snapshot…",
  booting: "Waiting for gateway…",
  snapshotting: "Finishing snapshot…",
};

const FIRST_RUN_CALLOUT = {
  headline: "Create your sandbox",
  body: [
    "This first start creates a new sandbox and installs OpenClaw. It can take a minute the first time.",
    "After that, future starts are much faster because the sandbox restores from snapshots.",
  ],
} as const;

export function getLifecycleActionLabel(
  status: SingleStatus,
  hasSnapshot: boolean,
): string {
  switch (status) {
    case "uninitialized":
      return "Create Sandbox";
    case "stopped":
      return "Start Sandbox";
    case "running":
      return "Open Gateway";
    case "error":
      return hasSnapshot ? "Restore Sandbox" : "Create Fresh Sandbox";
    default:
      return "Open Gateway";
  }
}

export function getLifecycleProgressLabel(status: SingleStatus): string | null {
  return LIFECYCLE_PROGRESS_LABELS[status] ?? null;
}

export function getLifecycleProgressDetail(
  status: SingleStatus,
  isFirstRun: boolean,
): string | null {
  if (status === "setup" && isFirstRun) {
    return "This is the longest step on the first run.";
  }

  if (status === "restoring") {
    return "Bringing back the last saved state.";
  }

  return null;
}

export function getFirstRunCallout(): { headline: string; body: string[] } {
  return {
    headline: FIRST_RUN_CALLOUT.headline,
    body: [...FIRST_RUN_CALLOUT.body],
  };
}
