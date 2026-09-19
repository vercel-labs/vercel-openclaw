import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSlackPrompt, sha256 } from './native-slack-proof.mjs';
import { verifyNativeIdle } from './native-idle-proof.mjs';

function fixture() {
  const fixture = { channel: 'C1', user: 'U1', bot: 'UBOT', thread: '1.0', file: 'test.txt', value: 'spruce-123', cases: [{ label: 'write', role: 'write' }, { label: 'warm', role: 'read' }, { label: 'wake', role: 'read' }] };
  const observations: Record<string, any> = {}, logs: any[] = [];
  for (const [index, c] of fixture.cases.entries()) {
    const ts = [10, 20, 3000][index] + '.000', replyTs = [11, 21, 3001][index] + '.000';
    const eventId = `event${index}`, vm = index < 2 ? 'first' : 'second', worker = `worker-${vm}`;
    observations[c.label] = { runtimeDigest: 'digest', thread: fixture.thread, timestamp: ts,
      messages: [{ ts, user: fixture.user, text: nativeSlackPrompt(fixture, c.role) }, { ts: replyTs, user: fixture.bot, text: fixture.value }],
      admissions: [{ type: 'admitted', eventId, at: Number(ts) * 1000 }, { type: 'delivered', eventId, messageId: replyTs }],
      observations: [{ eyes: true }, { at: Number(replyTs) * 1000, status: 'running', vmSession: vm, eyes: false, worker: { name: worker, status: 'running', persistent: false, fileSha256: sha256(fixture.value + '\n') } }],
    };
    logs.push({ message: 'codex lifecycle receipt ' + JSON.stringify({ eventId, sessionId: 'one-thread', platformSessionId: vm, workerName: worker, gatewayPid: 42, workerReused: index === 1, idleTimeoutMs: 2700000, nativeSlackDelivered: true, gatewayStopped: false, vm1Stopped: false }) });
  }
  const idle = { snapshot: { status: 'created', sourceSessionId: 'first', id: 'snapshot' }, observations: [{ at: 2800000, status: 'stopped' }], worker: { name: 'worker-first', status: 'stopped' } };
  logs.push({ message: 'codex sleep receipt ' + JSON.stringify({ platformSessionId: 'first', action: 'sleep', reason: 'idle', snapshotId: 'snapshot' }) });
  return { fixture, observations, idle, logs, runtimeDigest: 'digest' };
}
test('idle proof requires warm VM reuse, real idle suspension and restored worker state', () => {
  assert.equal(verifyNativeIdle(fixture()).length, 3);
});
for (const [name, mutate] of Object.entries({
  'per-message stop': (f: ReturnType<typeof fixture>) => { f.observations.warm.observations.at(-1).status = 'stopped'; },
  'different warm worker': (f: ReturnType<typeof fixture>) => { f.observations.warm.observations.at(-1).worker.name = 'different'; },
  'stale snapshot': (f: ReturnType<typeof fixture>) => { f.idle.snapshot.sourceSessionId = 'old'; },
  'no restored file': (f: ReturnType<typeof fixture>) => { delete f.observations.wake.observations.at(-1).worker.fileSha256; },
  'shortened idle interval': (f: ReturnType<typeof fixture>) => { f.idle.observations.at(-1)!.at = 25000; },
  'platform cap disguised as idle': (f: ReturnType<typeof fixture>) => { f.logs.at(-1).message = f.logs.at(-1).message.replace('"idle"', '"deadline"'); },
  'wrong runtime': (f: ReturnType<typeof fixture>) => { f.observations.warm.runtimeDigest = 'wrong'; },
})) test(`idle proof rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => verifyNativeIdle(f)); });
