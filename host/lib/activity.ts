/**
 * The idle clock, per docs/suspension-spec.md "Activity definition".
 *
 * lastActivityAt is reset by host-VISIBLE events only:
 * - a webhook the host forwards (any channel)
 * - a UI request the host proxies (WebChat/Control UI)
 * - any sandbox wake (message, cron, manual)
 *
 * Deliberately NOT counted: the gateway's own outbound work (LLM calls
 * mid-task). The idle timer only initiates; the gateway.suspend.prepare
 * handshake is the correctness gate that protects running work.
 *
 * The webhook route writes timestamps to the shared ActivityStore; the cron
 * reads the latest and gates on isIdle. Session-timeout top-ups are computed
 * directly from sandbox.expiresAt in the webhook route (extendTimeout adds
 * duration rather than resetting, so the route extends by the shortfall).
 */

export interface ActivityState {
  /** Timestamp (ms) of the last host-visible event that reset the clock */
  lastActivityAt: number;
}

export const IDLE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * True once the time elapsed since the last host-visible activity reaches
 * the threshold (60 minutes per spec).
 */
export function isIdle(
  state: ActivityState,
  now: number,
  thresholdMs: number = IDLE_THRESHOLD_MS,
): boolean {
  return now - state.lastActivityAt >= thresholdMs;
}
