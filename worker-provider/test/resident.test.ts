import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRequest, serveResident } from '../runtime/resident.mjs';

test('resident handles two warm requests, resets idle, rejects stale callers, then fences only on expiry', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oc-idle-'));
  const signal = new AbortController();
  const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
  let now = 0, stopped = 0, reclaimed = 0, executions = 0, clock: any;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'capability' }, now: () => now, signal: signal.signal, pollMs: 60000,
    onReady: (value: any) => { clock = value; ready(); },
    execute: async () => { executions++; return { gatewayPid: 123 }; }, reclaim: async () => { reclaimed++; }, stopGateway: async () => { stopped++; }, gatewayHasExited: () => stopped > 0,
    rpc: async (method: string) => method === 'gateway.restart.preflight' ? { safe: true } : { status: 'ready', suspensionId: 'fence', expiresAtMs: Date.now() + 120000, activeCount: 0, blockers: [] },
  });
  try {
    await started;
    const call = (path: string, extra = {}) => localRequest(base, 'test', path, { ...binding, executionDeadlineMs: now + 200000, credential: 'fresh', ...extra });
    await call('/turn');
    now = 44 * 60000;
    await call('/turn', { credential: 'rotated' });
    assert.equal(JSON.parse(readFileSync(join(base, 'host-credentials.json'), 'utf8')).token, 'rotated');
    assert.equal(clock.lastActivityAt, now);
    now += 44 * 60000;
    assert.equal((await call('/sleep') as any).action, 'none');
    assert.equal(stopped, 0);
    assert.equal(reclaimed, 0);
    assert.equal(executions, 2);
    const previous = clock.lastActivityAt;
    await call('/status');
    assert.equal(clock.lastActivityAt, previous);
    await assert.rejects(call('/turn', { platformSessionId: 'stale' }));
    await assert.rejects(localRequest(base, 'wrong', '/turn', binding));
    assert.equal(clock.lastActivityAt, previous);
    now += 60000;
    const receipt: any = await call('/sleep');
    assert.equal(receipt.action, 'sleep');
    assert.equal(receipt.reason, 'idle');
    assert.equal(stopped, 1);
    assert.equal(reclaimed, 1);
    assert(!existsSync(join(base, 'host-credentials.json')));
    now += 10 * 60000;
    assert.deepEqual(await call('/sleep'), receipt);
    await assert.rejects(call('/turn'));
  } finally { signal.abort(); await serving; }
});

test('active work rejects idle shutdown; a completed turn cancels a stale sleep timer', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oc-race-'));
  const signal = new AbortController();
  const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
  let now = 0, stopped = 0, release!: () => void, ready!: () => void, executing!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const inTurn = new Promise<void>(resolve => { executing = resolve; });
  const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'cap' }, now: () => now, signal: signal.signal, pollMs: 60000,
    onReady: () => ready(), execute: async () => { executing(); await new Promise<void>(resolve => { release = resolve; }); return {}; },
    reclaim: async () => { stopped++; }, stopGateway: async () => { stopped++; }, rpc: async () => { throw new Error('Should not inspect or suspend active work'); },
  });
  try {
    await started;
    const call = (path: string) => localRequest(base, 'test', path, { ...binding, executionDeadlineMs: now + 200000, credential: 'fresh' });
    const turn = call('/turn');
    await inTurn;
    now += 60 * 60000;
    await assert.rejects(call('/sleep'), /409/);
    release(); await turn;
    assert.equal((await call('/sleep') as any).action, 'none');
    assert.equal(stopped, 0);
  } finally { signal.abort(); await serving; }
});

test('timer calls the authenticated host after inactivity even with no open turn request', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oc-timer-'));
  const signal = new AbortController();
  const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
  let now = 0, ready!: () => void, called!: () => void, callbackOidc: string | undefined;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const callback = new Promise<void>(resolve => { called = resolve; });
  const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'cap' }, now: () => now, signal: signal.signal, pollMs: 10,
    onReady: () => ready(), execute: async () => ({}), fetcher: async (url: string, options: any) => {
      assert.equal(url, 'https://example.org/api/codex/sleep');
      assert.equal(options.headers.authorization, 'Bearer cap');
      callbackOidc = options.headers['x-vercel-trusted-oidc-idp-token'];
      assert.deepEqual(JSON.parse(options.body), binding);
      called(); return { ok: true };
    },
  });
  try {
    await started;
    await localRequest(base, 'test', '/turn', { ...binding, credential: 'first-project-oidc', executionDeadlineMs: 200000 });
    await localRequest(base, 'test', '/turn', { ...binding, credential: 'latest-project-oidc', executionDeadlineMs: 200000 });
    now = 45 * 60000;
    await callback;
    assert.equal(callbackOidc, 'latest-project-oidc');
  } finally { signal.abort(); await serving; }
});

test('resident cancels at the host deadline rather than its independent 235-second maximum', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oc-budget-'));
  const shutdown = new AbortController();
  const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
  let ready!: () => void, cancelled = false;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: Date.now() + 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'cap' }, signal: shutdown.signal, pollMs: 60000,
    onReady: () => ready(), execute: async ({ signal }: { signal: AbortSignal }) => {
      await new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }));
      throw new Error('Should not finish normally');
    },
  });
  try {
    await started;
    await assert.rejects(localRequest(base, 'test', '/turn', { ...binding, credential: 'fresh', executionDeadlineMs: Date.now() + 30 }, 2000), /500/);
    assert.equal(cancelled, true);
  } finally { shutdown.abort(); await serving; }
});

test('failed turn requests authenticated cleanup immediately and remains fenced', { timeout: 5000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'oc-failed-'));
  const shutdown = new AbortController();
  const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
  let ready!: () => void, callback!: () => void, stopped = false, executions = 0;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const called = new Promise<void>(resolve => { callback = resolve; });
  const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'cap' }, now: () => 0, signal: shutdown.signal, pollMs: 10,
    onReady: () => ready(), execute: async () => { executions++; throw new Error('Turn failed'); },
    reclaim: async () => {}, stopGateway: async () => { stopped = true; }, gatewayHasExited: () => stopped,
    rpc: async (method: string, params: any) => {
      if (method === 'gateway.restart.preflight') return { safe: true };
      assert.equal(method, 'gateway.suspend.prepare');
      assert.equal(params.drain, true);
      return { status: 'ready', suspensionId: 'fence', expiresAtMs: Date.now() + 120000, activeCount: 0, blockers: [] };
    },
    fetcher: async (url: string, options: any) => {
      assert.equal(url, 'https://example.org/api/codex/sleep');
      assert.equal(options.headers.authorization, 'Bearer cap');
      assert.equal(options.headers['x-vercel-trusted-oidc-idp-token'], 'fresh');
      assert.deepEqual(JSON.parse(options.body), binding);
      callback(); return { ok: true };
    },
  });
  try {
    await started;
    const call = (path: string) => localRequest(base, 'test', path, { ...binding, credential: 'fresh', executionDeadlineMs: 200000 });
    await assert.rejects(call('/turn'), /500/);
    await called;
    await assert.rejects(call('/turn'), /409/);
    assert.equal(executions, 1);
    const receipt: any = await call('/sleep');
    assert.equal(receipt.reason, 'failure');
    assert.equal(receipt.residentFenced, true);
    assert.equal(receipt.workerStopped, true);
    assert.equal(receipt.gatewayStopped, true);
    assert(!existsSync(join(base, 'host-credentials.json')));
    assert.deepEqual(await call('/sleep'), receipt);
    await assert.rejects(call('/turn'), /409/);
  } finally { shutdown.abort(); await serving; rmSync(base, { recursive: true, force: true }); }
});

test('failed resident retries cleanup without bypassing activity or shutdown fences', { timeout: 5000 }, async t => {
  for (const failure of ['preflight', 'reclaim', 'suspend', 'exit']) await t.test(failure, async () => {
    const base = mkdtempSync(join(tmpdir(), 'oc-cleanup-'));
    const shutdown = new AbortController();
    const binding = { runtimeDigest: 'digest', platformSessionId: 'session' };
    let ready!: () => void, blocked = true;
    const steps: string[] = [];
    const started = new Promise<void>(resolve => { ready = resolve; });
    const serving = serveResident({ base, token: 'test', input: { ...binding, hardDeadlineMs: 86400000, sleepUrl: 'https://example.org/api/codex/sleep', sleepCapability: 'cap' }, now: () => 0, signal: shutdown.signal, pollMs: 60000,
      onReady: () => ready(), execute: async () => { throw new Error('Turn failed'); },
      reclaim: async () => { steps.push('reclaim'); if (blocked && failure === 'reclaim') throw new Error('Reclaim failed'); },
      stopGateway: async () => { steps.push('stop'); }, gatewayHasExited: () => !(blocked && failure === 'exit'),
      rpc: async (method: string) => {
        if (method === 'gateway.restart.preflight') { steps.push('preflight'); return { safe: !(blocked && failure === 'preflight') }; }
        steps.push('suspend');
        if (blocked && failure === 'suspend') throw new Error('Suspension failed');
        return { status: 'ready', suspensionId: 'fence', expiresAtMs: Date.now() + 120000, activeCount: 0, blockers: [] };
      },
    });
    try {
      await started;
      const call = (path: string) => localRequest(base, 'test', path, { ...binding, credential: 'fresh', executionDeadlineMs: 200000 });
      await assert.rejects(call('/turn'), /500/);
      if (failure === 'preflight') assert.equal((await call('/sleep') as any).action, 'busy');
      else await assert.rejects(call('/sleep'), /500/);
      const lastStep = { preflight: 'preflight', reclaim: 'reclaim', suspend: 'suspend', exit: 'stop' }[failure];
      assert.equal(steps.at(-1), lastStep);
      const status: any = await call('/status');
      assert.equal(status.failed, true);
      assert.equal(status.sleeping, false);
      assert(existsSync(join(base, 'host-credentials.json')));
      await assert.rejects(call('/turn'), /409/);
      blocked = false; steps.length = 0;
      assert.equal((await call('/sleep') as any).reason, 'failure');
      assert.deepEqual(steps, ['preflight', 'reclaim', 'suspend', 'stop']);
    } finally { shutdown.abort(); await serving; rmSync(base, { recursive: true, force: true }); }
  });
});
