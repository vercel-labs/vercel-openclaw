import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const nativeSlackPrompt = (fixture, role) => role === 'write'
  ? `<@${fixture.bot}> Write ${fixture.file} containing exactly ${fixture.value} followed by a newline. Execute a command to read it and reply with its contents.`
  : `<@${fixture.bot}> Execute a command to read ${fixture.file} from our workspace and reply with its contents.`;

export function verifyNativeSlack({ fixture, observations, logs, workers, runtimeDigest }) {
  assert.equal(fixture.cases.length, 2, 'Exactly write and read turns required');
  assert.deepEqual(fixture.cases.map(c => c.role), ['write', 'read']);
  assert(/^[a-z]+-[0-9]+$/.test(fixture.value), 'Use a public, non-secret test value');
  assert(fixture.senderAttributionUser === undefined || /^U[A-Z0-9]+$/.test(fixture.senderAttributionUser), 'Invalid explicit sending-app identity');
  const suffix = fixture.senderAttributionUser ? ` *Sent using* <@${fixture.senderAttributionUser}>` : '';
  const runs = fixture.cases.map(test => {
    const o = observations[test.label];
    assert.equal(o.runtimeDigest, runtimeDigest);
    assert.equal(o.thread, fixture.thread);
    const sentAt = Number(o.timestamp) * 1000;
    const input = o.messages.find(m => m.ts === o.timestamp);
    assert.equal(input?.user, fixture.user);
    assert.equal(input.text.trim(), nativeSlackPrompt(fixture, test.role) + suffix, 'Input differs from exact test prompt');
    if (test.role === 'read') assert(!input.text.includes(fixture.value), 'Read prompt leaked the answer');
    const admitted = o.admissions.filter(a => a.type === 'admitted' && a.at >= sentAt);
    assert.equal(admitted.length, 1, 'Unique native admission required');
    const eventId = admitted[0].eventId;
    const receipts = logs.filter(l => l.message?.startsWith('codex lifecycle receipt '))
      .map(l => JSON.parse(l.message.slice('codex lifecycle receipt '.length))).filter(r => r.eventId === eventId);
    assert.equal(receipts.length, 1, 'Unique host completion required');
    const r = receipts[0];
    assert(r.nativeSlackDelivered && r.gatewayStopped && r.vm1Stopped);
    assert.equal(r.suspension.status, 'ready');
    assert.equal(r.suspension.activeCount, 0);
    assert.deepEqual(r.suspension.blockers, []);
    const deliveries = o.admissions.filter(a => a.type === 'delivered' && a.eventId === eventId);
    assert.equal(deliveries.length, 1);
    const reply = o.messages.find(m => m.ts === deliveries[0].messageId);
    assert.equal(reply?.user, fixture.bot);
    assert(reply.text.includes(fixture.value) && !reply.text.includes('Something went wrong'));
    assert(Number(reply.ts) > Number(input.ts));
    assert(o.observations.some(s => s.eyes), 'Eyes not observed');
    const last = o.observations.at(-1);
    assert.equal(last.status, 'stopped');
    assert.equal(last.eyes, false);
    assert.equal(o.snapshot?.status, 'created');
    assert.equal(o.snapshot.sourceSessionId, last.vmSession);
    assert.equal(o.snapshot.id, r.vm1SnapshotId);
    const worker = workers.find(w => w.name === r.workerName);
    assert(worker?.status === 'stopped' && worker.persistent === false, 'Worker stop not independently observed');
    const expectedHash = sha256(fixture.value + '\n');
    const file = o.observations.map(s => s.file).find(f => f?.sha256 === expectedHash && f.sessionId === r.sessionId && f.path === fixture.file);
    assert(file, 'Independent matching workspace-file read missing');
    if (test.role === 'write') {
      const absent = o.observations.findIndex(s => s.status === 'running' && s.vmSession === last.vmSession && s.fileAbsent === fixture.file);
      assert(absent >= 0 && o.observations.slice(absent + 1).some(s => s.status === 'running' && s.vmSession === last.vmSession && s.file?.sha256 === expectedHash && s.file?.sessionId === r.sessionId), 'Missing ordered absence-to-file observations in this VM session');
    }
    return { eventId, sessionId: r.sessionId, workerName: r.workerName, vmSession: last.vmSession, fileSha256: file.sha256, replyMs: Number(reply.ts) * 1000 - sentAt };
  });
  assert.equal(runs[0].sessionId, runs[1].sessionId);
  assert.notEqual(runs[0].eventId, runs[1].eventId);
  assert.notEqual(runs[0].workerName, runs[1].workerName);
  assert.notEqual(runs[0].vmSession, runs[1].vmSession);
  assert(Number(observations[fixture.cases[1].label].timestamp) * 1000 > observations[fixture.cases[0].label].observations.at(-1).at, 'Second turn must follow observed sleep');
  return runs;
}
