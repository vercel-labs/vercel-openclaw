/**
 * Configurable sandbox sleep-after timeout.
 *
 * Reads `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` from the environment and derives
 * heartbeat and touch-throttle intervals proportionally. Invalid or missing
 * values fall back to sensible defaults.
 */
import { logInfo } from "@/server/log";

export const DEFAULT_SANDBOX_SLEEP_AFTER_MS = 30 * 60 * 1000; // 30 min
export const MIN_SANDBOX_SLEEP_AFTER_MS = 60_000; // 1 min
export const MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS = 45 * 60 * 1000; // 45 min

const DEFAULT_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 min
const MIN_HEARTBEAT_INTERVAL_MS = 15_000;
const MIN_TOUCH_THROTTLE_MS = 5_000;
const MAX_TOUCH_THROTTLE_MS = 30_000;

export type SandboxSleepConfig = {
  sleepAfterMs: number;
  heartbeatIntervalMs: number;
  touchThrottleMs: number;
};

let cachedRaw: string | undefined;
let cachedConfig: SandboxSleepConfig | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function estimateSandboxTimeoutRemainingMs(
  lastAccessedAt: number | null,
  sleepAfterMs: number,
  now = Date.now(),
): number | null {
  if (lastAccessedAt === null) {
    return null;
  }
  return Math.max(0, sleepAfterMs - (now - lastAccessedAt));
}

export function getSandboxSleepConfig(): SandboxSleepConfig {
  const raw = process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
  if (cachedConfig && raw === cachedRaw) {
    return cachedConfig;
  }

  const parsed = parsePositiveInteger(raw);
  const sleepAfterMs =
    parsed === null
      ? DEFAULT_SANDBOX_SLEEP_AFTER_MS
      : clamp(
          parsed,
          MIN_SANDBOX_SLEEP_AFTER_MS,
          MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS,
        );

  cachedRaw = raw;
  cachedConfig = {
    sleepAfterMs,
    heartbeatIntervalMs: Math.min(
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(sleepAfterMs / 2)),
    ),
    touchThrottleMs: Math.min(
      MAX_TOUCH_THROTTLE_MS,
      Math.max(MIN_TOUCH_THROTTLE_MS, Math.floor(sleepAfterMs / 4)),
    ),
  };

  logInfo("sandbox.sleep_after_resolved", {
    raw: raw ?? null,
    ...cachedConfig,
  });

  return cachedConfig;
}

export function getSandboxSleepAfterMs(): number {
  return getSandboxSleepConfig().sleepAfterMs;
}

export function getSandboxHeartbeatIntervalMs(): number {
  return getSandboxSleepConfig().heartbeatIntervalMs;
}

export function getSandboxTouchThrottleMs(): number {
  return getSandboxSleepConfig().touchThrottleMs;
}

export function _resetSandboxSleepConfigCacheForTesting(): void {
  cachedRaw = undefined;
  cachedConfig = null;
}
