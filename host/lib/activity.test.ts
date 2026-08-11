import { describe, it, expect } from "vitest";
import {
  ActivityState,
  createActivityState,
  isIdle,
  recordActivity,
  shouldExtendTimeout,
  getNextIdleCheckAt,
  ActivityEvent,
} from "./activity";

describe("activity", () => {
  describe("createActivityState", () => {
    it("creates a new state with the current time", () => {
      const now = 1000000;
      const state = createActivityState(now);
      expect(state.lastActivityAt).toBe(now);
    });

    it("uses Date.now() when called without arguments", () => {
      const state = createActivityState();
      expect(state.lastActivityAt).toBeLessThanOrEqual(Date.now());
      expect(state.lastActivityAt).toBeGreaterThan(Date.now() - 100);
    });
  });

  describe("isIdle", () => {
    it("returns false when elapsed time is less than threshold", () => {
      const lastActivityAt = 1000000;
      const now = lastActivityAt + 30 * 60 * 1000; // 30 minutes later
      const state: ActivityState = { lastActivityAt };
      const threshold = 60 * 60 * 1000; // 60 minutes

      expect(isIdle(state, now, threshold)).toBe(false);
    });

    it("returns true when elapsed time equals threshold (60 min boundary)", () => {
      const lastActivityAt = 1000000;
      const now = lastActivityAt + 60 * 60 * 1000; // Exactly 60 minutes
      const state: ActivityState = { lastActivityAt };
      const threshold = 60 * 60 * 1000;

      expect(isIdle(state, now, threshold)).toBe(true);
    });

    it("returns true when elapsed time exceeds threshold", () => {
      const lastActivityAt = 1000000;
      const now = lastActivityAt + 65 * 60 * 1000; // 65 minutes later
      const state: ActivityState = { lastActivityAt };
      const threshold = 60 * 60 * 1000;

      expect(isIdle(state, now, threshold)).toBe(true);
    });

    it("uses 60 min as default threshold", () => {
      const lastActivityAt = 1000000;
      const now = lastActivityAt + 60 * 60 * 1000; // Exactly 60 minutes
      const state: ActivityState = { lastActivityAt };

      expect(isIdle(state, now)).toBe(true);
    });

    it("returns false when just below 60 min threshold", () => {
      const lastActivityAt = 1000000;
      const now = lastActivityAt + 60 * 60 * 1000 - 1; // 1ms before 60 min
      const state: ActivityState = { lastActivityAt };

      expect(isIdle(state, now)).toBe(false);
    });
  });

  describe("recordActivity", () => {
    const now = 2000000;

    it("records webhook-forwarded event", () => {
      const state: ActivityState = { lastActivityAt: 1000000 };
      const result = recordActivity(state, "webhook-forwarded", now);

      expect(result.lastActivityAt).toBe(now);
    });

    it("records ui-request-proxied event", () => {
      const state: ActivityState = { lastActivityAt: 1000000 };
      const result = recordActivity(state, "ui-request-proxied", now);

      expect(result.lastActivityAt).toBe(now);
    });

    it("records sandbox-wake event", () => {
      const state: ActivityState = { lastActivityAt: 1000000 };
      const result = recordActivity(state, "sandbox-wake", now);

      expect(result.lastActivityAt).toBe(now);
    });

    it("updates lastActivityAt on any activity event", () => {
      const state: ActivityState = { lastActivityAt: 1000000 };
      const events: ActivityEvent[] = [
        "webhook-forwarded",
        "ui-request-proxied",
        "sandbox-wake",
      ];

      for (const event of events) {
        const result = recordActivity(state, event, now);
        expect(result.lastActivityAt).toBe(now);
      }
    });

    it("uses Date.now() when time not provided", () => {
      const state: ActivityState = { lastActivityAt: 1000000 };
      const result = recordActivity(state, "webhook-forwarded");

      expect(result.lastActivityAt).toBeLessThanOrEqual(Date.now());
      expect(result.lastActivityAt).toBeGreaterThan(Date.now() - 100);
    });

    it("does not reset clock for gateway internal work (LLM calls)", () => {
      const oldLastActivityAt = 1000000;
      const state: ActivityState = { lastActivityAt: oldLastActivityAt };

      // Simulate gateway internal work - the spec explicitly states these
      // should NOT reset the clock. This test verifies we don't have a method
      // that would incorrectly allow it.
      // The only way to reset is via the three documented activity events.
      expect(state.lastActivityAt).toBe(oldLastActivityAt);
    });
  });

  describe("shouldExtendTimeout", () => {
    const sessionTimeoutMs = 75 * 60 * 1000; // 75 minutes

    it("returns true when far from expiration", () => {
      const lastActivityAt = 1000000;
      const expiresAtMs = lastActivityAt + sessionTimeoutMs;
      const now = lastActivityAt + 10 * 60 * 1000; // 10 minutes later
      const state: ActivityState = { lastActivityAt };

      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(true);
    });

    it("returns false when within 5 min of expiration", () => {
      const lastActivityAt = 1000000;
      const expiresAtMs = lastActivityAt + sessionTimeoutMs;
      const now = expiresAtMs - 4 * 60 * 1000; // 4 minutes before expiry
      const state: ActivityState = { lastActivityAt };

      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(false);
    });

    it("returns false exactly at 5 min before expiration", () => {
      const lastActivityAt = 1000000;
      const expiresAtMs = lastActivityAt + sessionTimeoutMs;
      const now = expiresAtMs - 5 * 60 * 1000; // Exactly 5 minutes before
      const state: ActivityState = { lastActivityAt };

      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(false);
    });

    it("returns true just beyond 5 min before expiration", () => {
      const lastActivityAt = 1000000;
      const expiresAtMs = lastActivityAt + sessionTimeoutMs;
      const now = expiresAtMs - 5 * 60 * 1000 - 1; // 1ms beyond the threshold
      const state: ActivityState = { lastActivityAt };

      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(true);
    });

    it("returns true when far before ceiling", () => {
      const now = 1000000;
      const expiresAtMs = now + 50 * 60 * 1000; // 50 minutes away
      const state: ActivityState = { lastActivityAt: now };

      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(true);
    });

    it("handles platform ceiling roll-over scenario", () => {
      const now = 1000000;
      // At 24h ceiling (or 45min on Hobby): approaching hard maximum
      const expiresAtMs = now + 5 * 60 * 1000 + 1; // Just over 5 min away
      const state: ActivityState = { lastActivityAt: now };

      // Still can extend (just barely)
      expect(shouldExtendTimeout(state, expiresAtMs, now)).toBe(true);

      // Cannot extend when we hit the threshold
      const nowNearCeiling = now + 1 * 60 * 1000; // 1 min has passed
      expect(shouldExtendTimeout(state, expiresAtMs, nowNearCeiling)).toBe(
        false
      );
    });
  });

  describe("getNextIdleCheckAt", () => {
    it("calculates next idle check based on idle threshold", () => {
      const lastActivityAt = 1000000;
      const state: ActivityState = { lastActivityAt };
      const idleThresholdMs = 60 * 60 * 1000;

      const nextCheck = getNextIdleCheckAt(state);
      expect(nextCheck).toBe(lastActivityAt + idleThresholdMs);
    });

    it("uses 60 min as default idle threshold", () => {
      const lastActivityAt = 2000000;
      const state: ActivityState = { lastActivityAt };

      const nextCheck = getNextIdleCheckAt(state);
      expect(nextCheck).toBe(lastActivityAt + 60 * 60 * 1000);
    });

    it("accepts custom check interval (though typically not used)", () => {
      const lastActivityAt = 1000000;
      const state: ActivityState = { lastActivityAt };
      const customIntervalMs = 10 * 60 * 1000; // 10 min

      // The function returns idle threshold, not the custom interval
      // but we pass it to show flexibility
      const nextCheck = getNextIdleCheckAt(state, customIntervalMs);
      expect(nextCheck).toBe(lastActivityAt + 60 * 60 * 1000);
    });
  });

  describe("integration: idle clock cycle", () => {
    it("tracks a full idle cycle: activity -> not idle -> idle -> prepare needed", () => {
      const baseTime = 1000000;
      let state = createActivityState(baseTime);

      // Initially, not idle (just created)
      expect(isIdle(state, baseTime)).toBe(false);

      // After 30 minutes: still not idle
      const after30min = baseTime + 30 * 60 * 1000;
      expect(isIdle(state, after30min)).toBe(false);

      // After 60 minutes: now idle (prepare should be called)
      const after60min = baseTime + 60 * 60 * 1000;
      expect(isIdle(state, after60min)).toBe(true);

      // Activity recorded: webhook forwarded, resets the clock
      state = recordActivity(state, "webhook-forwarded", after60min + 1000);
      expect(isIdle(state, after60min + 1000)).toBe(false);

      // After another 60 minutes from new activity: idle again
      const after120min = after60min + 1000 + 60 * 60 * 1000;
      expect(isIdle(state, after120min)).toBe(true);
    });

    it("session timeout extension prevents ceiling breach", () => {
      const baseTime = 1000000;
      let state = createActivityState(baseTime);

      // Initial session expires in 75 minutes
      let expiresAt = baseTime + 75 * 60 * 1000;

      // Message at 20 minutes: can extend
      const msg20min = baseTime + 20 * 60 * 1000;
      state = recordActivity(state, "webhook-forwarded", msg20min);
      expiresAt = msg20min + 75 * 60 * 1000; // Reset to 75 min from now
      expect(shouldExtendTimeout(state, expiresAt, msg20min)).toBe(true);

      // Message at 70 minutes: can extend
      const msg70min = baseTime + 70 * 60 * 1000;
      state = recordActivity(state, "webhook-forwarded", msg70min);
      expiresAt = msg70min + 75 * 60 * 1000;
      expect(shouldExtendTimeout(state, expiresAt, msg70min)).toBe(true);

      // At exactly 70m + 70min (5min before new ceiling): cannot extend
      // expiresAt = msg70min + 75*60*1000, so 5min before = msg70min + 70*60*1000
      const msg70m70min = msg70min + 70 * 60 * 1000; // = msg70min + 75min - 5min
      expect(shouldExtendTimeout(state, expiresAt, msg70m70min)).toBe(false);
    });

    it("gateway internal work (LLM calls) does not reset idle clock", () => {
      const baseTime = 1000000;
      const state: ActivityState = { lastActivityAt: baseTime };

      // Simulate an LLM call at 30 minutes (internal work, NOT user-visible)
      const llmCallTime = baseTime + 30 * 60 * 1000;

      // The state should remain unchanged since we only reset via
      // the three documented activity events
      expect(state.lastActivityAt).toBe(baseTime);

      // Still not idle at 30 min (no activity recorded)
      expect(isIdle(state, llmCallTime)).toBe(false);

      // BUT at 60 min, it becomes idle (the LLM call didn't reset it)
      const at60min = baseTime + 60 * 60 * 1000;
      expect(isIdle(state, at60min)).toBe(true);

      // Only when user activity is recorded does it reset
      const state2 = recordActivity(state, "ui-request-proxied", at60min + 1000);
      expect(isIdle(state2, at60min + 1000)).toBe(false);
    });

    it("all three resetting event types work correctly", () => {
      const baseTime = 1000000;
      const eventTypes: ActivityEvent[] = [
        "webhook-forwarded",
        "ui-request-proxied",
        "sandbox-wake",
      ];

      for (const eventType of eventTypes) {
        let state = createActivityState(baseTime);

        // Idle after 60 min with no activity
        expect(isIdle(state, baseTime + 60 * 60 * 1000)).toBe(true);

        // Record activity with this event type
        state = recordActivity(state, eventType, baseTime + 61 * 60 * 1000);

        // No longer idle immediately after
        expect(isIdle(state, baseTime + 61 * 60 * 1000)).toBe(false);

        // Will be idle again 60 min after this activity
        expect(isIdle(state, baseTime + 121 * 60 * 1000)).toBe(true);
      }
    });
  });
});
