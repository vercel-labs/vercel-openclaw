import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRemoteTurn, visibleReply } from '../runtime/remote-turn.mjs';
import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';
import { lifecycleFixture } from './codex-e2e/lifecycle-fixture.mjs';
import * as hostRuntime from '../runtime/remote-turn.mjs';

test('sleep preparation waits for the same draining lease and records readiness', async () => {
  assert.equal(typeof hostRuntime.prepareHostSleep, 'function');
  let now = 1000;
  const calls: any[] = [], observed: string[] = [];
  const ready = { status: 'ready', suspensionId: 'lease', expiresAtMs: 121000, activeCount: 0, blockers: [] };
  const result = await hostRuntime.prepareHostSleep({ requestId: 'host-event', now: () => now,
    sleep: async (ms: number) => { now += ms; }, observe: (s: any) => observed.push(s.status),
    rpc: async (method: string, params: any) => {
      calls.push([method, params]);
      return calls.length === 1 ? { ...ready, status: 'draining', retryAfterMs: 20000, activeCount: 1, blockers: [{ kind: 'chat-run', count: 1 }] } : { status: 'ready', expiresAtMs: ready.expiresAtMs };
    },
  });
  assert.deepEqual(result, ready);
  assert.equal(now, 21000);
  assert.deepEqual(observed, ['draining', 'ready']);
  assert.deepEqual(calls, [['gateway.suspend.prepare', { requestId: 'host-event', terminalPolicy: 'preserve', drain: true }], ['gateway.suspend.status', { suspensionId: 'lease' }]]);
});

test('sleep preparation fails closed on blockers, expiry or a changed lease', async () => {
  assert.equal(typeof hostRuntime.prepareHostSleep, 'function');
  for (const response of [
    { status: 'busy', activeCount: 1 },
    { status: 'ready', suspensionId: 'lease', expiresAtMs: 1, activeCount: 0, blockers: [] },
    { status: 'ready', suspensionId: 'lease', expiresAtMs: 200000, activeCount: 1, blockers: [] },
    { status: 'draining', suspensionId: 'lease', expiresAtMs: 200000, activeCount: 1, blockers: [], retryAfterMs: 20000 },
  ]) {
    let now = 1000;
    await assert.rejects(hostRuntime.prepareHostSleep({ requestId: 'x', now: () => now, timeoutMs: 10000, sleep: async (ms: number) => { now += ms; }, rpc: async () => response }));
  }
  let calls = 0, now = 1000;
  await assert.rejects(hostRuntime.prepareHostSleep({ requestId: 'x', now: () => now, sleep: async (ms: number) => { now += ms; },
    rpc: async () => (++calls === 1 ? { status: 'draining', suspensionId: 'lease', expiresAtMs: 200000, retryAfterMs: 1 } : { status: 'ready', suspensionId: 'different', expiresAtMs: 200000, activeCount: 0, blockers: [] }),
  }), /lease changed/);
});

test('recall fixture survives secret redaction without disabling protection or leaking the answer into turn two', () => {
  const fixture = lifecycleFixture();
  assert(!redactSensitiveText(`Conversation token: ${fixture.nickname}`).includes(fixture.nickname));
  const reply = redactSensitiveText(`Project nickname: ${fixture.nickname}\nFile contents: ${fixture.fileContent}`);
  fixture.assertReply(reply, 1);
  assert(!fixture.messages[1].includes(fixture.nickname));
  assert(!fixture.messages[1].includes(fixture.fileContent));
  assert.throws(() => fixture.assertReply(fixture.fileContent, 1));
  assert.throws(() => fixture.assertReply(fixture.nickname, 1));
});

const terminal = (runId: string, text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], __openclaw: { runId, runTerminal: true } });

test('host replies are tied to the completed run, never an older response or tool output', () => {
  const messages = [terminal('old', 'old answer'), { ...terminal('new', 'tool input'), __openclaw: { runId: 'new' } }, terminal('new', 'answer')];
  assert.equal(visibleReply({ messages }, 'new'), 'answer');
  assert.throws(() => visibleReply({ messages }, 'missing'));
  assert.throws(() => visibleReply({ messages: [terminal('new', '')] }, 'new'));
});

test('a second host task reuses the saved session but dispatches and approves a fresh worker', async () => {
  let saved: any;
  let launches = 0;
  const calls: string[] = [];
  const session = { key: 'agent:main:slack-c123', sessionId: 'session-1', worktree: { path: '/managed/worktree' } };
  const placement = { state: 'active', environmentId: 'env', remoteWorkspaceDir: '/remote/worktree', activeOwnerEpoch: 1, generation: 1 };
  const rpc = async (method: string) => {
    calls.push(method);
    if (method === 'sessions.describe') return { session: saved ? session : null };
    if (method === 'sessions.create') return session;
    if (method === 'sessions.dispatch') return { placement };
    if (method === 'sessions.reclaim') return {};
    throw new Error(method);
  };
  const options = { base: '/runtime', sessionKey: 'agent:main:slack-C123', rpc, loadSession: async () => saved, saveSession: async (_: string, next: any) => { saved = next; },
    connectOperator: async () => ({ send: async () => ({ runId: 'run' }), wait: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'ok' }; },
      approveLaunch: async (expected: any) => { assert.equal(expected.sessionId, 'session-1'); assert.equal(expected.nodeId, `node-${launches}`); return true; },
      request: async () => ({ messages: [terminal('run', 'done')] }), close: async () => {}, cancel: async () => {} }),
    workerFor: async () => { launches++; return { nodeId: `node-${launches}`, name: `worker-${launches}`, assertStopped: async () => { calls.push('worker-stopped'); } }; },
  };
  const first = await runRemoteTurn({ ...options, eventId: 'Ev1', message: 'remember' });
  const second = await runRemoteTurn({ ...options, eventId: 'Ev2', message: 'recall' });
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.workerName, second.workerName);
  assert.equal(calls.filter(call => call === 'sessions.create').length, 1);
  assert.equal(calls.filter(call => call === 'sessions.dispatch').length, 2);
  assert.equal(calls.filter(call => call === 'sessions.reclaim').length, 2);
  assert.equal(calls.filter(call => call === 'worker-stopped').length, 2);
});

test('changed session identity fails before dispatching any code', async () => {
  const methods: string[] = [];
  await assert.rejects(runRemoteTurn({ sessionKey: 'agent:main:slack-C123', eventId: 'Ev1', message: 'test', base: '/runtime',
    loadSession: async () => ({ sessionId: 'saved' }), rpc: async (method: string) => { methods.push(method); return { session: { sessionId: 'changed' } }; },
  }), /identity changed/);
  assert.deepEqual(methods, ['sessions.describe']);
});

test('warm follow-ups retain VM2, but still attest it and obtain exact per-turn approvals', async () => {
  const calls: string[] = [];
  let saved: any;
  const session = { key: 'agent:main:slack-c123', sessionId: 'session', worktree: { path: '/worktree' } };
  const placement = { state: 'active', environmentId: 'env', remoteWorkspaceDir: '/remote', activeOwnerEpoch: 1, generation: 1 };
  const worker = { name: 'one-worker', nodeId: 'one-node', assertStopped: async () => { calls.push('stopped'); } };
  const options = { sessionKey: session.key, message: 'hello', base: '/runtime', keepWorker: true,
    loadSession: async () => saved, saveSession: async (_: string, value: any) => { saved = value; },
    rpc: async (method: string) => {
      calls.push(method);
      if (method === 'sessions.describe') return { session: saved };
      if (method === 'sessions.create') return session;
      if (method === 'sessions.dispatch') return { placement };
      if (method === 'sessions.reclaim') return {};
      throw new Error(method);
    },
    workerFor: async () => { calls.push('attest'); return worker; },
    connectOperator: async () => ({ send: async () => ({ runId: 'run' }), wait: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'ok' }; },
      approveLaunch: async (binding: any) => { assert.equal(binding.nodeId, worker.nodeId); calls.push('approve'); return true; },
      request: async () => ({ messages: [terminal('run', 'done')] }), close: async () => {}, cancel: async () => {} }),
  };
  const first = await runRemoteTurn({ ...options, eventId: 'Ev1' });
  const second = await runRemoteTurn({ ...options, eventId: 'Ev2', retained: first.retained });
  assert.equal(first.workerName, second.workerName);
  assert.equal(second.workerReused, true);
  assert.equal(calls.filter(c => c === 'sessions.dispatch').length, 1);
  assert.equal(calls.filter(c => c === 'attest').length, 2);
  assert.equal(calls.filter(c => c === 'approve').length, 2);
  assert(!calls.includes('sessions.reclaim'));
  await assert.rejects(runRemoteTurn({ ...options, eventId: 'Ev3', retained: { ...first.retained, sessionKey: 'another-thread' } }), /across conversations/);
});

test('an execution deadline cancels the exact run and reclaims its worker instead of reporting a warm success', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let saved: any;
  const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
  const options = { sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', keepWorker: true, signal: controller.signal,
    loadSession: async () => saved, saveSession: async (_: string, value: any) => { saved = value; },
    rpc: async (method: string) => {
      calls.push(method);
      if (method === 'sessions.describe') return { session: saved };
      if (method === 'sessions.create') return session;
      if (method === 'sessions.dispatch') return { placement: { state: 'active', environmentId: 'env' } };
      if (method === 'sessions.reclaim') return {};
      throw new Error(method);
    },
    workerFor: async () => ({ name: 'worker', nodeId: 'node' }),
    connectOperator: async () => ({ send: async () => ({ runId: 'exact-run' }),
      wait: async () => { controller.abort(new Error('deadline')); await new Promise(() => {}); return { status: 'cancelled' }; },
      cancel: async (runId: string) => { calls.push(`cancel:${runId}`); },
      approveLaunch: async () => false, close: async () => { calls.push('close'); },
    }),
  };
  await assert.rejects(runRemoteTurn(options), /deadline/);
  assert(calls.includes('cancel:exact-run'));
  assert.equal(calls.at(-1), 'sessions.reclaim');
});

test('a deadline interrupts pending dispatch and waits for native reclaim to finish', async () => {
  for (const cleanupFails of [false, true]) {
    const controller = new AbortController();
    const calls: string[] = [];
    const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
    let finishDispatch!: (value: any) => void, rejectDispatch!: (error: Error) => void;
    const dispatch = new Promise((resolve, reject) => { finishDispatch = resolve; rejectDispatch = reject; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    let settled = false;
    const result = runRemoteTurn({ sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', keepWorker: true, signal: controller.signal,
      loadSession: async () => session,
      rpc: async (method: string) => {
        calls.push(method);
        if (method === 'sessions.describe') return { session };
        if (method === 'sessions.dispatch') { controller.abort(new Error('host deadline')); return await dispatch; }
        if (method === 'sessions.reclaim') {
          rejectDispatch(new Error('native provisioning cancelled'));
          await cleanup;
          if (cleanupFails) throw new Error('native cleanup failed');
          calls.push('cleanup-finished');
          return { placement: { state: 'local' } };
        }
        throw new Error(method);
      },
      workerFor: async () => { assert.fail('must not attest or launch a turn after dispatch cancellation'); },
      connectOperator: async () => { assert.fail('must not launch an operator after dispatch cancellation'); },
    }).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const rejected = assert.rejects(result, cleanupFails ? /native cleanup failed/ : /host deadline/);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['sessions.describe', 'sessions.dispatch', 'sessions.reclaim']);
      assert.equal(settled, false, 'caller must wait until native cancellation and cleanup settle');
    } finally {
      finishDispatch({ placement: { state: 'active' } });
      finishCleanup();
      await rejected;
    }
    assert.equal(calls.includes('cleanup-finished'), !cleanupFails);
  }
});

test('a deadline reached during session setup never dispatches a worker', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
  await assert.rejects(runRemoteTurn({ sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', signal: controller.signal,
    loadSession: async () => session,
    rpc: async (method: string) => {
      calls.push(method);
      controller.abort(new Error('setup deadline'));
      return { session };
    },
  }), /setup deadline/);
  assert.deepEqual(calls, ['sessions.describe']);
});

test('a deadline starts reclaim without waiting for worker attestation or launching an operator', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
  let finishAttestation!: () => void;
  const attestation = new Promise<void>(resolve => { finishAttestation = resolve; });
  const result = runRemoteTurn({ sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', signal: controller.signal,
    loadSession: async () => session,
    rpc: async (method: string) => {
      calls.push(method);
      if (method === 'sessions.describe') return { session };
      if (method === 'sessions.dispatch') return { placement: { state: 'active' } };
      if (method === 'sessions.reclaim') return {};
      throw new Error(method);
    },
    workerFor: async () => { controller.abort(new Error('attestation deadline')); await attestation; return {}; },
    connectOperator: async () => { assert.fail('must not launch an operator after attestation cancellation'); },
  });
  const rejected = assert.rejects(result, /attestation deadline/);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1), 'sessions.reclaim');
  } finally {
    finishAttestation();
    await rejected;
  }
});

test('a late operator connection is closed after deadline cleanup, without sending a turn', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
  let finishConnection!: (value: any) => void;
  const connection = new Promise(resolve => { finishConnection = resolve; });
  const result = runRemoteTurn({ sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', signal: controller.signal,
    loadSession: async () => session,
    rpc: async (method: string) => {
      calls.push(method);
      if (method === 'sessions.describe') return { session };
      if (method === 'sessions.dispatch') return { placement: { state: 'active' } };
      if (method === 'sessions.reclaim') return {};
      throw new Error(method);
    },
    workerFor: async () => ({}),
    connectOperator: async () => { controller.abort(new Error('connection deadline')); return await connection; },
    closeNativeTurn: () => { calls.push('revoke'); },
  });
  const rejected = assert.rejects(result, /connection deadline/);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(-2), ['revoke', 'sessions.reclaim']);
  } finally {
    finishConnection({ close: async () => { calls.push('late-close'); }, send: async () => { assert.fail('late connection must not start a turn'); } });
    await rejected;
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), 'late-close');
});

test('a late non-native run identity is cancelled while cleanup does not wait for its acknowledgement', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const session = { key: 'agent:main:main', sessionId: 'session', worktree: { path: '/worktree' } };
  let acknowledge!: (value: any) => void;
  const sent = new Promise(resolve => { acknowledge = resolve; });
  const result = runRemoteTurn({ sessionKey: session.key, eventId: 'Ev1', message: 'run', base: '/runtime', signal: controller.signal,
    loadSession: async () => session,
    rpc: async (method: string) => {
      calls.push(method);
      if (method === 'sessions.describe') return { session };
      if (method === 'sessions.dispatch') return { placement: { state: 'active' } };
      if (method === 'sessions.reclaim') return {};
      throw new Error(method);
    },
    workerFor: async () => ({}),
    connectOperator: async () => ({
      send: async () => { controller.abort(new Error('submission deadline')); return await sent; },
      cancel: async (runId: string) => { calls.push(`cancel:${runId}`); },
      close: async () => { calls.push('close'); },
      approveLaunch: async () => { assert.fail('no approval after cancellation'); },
    }),
  });
  const rejected = assert.rejects(result, /submission deadline/);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(-2), ['close', 'sessions.reclaim']);
  } finally {
    acknowledge({ runId: 'late-owned-run' });
    await rejected;
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), 'cancel:late-owned-run');
});
