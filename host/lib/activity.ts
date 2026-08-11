/**
 * Idle clock implementation for OpenClaw host activity tracking.
 *
 * Tracks user-visible activity to determine when the sandbox is idle
 * and eligible for suspension. Activity is reset by:
 * - Forwarded webhooks (any channel)
 * - Proxied UI requests (WebChat/Control UI)
 * - Any sandbox wake (message, cron, manual)
 *
 * Deliberately excluded: gateway's own outbound work (LLM calls).
 * The idle timer only initiates suspend; the prepare handshake gates correctness.
 */

export interface ActivityState {
  /** Timestamp (ms) of the last host-visible event that reset the clock */
  lastActivityAt: number;
}

/**
 * Create a new activity state initialized to the current time.
 * Useful for first boot or when initializing the host.
 */
export function createActivityState(now: number = Date.now()): ActivityState {
  return {
    lastActivityAt: now,
  };
}

/**
 * Check if the gateway is idle.
 *
 * The gateway is considered idle when the time elapsed since the last
 * activity exceeds the threshold.
 *
 * @param state Current activity state
 * @param now Current time in milliseconds
 * @param thresholdMs Idle threshold (default: 60 minutes)
 * @returns true if idle (now - lastActivityAt >= thresholdMs)
 */
export function isIdle(
  state: ActivityState,
  now: number,
  thresholdMs: number = 60 * 60 * 1000
): boolean {
  return now - state.lastActivityAt >= thresholdMs;
}

/**
 * Types of events that reset the activity clock.
 */
export type ActivityEvent =
  | "webhook-forwarded" // Host forwards a webhook from any channel
  | "ui-request-proxied" // Host proxies a UI request (WebChat/Control)
  | "sandbox-wake"; // Any sandbox wake (message, cron, manual)

/**
 * Record a user-visible event that resets the activity clock.
 *
 * Only certain events reset the clock. Gateway internal work (e.g., LLM calls)
 * is intentionally NOT recorded here; the prepare handshake gates correctness.
 *
 * @param state Current activity state
 * @param event Type of activity event
 * @param now Current time in milliseconds (default: Date.now())
 * @returns Updated activity state
 */
export function recordActivity(
  _state: ActivityState,
  _event: ActivityEvent,
  now: number = Date.now()
): ActivityState {
  return {
    lastActivityAt: now,
  };
}

/**
 * Determine whether to extend the platform session timeout.
 *
 * The session ceiling is 75 minutes from last extension. Every forwarded message
 * should trigger an extension to reset the platform timeout back to 75 minutes.
 * When we reach ~5 min before the session expires (i.e., expiresAt - 5min),
 * no further extensions are possible.
 *
 * This function is called on every message that resets activity. If we're
 * approaching the hard ceiling and cannot extend further, prepare will be
 * called immediately to gracefully suspend (or forced stop if prepare is busy).
 *
 * @param state Current activity state
 * @param expiresAtMs Platform session expiration time (ms)
 * @param now Current time in milliseconds
 * @returns true if the timeout should be extended; false if we're at the ceiling
 */
export function shouldExtendTimeout(
  _state: ActivityState,
  expiresAtMs: number,
  now: number
): boolean {
  // Cannot extend if we're within 5 minutes of expiration
  const noExtensionThresholdMs = 5 * 60 * 1000;
  return expiresAtMs - now > noExtensionThresholdMs;
}

/**
 * Calculate when the sandbox becomes eligible for idle suspension.
 *
 * @param state Current activity state
 * @param idleThresholdMs Idle threshold (default: 60 minutes, per spec)
 * @returns Timestamp (ms) at which isIdle() starts returning true
 */
export function getNextIdleCheckAt(
  state: ActivityState,
  idleThresholdMs: number = 60 * 60 * 1000
): number {
  // The earliest moment the sandbox can become idle-eligible. The cron polls
  // every 5 minutes, so the actual suspend attempt lands within one interval
  // after this.
  return state.lastActivityAt + idleThresholdMs;
}
