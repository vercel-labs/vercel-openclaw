import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';

function ready(rpc) {
  const control = new Controller({}, {owner: {assertCurrent: async () => {}, fence() {}}, worker: {stop: async () => {}}});
  control.waitPlacement = async () => ({state: 'active'});
  control.phase = 'ready'; control.gateway = {rpc};
  return control;
}
test('native session creation owns placement and accepts nonunique display names', async () => {
  const calls = [];
  const c = ready(async (method, params) => {calls.push({method, params}); return {ok: true, key: `session-${calls.length}`};});
  await c.session(); await c.session();
  assert.deepEqual(calls.map(c => c.method), ['sessions.create', 'sessions.create']);
  assert(calls.every(c => c.params.displayName && !c.params.label));
  assert.equal(c.sessions.size, 2);
});
test('post-commit session failure retains its key and prevents another mutation', async () => {
  let calls = 0;
  const c = ready(async () => {calls++; return {ok: true, key: 'known-key', runError: 'placement failed'};});
  await assert.rejects(c.session(), /preparation failed/);
  assert.equal(c.lastSession.key, 'known-key'); assert.equal(c.phase, 'uncertain');
  await assert.rejects(c.session(), /not ready/); assert.equal(calls, 1);
});
test('a timed out turn retains its result and blocks subsequent work', async () => {
  const c = ready(async method => method === 'agent' ? {runId: 'run-1'} : {status: 'timeout'});
  c.sessions.add('session');
  const result = await c.message({sessionKey: 'session', message: 'read a file', idempotencyKey: 'stable-id'});
  assert.equal(result.accepted.runId, 'run-1'); assert.equal(result.completed.status, 'timeout');
  assert.equal(c.phase, 'uncertain'); await assert.rejects(c.session(), /not ready/);
});
test('a signal-killed gateway is never treated as ready', async () => {
  const c = ready(async () => assert.fail('dead gateway called'));
  c.gateway.child = {exitCode: null, signalCode: 'SIGKILL'};
  await assert.rejects(c.session(), /exited/); assert.equal(c.phase, 'failed');
});
test('shutdown attempts both gateway and worker even if gateway stop fails', async () => {
  const c = ready(); let stopped = 0;
  c.gateway.stop = async () => {throw new Error('unconfirmed');};
  c.worker.stop = async () => {stopped++;};
  await assert.rejects(c.close(), /unconfirmed/); assert.equal(stopped, 1);
});

test('placement admission rejects an active runner with the wrong identity', async () => {
  let reads = 0;
  const c = ready(async () => ++reads === 1 ? {session: {sessionId: 'native-session', placement: {state: 'active', providerId: 'device', profileId: 'dedicated-native', inference: 'worker', runner: {kind: 'device', status: 'available', deviceId: 'wrong'}, remoteWorkspaceDir: '/data/openclaw-node/workspace'}}} : {session: {placement: {state: 'failed'}}});
  c.deviceId = 'expected';
  await assert.rejects(Controller.prototype.waitPlacement.call(c, {key: 'session', sessionId: 'native-session'}), /placement failed/);
  assert.equal(reads, 2);
});
test('independent proof refuses a changed placement before reading files', async () => {
  const c = ready(async () => ({session: {placement: {environmentId: 'replacement'}}}));
  c.placements.set('session', {environmentId: 'original'});
  c.worker.session = {readFileToBuffer: async () => assert.fail('unexpected file read')};
  await assert.rejects(c.proof({sessionKey: 'session'}), /Placement changed/);
  assert.equal(c.phase, 'uncertain'); await assert.rejects(c.session(), /not ready/);
});

test('proof is refused while a turn is active', async () => {
  const c = ready(async () => assert.fail('concurrent native read'));
  c.active = true;
  await assert.rejects(c.proof({sessionKey: 'session'}), /operation is active/);
});
test('shutdown preserves uncertainty for work interrupted during close', async () => {
  const c = ready(); c.active = true;
  c.gateway.stop = async () => {c.active = false; c.phase = 'uncertain';};
  await c.close();
  assert.equal(c.phase, 'uncertain'); assert.equal(c.closing, true);
  await assert.rejects(c.session(), /not ready/);
});
