import { describe, it, expect } from 'vitest';
import { isIdle, IDLE_THRESHOLD_MS, type ActivityState } from './activity';

const BASE = 1_700_000_000_000;
const MIN = 60 * 1000;

describe('isIdle', () => {
  const state: ActivityState = { lastActivityAt: BASE };

  it('is not idle immediately after activity', () => {
    expect(isIdle(state, BASE)).toBe(false);
  });

  it('is not idle one millisecond before the threshold', () => {
    expect(isIdle(state, BASE + IDLE_THRESHOLD_MS - 1)).toBe(false);
  });

  it('is idle exactly at the threshold (>= semantics)', () => {
    expect(isIdle(state, BASE + IDLE_THRESHOLD_MS)).toBe(true);
  });

  it('is idle after the threshold', () => {
    expect(isIdle(state, BASE + 2 * IDLE_THRESHOLD_MS)).toBe(true);
  });

  it('defaults to the spec threshold of 60 minutes', () => {
    expect(IDLE_THRESHOLD_MS).toBe(60 * MIN);
  });

  it('accepts a custom threshold', () => {
    expect(isIdle(state, BASE + 10 * MIN, 10 * MIN)).toBe(true);
    expect(isIdle(state, BASE + 9 * MIN, 10 * MIN)).toBe(false);
  });

  it('gateway-internal work does not reset the clock (only store writes do)', () => {
    // An LLM call at +30 min writes nothing to the store, so the same
    // lastActivityAt crosses the threshold at +60 min regardless.
    expect(isIdle(state, BASE + 30 * MIN)).toBe(false);
    expect(isIdle(state, BASE + 60 * MIN)).toBe(true);
  });

  it('fresh activity restarts the window (a new state, not a mutation)', () => {
    const rearmed: ActivityState = { lastActivityAt: BASE + 55 * MIN };
    expect(isIdle(rearmed, BASE + 60 * MIN)).toBe(false);
    expect(isIdle(rearmed, BASE + 115 * MIN)).toBe(true);
  });
});
