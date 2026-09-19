import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdleClock } from '../runtime/idle-policy.mjs';

test('45 minutes means inactivity since the last useful work, not age of the VM', () => {
  let now = 0;
  const clock = new IdleClock({ now: () => now, hardDeadlineMs: 24 * 60 * 60_000 });
  now = 45 * 60_000 - 1;
  assert.equal(clock.reason(), undefined);
  clock.touch();
  now += 45 * 60_000 - 1;
  assert.equal(clock.reason(), undefined);
  now++;
  assert.equal(clock.reason(), 'idle');
});

test('active work cannot idle out and completion starts a full new idle interval', () => {
  let now = 0;
  const clock = new IdleClock({ now: () => now, hardDeadlineMs: 24 * 60 * 60_000 });
  clock.begin();
  now += 60 * 60_000;
  assert.equal(clock.reason(), undefined);
  clock.end();
  assert.equal(clock.reason(), undefined);
  now += 45 * 60_000;
  assert.equal(clock.reason(), 'idle');
});

test('inspection does not reset idle, and platform deadlines remain independent', () => {
  let now = 0;
  const clock = new IdleClock({ now: () => now, hardDeadlineMs: 45 * 60_000 });
  clock.begin();
  now = 42 * 60_000;
  clock.touch();
  assert.equal(clock.reason(), 'deadline');
  assert.equal(clock.snapshot().lastActivityAt, now);
  now++;
  assert.equal(clock.snapshot().lastActivityAt, now - 1);
});

test('a fresh process clock starts on wake and invalid bounds fail closed', () => {
  const clock = new IdleClock({ now: () => 5_000_000, hardDeadlineMs: 8_000_000 });
  assert.equal(clock.reason(), undefined);
  assert.throws(() => new IdleClock({ hardDeadlineMs: NaN }));
  assert.throws(() => new IdleClock({ hardDeadlineMs: Date.now() + 1, idleTimeoutMs: -1 }));
});

test('late admission leaves the complete bounded turn plus shutdown reserve before the hard cap', () => {
  let now = 0;
  const clock = new IdleClock({ now: () => now, hardDeadlineMs: 2700000 });
  now = 2700000 - 235000 - 180000 - 1;
  assert.equal(clock.canStartTurn(), true);
  now++;
  assert.equal(clock.canStartTurn(), false);
  clock.touch();
  assert.equal(clock.canStartTurn(), false);
});
