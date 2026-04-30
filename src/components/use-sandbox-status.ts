"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusPayload } from "@/components/admin-types";

// ---------------------------------------------------------------------------
// Cadence policy (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Lifecycle states where the host is mid-transition. While the sandbox is in
 * one of these states the UI should poll quickly so the badge reflects the
 * authoritative server state without needing a manual refresh.
 *
 * `snapshotting` is the motivating case: the server reconciles it to
 * `stopped` once the SDK confirms the auto-snapshot completed, but until the
 * UI refetches it the badge stays stuck on "snapshotting" — which previously
 * made operators think the deploy was wedged.
 */
export const SANDBOX_TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
  "snapshotting",
  "creating",
  "setup",
  "restoring",
  "booting",
]);

export const FAST_POLL_INTERVAL_MS = 3_000;
export const SLOW_POLL_INTERVAL_MS = 30_000;

/**
 * Threshold past which we consider a snapshotting sandbox potentially wedged.
 *
 * The server's snapshotting reconciler has a 5 minute stale guardrail. Keep the
 * UI warning beyond that window so normal multi-minute platform snapshots do
 * not present as operator-actionable failures before the host has had a chance
 * to reconcile them.
 */
export const SNAPSHOTTING_WEDGE_THRESHOLD_MS = 6 * 60 * 1000;

export function isTransitionalStatus(status: string | null | undefined): boolean {
  return status != null && SANDBOX_TRANSITIONAL_STATES.has(status);
}

export function computePollIntervalMs(status: string | null | undefined): number {
  return isTransitionalStatus(status)
    ? FAST_POLL_INTERVAL_MS
    : SLOW_POLL_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

type UseSandboxStatusPollDeps = {
  /** Pulls a fresh /api/status payload. Already wired up in the parent. */
  refresh: () => Promise<void> | void;
  /** Current lifecycle status, used to pick cadence. */
  status: string | null | undefined;
  /** Whether the parent has any status at all (gates polling). */
  enabled: boolean;
};

type UseSandboxStatusPollResult = {
  /** True while we are in the fast-poll cadence (transitional or just-acted). */
  isFastPolling: boolean;
  /**
   * Call after a mutation (Stop / Start / Reset). Triggers an immediate
   * refresh and forces the next interval into fast-poll until the lifecycle
   * resolves into a settled state.
   */
  triggerImmediateRefresh: () => void;
};

/**
 * Adaptive poller for /api/status.
 *
 * - Polls every 3s while the lifecycle is in a transitional state, otherwise
 *   every 30s.
 * - Pauses entirely while the document is hidden, and refreshes once the
 *   moment it becomes visible again.
 * - Exposes `triggerImmediateRefresh` so action buttons can both fetch right
 *   away and force the fast cadence even before the next /api/status payload
 *   has returned the new transitional state.
 */
export function useSandboxStatusPoll({
  refresh,
  status,
  enabled,
}: UseSandboxStatusPollDeps): UseSandboxStatusPollResult {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Sticky "we just kicked an action" flag — keeps us in fast-poll until the
  // next status update either confirms the transitional state (then policy
  // takes over) or shows the settled result.
  const [forceFast, setForceFast] = useState(false);

  const transitional = isTransitionalStatus(status);
  // Once the status is settled and we are not forcing fast-poll, drop the flag.
  useEffect(() => {
    if (!transitional && forceFast) {
      // Wait for at least one settled status update before dropping fast-poll.
      setForceFast(false);
    }
  }, [transitional, forceFast]);

  const isFastPolling = transitional || forceFast;

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      try {
        await refreshRef.current();
      } catch {
        /* ignore — same as existing refreshStatus pattern */
      }
      if (cancelled) return;
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      const intervalMs = isFastPolling
        ? FAST_POLL_INTERVAL_MS
        : SLOW_POLL_INTERVAL_MS;
      timer = setTimeout(tick, intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tick();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, isFastPolling]);

  const triggerImmediateRefresh = useCallback(() => {
    setForceFast(true);
    void Promise.resolve(refreshRef.current()).catch(() => {
      /* ignore */
    });
  }, []);

  return { isFastPolling, triggerImmediateRefresh };
}

// ---------------------------------------------------------------------------
// Wedge tracking (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Track when the UI first observed `snapshotting`, so we can surface a wedge
 * banner if the state lingers beyond `SNAPSHOTTING_WEDGE_THRESHOLD_MS`.
 */
export function useSnapshottingFirstSeenMs(
  status: string | null | undefined,
): number | null {
  const ref = useRef<number | null>(null);
  // Mirror into state so the banner re-renders when the threshold is crossed.
  const [firstSeen, setFirstSeen] = useState<number | null>(null);

  useEffect(() => {
    if (status === "snapshotting") {
      if (ref.current == null) {
        const now = Date.now();
        ref.current = now;
        setFirstSeen(now);
      }
    } else {
      if (ref.current != null) {
        ref.current = null;
        setFirstSeen(null);
      }
    }
  }, [status]);

  return firstSeen;
}

export function isSnapshottingWedged(
  status: string | null | undefined,
  firstSeenMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (status !== "snapshotting") return false;
  if (firstSeenMs == null) return false;
  return nowMs - firstSeenMs >= SNAPSHOTTING_WEDGE_THRESHOLD_MS;
}

export type SandboxStatusForPolling = Pick<StatusPayload, "status">;
