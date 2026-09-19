import assert from 'node:assert/strict';

export const IDLE_TIMEOUT_MS = 45 * 60_000;
export const SHUTDOWN_RESERVE_MS = 3 * 60_000;
export const MAX_TURN_MS = 235_000;
export const TURN_ADMISSION_RESERVE_MS = MAX_TURN_MS + SHUTDOWN_RESERVE_MS;

export class IdleClock {
  constructor({ now = Date.now, hardDeadlineMs, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
    assert(Number.isFinite(hardDeadlineMs), 'Platform session deadline required');
    assert(Number.isSafeInteger(idleTimeoutMs) && idleTimeoutMs > 0 && idleTimeoutMs <= IDLE_TIMEOUT_MS, 'Invalid idle timeout');
    this.now = now;
    this.hardDeadlineMs = hardDeadlineMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.lastActivityAt = now();
    this.active = 0;
  }
  touch() { this.lastActivityAt = this.now(); }
  begin() { this.active++; this.touch(); }
  end() { assert(this.active > 0, 'Unbalanced activity'); this.active--; this.touch(); }
  reason() {
    if (this.now() >= this.hardDeadlineMs - SHUTDOWN_RESERVE_MS) return 'deadline';
    if (this.active === 0 && this.now() - this.lastActivityAt >= this.idleTimeoutMs) return 'idle';
  }
  snapshot() { return { lastActivityAt: this.lastActivityAt, active: this.active, idleTimeoutMs: this.idleTimeoutMs, hardDeadlineMs: this.hardDeadlineMs }; }
  canStartTurn() { return this.hardDeadlineMs - this.now() > TURN_ADMISSION_RESERVE_MS; }
}
