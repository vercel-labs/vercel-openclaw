/**
 * Hot-spare sandbox prototype — feature-flagged, disabled by default.
 *
 * When enabled via `OPENCLAW_HOT_SPARE_ENABLED=true`, the system tracks a
 * pre-created "candidate" sandbox alongside the active one.  On wake, the
 * candidate can be promoted to active, skipping the Vercel Sandbox create/resume
 * latency entirely.
 *
 * All behavior is gated behind `isHotSpareEnabled()`.  When the flag is off,
 * every function in this module is a no-op that returns null or a benign default.
 */

import { logInfo, logWarn, logError } from "@/server/log";
import type { SingleMeta } from "@/shared/types";
import { createDefaultHotSpareState } from "@/shared/types";
import type { SandboxHandle } from "@/server/sandbox/controller";

// Re-export types for convenience.
export type { HotSpareStatus, HotSpareState } from "@/shared/types";
export { createDefaultHotSpareState, ensureHotSpareState } from "@/shared/types";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isHotSpareEnabled(): boolean {
  return process.env.OPENCLAW_HOT_SPARE_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Pre-creation
// ---------------------------------------------------------------------------

export type PreCreateResult = {
  status: "created" | "skipped" | "failed";
  candidateSandboxId: string | null;
  error: string | null;
};

/**
 * Pre-create a hot-spare sandbox candidate from the active sandbox's snapshot.
 *
 * This is a no-op when the feature flag is off or a candidate already exists.
 * Intended to be called after a successful stop (when an auto-snapshot exists).
 */
export async function preCreateHotSpare(
  meta: SingleMeta,
  deps: {
    create: (options: {
      name: string;
      persistent: boolean;
      ports: number[];
      timeout: number;
      resources: { vcpus: number };
    }) => Promise<SandboxHandle>;
    getSandboxVcpus: () => number;
    getSandboxSleepAfterMs: () => number;
    sandboxPorts: number[];
  },
): Promise<PreCreateResult> {
  if (!isHotSpareEnabled()) {
    return { status: "skipped", candidateSandboxId: null, error: null };
  }

  const hotSpare = meta.hotSpare ?? createDefaultHotSpareState();

  // Don't create a new candidate if one already exists or is being created.
  if (
    hotSpare.status === "ready" ||
    hotSpare.status === "creating"
  ) {
    logInfo("hot_spare.pre_create.skipped", {
      reason: `already_${hotSpare.status}`,
      candidateSandboxId: hotSpare.candidateSandboxId,
    });
    return {
      status: "skipped",
      candidateSandboxId: hotSpare.candidateSandboxId,
      error: null,
    };
  }

  // Need an active sandbox to derive the candidate name.
  if (!meta.sandboxId) {
    logInfo("hot_spare.pre_create.skipped", { reason: "no_active_sandbox" });
    return { status: "skipped", candidateSandboxId: null, error: null };
  }

  const candidateName = `oc-spare-${meta.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;

  logInfo("hot_spare.pre_create.start", {
    activeSandboxId: meta.sandboxId,
    candidateName,
  });

  try {
    const sandbox = await deps.create({
      name: candidateName,
      persistent: true,
      ports: deps.sandboxPorts,
      timeout: deps.getSandboxSleepAfterMs(),
      resources: { vcpus: deps.getSandboxVcpus() },
    });

    logInfo("hot_spare.pre_create.complete", {
      candidateSandboxId: sandbox.sandboxId,
    });

    return {
      status: "created",
      candidateSandboxId: sandbox.sandboxId,
      error: null,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logError("hot_spare.pre_create.failed", { error: errMsg });
    return {
      status: "failed",
      candidateSandboxId: null,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export type PromoteResult = {
  status: "promoted" | "skipped" | "failed";
  promotedSandboxId: string | null;
  error: string | null;
};

/**
 * Attempt to promote the hot-spare candidate to become the active sandbox.
 *
 * Returns `{ status: "skipped" }` when the flag is off or no candidate is ready.
 * On failure, falls back cleanly — the caller should proceed with the normal
 * restore path.
 */
export async function promoteHotSpare(
  meta: SingleMeta,
  deps: {
    get: (options: { sandboxId: string }) => Promise<SandboxHandle>;
  },
): Promise<PromoteResult> {
  if (!isHotSpareEnabled()) {
    return { status: "skipped", promotedSandboxId: null, error: null };
  }

  const hotSpare = meta.hotSpare ?? createDefaultHotSpareState();

  if (hotSpare.status !== "ready" || !hotSpare.candidateSandboxId) {
    logInfo("hot_spare.promote.skipped", {
      reason: hotSpare.status === "ready" ? "no_candidate_id" : `status_${hotSpare.status}`,
    });
    return { status: "skipped", promotedSandboxId: null, error: null };
  }

  logInfo("hot_spare.promote.start", {
    candidateSandboxId: hotSpare.candidateSandboxId,
  });

  try {
    // Verify the candidate sandbox is still accessible (auto-resumes on get).
    const sandbox = await deps.get({
      sandboxId: hotSpare.candidateSandboxId,
    });

    logInfo("hot_spare.promote.complete", {
      promotedSandboxId: sandbox.sandboxId,
      sandboxStatus: sandbox.status,
    });

    return {
      status: "promoted",
      promotedSandboxId: sandbox.sandboxId,
      error: null,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logWarn("hot_spare.promote.failed", {
      candidateSandboxId: hotSpare.candidateSandboxId,
      error: errMsg,
    });
    return {
      status: "failed",
      promotedSandboxId: null,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export type CleanupResult = {
  status: "cleaned" | "skipped" | "failed";
  error: string | null;
};

/**
 * Destroy the hot-spare candidate sandbox without affecting the active sandbox.
 *
 * Called when the candidate is no longer needed (e.g. after successful promotion
 * of a different sandbox, or when cleaning up after a failed pre-creation).
 */
export async function cleanupHotSpare(
  meta: SingleMeta,
  deps: {
    get: (options: { sandboxId: string }) => Promise<SandboxHandle>;
  },
): Promise<CleanupResult> {
  if (!isHotSpareEnabled()) {
    return { status: "skipped", error: null };
  }

  const hotSpare = meta.hotSpare ?? createDefaultHotSpareState();

  if (!hotSpare.candidateSandboxId) {
    return { status: "skipped", error: null };
  }

  logInfo("hot_spare.cleanup.start", {
    candidateSandboxId: hotSpare.candidateSandboxId,
  });

  try {
    const sandbox = await deps.get({
      sandboxId: hotSpare.candidateSandboxId,
    });
    await sandbox.stop({ blocking: true });

    logInfo("hot_spare.cleanup.complete", {
      candidateSandboxId: hotSpare.candidateSandboxId,
    });

    return { status: "cleaned", error: null };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Treat "not found" as already cleaned — not an error.
    if (errMsg.includes("404") || errMsg.includes("not found")) {
      logInfo("hot_spare.cleanup.already_gone", {
        candidateSandboxId: hotSpare.candidateSandboxId,
      });
      return { status: "cleaned", error: null };
    }
    logWarn("hot_spare.cleanup.failed", {
      candidateSandboxId: hotSpare.candidateSandboxId,
      error: errMsg,
    });
    return { status: "failed", error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Metadata mutation helpers
// ---------------------------------------------------------------------------

/**
 * Apply a pre-creation result to the mutable metadata.
 * Caller is responsible for wrapping this in `mutateMeta()`.
 */
export function applyPreCreateToMeta(
  meta: SingleMeta,
  result: PreCreateResult,
): void {
  if (!meta.hotSpare) {
    meta.hotSpare = createDefaultHotSpareState();
  }
  const now = Date.now();

  switch (result.status) {
    case "created":
      meta.hotSpare.status = "ready";
      meta.hotSpare.candidateSandboxId = result.candidateSandboxId;
      meta.hotSpare.createdAt = now;
      meta.hotSpare.lastError = null;
      meta.hotSpare.updatedAt = now;
      break;
    case "failed":
      meta.hotSpare.status = "failed";
      meta.hotSpare.lastError = result.error;
      meta.hotSpare.updatedAt = now;
      break;
    case "skipped":
      // No state change needed.
      break;
  }
}

/**
 * Apply a promotion result to the mutable metadata.
 * Caller is responsible for wrapping this in `mutateMeta()`.
 */
export function applyPromoteToMeta(
  meta: SingleMeta,
  result: PromoteResult,
): void {
  if (!meta.hotSpare) {
    meta.hotSpare = createDefaultHotSpareState();
  }
  const now = Date.now();

  switch (result.status) {
    case "promoted":
      // Promoted sandbox becomes the new active — clear candidate slot.
      meta.hotSpare.status = "idle";
      meta.hotSpare.candidateSandboxId = null;
      meta.hotSpare.candidatePortUrls = null;
      meta.hotSpare.createdAt = null;
      meta.hotSpare.lastError = null;
      meta.hotSpare.updatedAt = now;
      break;
    case "failed":
      // Promotion failed — mark so we don't retry immediately.
      meta.hotSpare.status = "failed";
      meta.hotSpare.lastError = result.error;
      meta.hotSpare.updatedAt = now;
      break;
    case "skipped":
      break;
  }
}

/**
 * Clear the hot-spare state entirely (e.g. after cleanup).
 * Caller is responsible for wrapping this in `mutateMeta()`.
 */
export function clearHotSpareState(meta: SingleMeta): void {
  meta.hotSpare = createDefaultHotSpareState();
}
