import test from 'node:test';
import assert from 'node:assert/strict';
import { signIdle, verifyIdle, idleDeadline, extendForIdle, WarmSlack, stopIdle } from '../dist/slack-warm.js';
import { SlackRun } from '../dist/slack-native.js';
import { PermanentSlackError } from '../dist/slack-auth.js';

const secret = 'warm-test-signing-key-'.repeat(3);
const namespace = 'prj_warm_test';
const minute = 60_000;
const createdAt = Date.parse('2026-09-29T00:00:00.000Z');
const event = Object.freeze({
  kind: 'slack-idle-v1',
  agent: `slack-${'a'.repeat(32)}`,
  generation: '12345678-1234-4123-8123-123456789abc',
  dueAt: createdAt + 60 * minute,
});

test('signed idle callbacks survive queue JSON serialization without changing the input', () => {
  const signed = signIdle(event, namespace, secret);
  assert.notEqual(signed, event);
  assert.equal(Object.hasOwn(event, 'signature'), false);
  assert.match(signed.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual(signed, signIdle(event, namespace, secret));
  assert.doesNotThrow(() => verifyIdle(JSON.parse(JSON.stringify(signed)), namespace, secret));
});

test('idle signature is bound to the deployment namespace and signing key', () => {
  const signed = signIdle(event, namespace, secret);
  assert.throws(() => verifyIdle(signed, 'prj_other', secret), PermanentSlackError);
  assert.throws(() => verifyIdle(signed, namespace, 'other-test-signing-key-'.repeat(3)), PermanentSlackError);
  assert.notEqual(signIdle(event, 'prj_other', secret).signature, signed.signature);
});

test('generation, dueAt, agent and kind tampering cannot reuse an idle signature', () => {
  const signed = signIdle(event, namespace, secret);
  for (const [field, value] of [
    ['generation', '87654321-4321-4321-8321-cba987654321'],
    ['dueAt', event.dueAt + 1],
    ['agent', `slack-${'b'.repeat(32)}`],
    ['kind', 'slack-idle-v2'],
  ]) {
    assert.throws(() => verifyIdle({ ...signed, [field]: value }, namespace, secret),
      PermanentSlackError, field);
  }
});

test('missing, malformed and mismatched signatures are permanent callback failures', () => {
  const signed = signIdle(event, namespace, secret);
  const different = (signed.signature[0] === 'a' ? 'b' : 'a') + signed.signature.slice(1);
  for (const signature of [undefined, null, '', '0'.repeat(63), 'g'.repeat(64), different]) {
    assert.throws(() => verifyIdle({ ...signed, signature }, namespace, secret), PermanentSlackError);
  }
  for (const invalid of [null, undefined, {}]) {
    assert.throws(() => verifyIdle(invalid, namespace, secret), PermanentSlackError);
  }
});

test('even correctly signed callbacks must have a valid agent, generation and positive safe dueAt', () => {
  for (const patch of [
    { agent: 'not-a-slack-agent' }, { generation: 'not-a-generation' },
    { dueAt: 0 }, { dueAt: -1 }, { dueAt: event.dueAt + 0.5 },
    { dueAt: String(event.dueAt) }, { dueAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const signed = signIdle({ ...event, ...patch }, namespace, secret);
    assert.throws(() => verifyIdle(signed, namespace, secret), PermanentSlackError);
  }
});

test('signing refuses an absent or short signing key', () => {
  for (const key of [undefined, '', 'x'.repeat(31)]) {
    assert.throws(() => signIdle(event, namespace, key), /signing key is not configured/);
  }
  assert.doesNotThrow(() => verifyIdle(signIdle(event, namespace, 'x'.repeat(32)), namespace, 'x'.repeat(32)));
});

test('idle defaults to sixty minutes after activity and permits a short test override', () => {
  const now = createdAt + 20 * minute;
  assert.equal(idleDeadline(now, createdAt), createdAt + 80 * minute);
  assert.equal(idleDeadline(now, createdAt, 30_000), now + 30_000);
  assert.equal(idleDeadline(now, createdAt, 1), now + 1);
  assert.equal(idleDeadline(now, createdAt, 60 * minute), now + 60 * minute);
  assert.equal(idleDeadline(now, createdAt), now + 60 * minute);
});

test('idle overrides must be positive integer milliseconds no longer than sixty minutes', () => {
  for (const idleMs of [0, -1, 0.5, NaN, Infinity, '30000', null, 60 * minute + 1]) {
    assert.throws(() => idleDeadline(createdAt, createdAt, idleMs), /Invalid idle interval/);
  }
});

test('max-session rollover leaves ten minutes to drain before the twenty-four-hour cap', () => {
  const cutoff = createdAt + (24 * 60 - 10) * minute;
  assert.equal(idleDeadline(cutoff - 60 * minute - 1, createdAt), cutoff - 1);
  assert.equal(idleDeadline(cutoff - 60 * minute, createdAt), cutoff);
  assert.equal(idleDeadline(cutoff - 60 * minute + 1, createdAt), cutoff);
  assert.equal(idleDeadline(cutoff - minute, createdAt), cutoff);
  assert.equal(idleDeadline(cutoff, createdAt), cutoff);
  assert.equal(idleDeadline(cutoff + minute, createdAt), cutoff);
  assert.equal(idleDeadline(cutoff - 5_000, createdAt, 30_000), cutoff);
});

function sandboxFixture(timeout) {
  let session = { createdAt: new Date(createdAt), timeout };
  const calls = [];
  return {
    run: { sandbox: {
      currentSession: () => session,
      extendTimeout: async (duration, options) => { calls.push({ duration, options }); },
    } },
    calls,
    setSession: (next) => { session = next; },
  };
}

test('extension adds only the gap from the current session deadline, including drain reserve', async () => {
  const f = sandboxFixture(70 * minute);
  await extendForIdle(f.run, createdAt + 90 * minute);
  assert.deepEqual(f.calls.map(call => call.duration), [30 * minute]);
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.calls[0].options.signal.aborted, false);
});

test('each extension reads the latest current session deadline', async () => {
  const f = sandboxFixture(70 * minute);
  await extendForIdle(f.run, createdAt + 90 * minute);
  // The SDK reports the new total timeout after the first extension.
  f.setSession({ createdAt: new Date(createdAt), timeout: 100 * minute });
  await extendForIdle(f.run, createdAt + 90 * minute);
  await extendForIdle(f.run, createdAt + 105 * minute);
  assert.deepEqual(f.calls.map(call => call.duration), [30 * minute, 15 * minute]);
});

test('extension uses the current session creation time after a session rollover', async () => {
  const f = sandboxFixture(70 * minute);
  const nextCreatedAt = createdAt + 24 * 60 * minute;
  f.setSession({ createdAt: new Date(nextCreatedAt), timeout: 70 * minute });
  await extendForIdle(f.run, nextCreatedAt + 80 * minute);
  assert.deepEqual(f.calls.map(call => call.duration), [20 * minute]);
});

test('equal or later existing deadlines are never shortened', async () => {
  for (const timeout of [100 * minute, 120 * minute, 24 * 60 * minute]) {
    const f = sandboxFixture(timeout);
    await extendForIdle(f.run, createdAt + 90 * minute);
    assert.deepEqual(f.calls, []);
  }
});

test('extension caps the total session duration at twenty-four hours', async () => {
  const f = sandboxFixture((24 * 60 - 5) * minute);
  await extendForIdle(f.run, createdAt + 25 * 60 * minute);
  assert.deepEqual(f.calls.map(call => call.duration), [5 * minute]);
  f.setSession({ createdAt: new Date(createdAt), timeout: 24 * 60 * minute });
  await extendForIdle(f.run, createdAt + 25 * 60 * minute);
  assert.equal(f.calls.length, 1);
});

test('short idle overrides retain only the required drain reserve when extending', async () => {
  const f = sandboxFixture(5 * minute);
  await extendForIdle(f.run, idleDeadline(createdAt, createdAt, 30_000));
  assert.deepEqual(f.calls.map(call => call.duration), [5 * minute + 30_000]);
});

test('failed extension rejects so the caller cannot assume the session was extended', async () => {
  const f = sandboxFixture(5 * minute);
  const failure = new Error('extension unavailable');
  f.run.sandbox.extendTimeout = async () => { throw failure; };
  await assert.rejects(extendForIdle(f.run, createdAt + 60 * minute), error => error === failure);
});

function lifecycleFixture(t, status = 'busy') {
  t.mock.method(Date, 'now', () => createdAt + 20 * minute);
  const calls = [], saved = [], scheduled = [], receipts = [];
  const handle = { createdAt, sessionId: 'session-owned', name: 'sandbox-owned', driveId: 'drive-owned' };
  const previous = { generation: event.generation, status, handle,
    idleAt: createdAt + 10 * minute, lastActivityAt: createdAt };
  let persisted = structuredClone(previous);
  const store = {
    claimIdle: async () => { calls.push('claim'); return structuredClone(persisted); },
    save: async (_agent, _owner, state) => {
      calls.push(`save:${state.status}`);
      saved.push(structuredClone(state));
      persisted = structuredClone(state);
    },
    clear: async () => { calls.push('clear'); persisted = null; },
    release: async () => { calls.push('release'); },
  };
  const run = {
    run: { stage: 'ready', handle: () => handle },
    sandbox: {
      currentSession: () => ({ createdAt: new Date(createdAt), timeout: 70 * minute }),
      extendTimeout: async duration => { calls.push('extend'); assert.equal(duration, 20 * minute); },
    },
    resumeAfterTurn: async () => { calls.push('resume'); },
    prepareIdle: async () => { calls.push('prepare'); return true; },
    quiesce: async () => { calls.push('quiesce'); },
    stop: async () => { calls.push('stop'); },
  };
  const receipt = { event: name => receipts.push(name) };
  const schedule = async payload => { calls.push('schedule'); scheduled.push(payload); };
  const warm = new WarmSlack({}, store, {}, 'test-token', schedule);
  warm.admitted({ agent: event.agent, owner: 'turn-owner' });
  // TypeScript private fields are accessible in emitted JavaScript; no runtime attachment is needed.
  warm.run = run;
  warm.state = structuredClone(previous);
  t.mock.method(SlackRun, 'reconnect', async () => { calls.push('reconnect'); return run; });
  return { warm, store, run, receipt, schedule, calls, saved, scheduled, receipts, previous,
    persisted: () => persisted };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('finished persists pending before scheduling and publishes ready only after acceptance', async t => {
  const f = lifecycleFixture(t), entered = deferred(), accepted = deferred();
  f.warm.schedule = async payload => {
    f.calls.push('schedule'); f.scheduled.push(payload); entered.resolve();
    await accepted.promise;
  };
  const finishing = f.warm.finished(f.receipt);
  try {
    await Promise.race([entered.promise, finishing]);
    assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule']);
    assert.equal(f.persisted().status, 'pending');
    assert.notEqual(f.persisted().generation, f.previous.generation);
    assert.equal(f.persisted().generation, f.scheduled[0].generation);
    assert.equal(f.persisted().idleAt, f.scheduled[0].dueAt);
    assert.equal(f.warm.state.status, 'pending');
    assert.deepEqual(f.saved.map(state => state.status), ['pending']);
    assert.equal(f.receipts.includes('gateway-retained'), false);
  } finally {
    accepted.resolve();
    await finishing;
  }
  assert.equal(await finishing, 'warm');
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule', 'save:ready']);
  assert.deepEqual(f.saved.map(state => state.status), ['pending', 'ready']);
  assert.deepEqual(f.saved[1], { ...f.saved[0], status: 'ready' });
  assert.equal(f.scheduled[0].agent, event.agent);
  assert.deepEqual(f.receipts, ['gateway-retained']);
});

test('finished scheduling failure stops cleanly before clearing without publishing ready state', async t => {
  const f = lifecycleFixture(t);
  f.warm.schedule = async () => { f.calls.push('schedule'); throw Error('queue unavailable'); };
  assert.equal(await f.warm.finished(f.receipt), 'detached');
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule', 'prepare', 'quiesce', 'stop', 'clear']);
  assert.deepEqual(f.saved.map(state => state.status), ['pending']);
  assert.equal(f.persisted(), null);
  assert.deepEqual(f.receipts, ['idle-scheduling-failed', 'warm-fallback-stopped']);
});

test('finished preserves pending when scheduling fails and native work prevents fallback', async t => {
  const f = lifecycleFixture(t);
  f.warm.schedule = async () => { f.calls.push('schedule'); throw Error('queue unavailable'); };
  f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
  await assert.rejects(f.warm.finished(f.receipt), /native gateway is busy/);
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule', 'prepare']);
  assert.equal(f.persisted().status, 'pending');
  assert.deepEqual(f.saved.map(state => state.status), ['pending']);
  assert.deepEqual(f.receipts, ['idle-scheduling-failed']);
});

test('finished preserves pending when immediate fallback stop fails', async t => {
  const f = lifecycleFixture(t), failure = new Error('stop unavailable');
  f.warm.schedule = async () => { f.calls.push('schedule'); throw Error('queue unavailable'); };
  f.run.stop = async () => { f.calls.push('stop'); throw failure; };
  await assert.rejects(f.warm.finished(f.receipt), error => error === failure);
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule', 'prepare', 'quiesce', 'stop']);
  assert.equal(f.persisted().status, 'pending');
  assert.deepEqual(f.saved.map(state => state.status), ['pending']);
  assert.deepEqual(f.receipts, ['idle-scheduling-failed']);
});

test('finished never schedules when persisting pending fails', async t => {
  const f = lifecycleFixture(t), failure = new Error('ownership lost');
  f.store.save = async () => { f.calls.push('save:pending'); throw failure; };
  await assert.rejects(f.warm.finished(f.receipt), error => error === failure);
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending']);
  assert.deepEqual(f.scheduled, []);
  assert.deepEqual(f.persisted(), f.previous);
  assert.equal(f.receipts.includes('gateway-retained'), false);
});

test('finished leaves recoverable pending state when saving ready after acceptance fails', async t => {
  const f = lifecycleFixture(t), failure = new Error('ownership lost');
  const save = f.store.save;
  f.store.save = async (...args) => {
    if (args[2].status === 'ready') { f.calls.push('save:ready'); throw failure; }
    return save(...args);
  };
  await assert.rejects(f.warm.finished(f.receipt), error => error === failure);
  assert.deepEqual(f.calls, ['resume', 'extend', 'save:pending', 'schedule', 'save:ready']);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.persisted().status, 'pending');
  assert.equal(f.persisted().generation, f.scheduled[0].generation);
  assert.equal(f.receipts.includes('gateway-retained'), false);
});

test('stopIdle awaits extension before saving and scheduling a busy-native deferral', async t => {
  const f = lifecycleFixture(t, 'ready'), entered = deferred(), extended = deferred();
  f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
  f.run.sandbox.extendTimeout = async duration => {
    f.calls.push('extend'); entered.resolve();
    assert.equal(duration, 20 * minute);
    await extended.promise;
  };
  const stopping = stopIdle({}, f.store, {}, event, f.receipt, f.schedule);
  try {
    // Also let an implementation that omits extension finish, so it fails rather than hangs.
    await Promise.race([entered.promise, stopping]);
    assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'extend']);
    assert.equal(f.persisted().status, 'stopping');
    assert.deepEqual(f.scheduled, []);
  } finally {
    extended.resolve();
    await stopping;
  }
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'extend', 'save:ready', 'schedule', 'release']);
  assert.equal(f.persisted().idleAt, createdAt + 80 * minute);
  assert.equal(f.persisted().generation, event.generation);
  assert.equal(f.scheduled[0].dueAt, f.persisted().idleAt);
  assert.equal(f.scheduled[0].generation, event.generation);
});

test('stopIdle extension failure releases ownership without saving ready or scheduling', async t => {
  const f = lifecycleFixture(t, 'ready'), failure = new Error('extension unavailable');
  f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
  f.run.sandbox.extendTimeout = async () => { f.calls.push('extend'); throw failure; };
  await assert.rejects(stopIdle({}, f.store, {}, event, f.receipt, f.schedule), error => error === failure);
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'extend', 'release']);
  assert.deepEqual(f.saved.map(state => state.status), ['stopping']);
  assert.equal(f.persisted().idleAt, f.previous.idleAt);
  assert.deepEqual(f.scheduled, []);
});

test('stopIdle deferral save failure releases ownership and never schedules', async t => {
  const f = lifecycleFixture(t, 'ready'), failure = new Error('ownership lost');
  f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
  const save = f.store.save;
  f.store.save = async (...args) => {
    if (args[2].status === 'ready') { f.calls.push('save:ready'); throw failure; }
    return save(...args);
  };
  await assert.rejects(stopIdle({}, f.store, {}, event, f.receipt, f.schedule), error => error === failure);
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'extend', 'save:ready', 'release']);
  assert.equal(f.persisted().status, 'stopping');
  assert.deepEqual(f.scheduled, []);
});

test('stopIdle deferral scheduling failure remains retryable and releases ownership after extension', async t => {
  const f = lifecycleFixture(t, 'ready'), failure = new Error('queue unavailable');
  f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
  const schedule = async () => { f.calls.push('schedule'); throw failure; };
  await assert.rejects(stopIdle({}, f.store, {}, event, f.receipt, schedule), error => error === failure);
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'extend', 'save:ready', 'schedule', 'release']);
  assert.equal(f.persisted().status, 'ready');
  assert.equal(f.persisted().generation, event.generation);
  assert.equal(f.persisted().idleAt, createdAt + 80 * minute);
});


test('normal attach rejects pending before reconnecting or starting a runtime', async t => {
  const f = lifecycleFixture(t, 'pending');
  f.store.read = async () => { f.calls.push('read'); return structuredClone(f.persisted()); };
  t.mock.method(SlackRun, 'attach', async () => { throw Error('must not start a runtime'); });
  await assert.rejects(f.warm.attach({}, event.agent, f.receipt, { services: {} }, {}),
    /Previous warm operation is uncertain/);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.persisted().status, 'pending');
});

test('idle callback cleans a pending generation after scheduling acceptance but before ready persistence', async t => {
  const f = lifecycleFixture(t, 'pending');
  const ownership = [];
  f.store.claimIdle = async (callback, owner) => {
    f.calls.push('claim'); ownership.push(owner);
    assert.equal(callback.generation, f.persisted().generation);
    return structuredClone(f.persisted());
  };
  for (const method of ['save', 'clear', 'release']) {
    const original = f.store[method];
    f.store[method] = async (agent, owner, ...args) => {
      assert.equal(agent, event.agent);
      assert.equal(owner, ownership[0]);
      return original(agent, owner, ...args);
    };
  }
  await stopIdle({}, f.store, {}, event, f.receipt, f.schedule);
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'quiesce', 'stop', 'clear', 'release']);
  assert.equal(ownership.length, 1);
  assert.equal(typeof ownership[0], 'string');
  assert.equal(f.saved[0].generation, event.generation);
  assert.equal(f.persisted(), null);
  assert.deepEqual(f.scheduled, []);
  assert.deepEqual(f.receipts, ['idle-stopped']);
});

test('pending callback cleanup failure preserves stop intent and releases ownership for retry', async t => {
  const f = lifecycleFixture(t, 'pending'), failure = new Error('stop unavailable');
  f.run.stop = async () => { f.calls.push('stop'); throw failure; };
  await assert.rejects(stopIdle({}, f.store, {}, event, f.receipt, f.schedule), error => error === failure);
  assert.deepEqual(f.calls, ['claim', 'save:stopping', 'reconnect', 'prepare', 'quiesce', 'stop', 'release']);
  assert.equal(f.persisted().status, 'stopping');
  assert.equal(f.persisted().generation, event.generation);
  assert.deepEqual(f.scheduled, []);
  assert.equal(f.receipts.includes('idle-stopped'), false);
});


for (const initialStatus of ['pending', 'stopping']) {
  test(`stopIdle busy-native deferral from ${initialStatus} stays nonreusable pending`, async t => {
    const f = lifecycleFixture(t, initialStatus);
    f.run.prepareIdle = async () => { f.calls.push('prepare'); return false; };
    await stopIdle({}, f.store, {}, event, f.receipt, f.schedule);
    assert.deepEqual(f.calls, [
      'claim', 'save:stopping', 'reconnect', 'prepare', 'extend', 'save:pending', 'schedule', 'release',
    ]);
    assert.deepEqual(f.saved.map(state => state.status), ['stopping', 'pending']);
    assert.equal(f.persisted().status, 'pending');
    assert.equal(f.persisted().generation, event.generation);
    assert.equal(f.persisted().idleAt, createdAt + 80 * minute);
    assert.equal(f.scheduled.length, 1);
    assert.deepEqual(f.scheduled[0], {
      kind: 'slack-idle-v1', agent: event.agent, generation: event.generation,
      dueAt: f.persisted().idleAt,
    });
    assert.deepEqual(f.receipts, []);
  });
}
