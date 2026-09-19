import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { settings, redact } from './e2e/support.mjs';
import { nativeSlackPrompt, sha256, verifyNativeSlack } from './native-slack-proof.mjs';
import { verifyNativeIdle } from './native-idle-proof.mjs';

const requireHost = createRequire(new URL('../../host/package.json', import.meta.url));
const { getToken } = requireHost('@vercel/connect');
const base = '/tmp/openclaw-codex-e2e';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const [command, label] = process.argv.slice(2);
let token;
try {
  assert(['observe', 'verify', 'idle'].includes(command), 'Use observe <case>, idle, or verify');
  const config = settings(process.env);
  const root = config.results;
  const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const save = (name, data) => writeFileSync(join(root, name), redact(JSON.stringify(data, null, 2), [config.token, token]), { mode: 0o600 });
  const fixture = read('fixture.json');
  const idleMode = fixture.mode === 'idle';
  assert(/^[CG][A-Z0-9]+$/.test(fixture.channel));
  assert(/^[UW][A-Z0-9]+$/.test(fixture.user) && /^[UW][A-Z0-9]+$/.test(fixture.bot));
  assert(/^\d+\.\d+$/.test(fixture.thread));
  assert(/^[a-z0-9-]+\.txt$/.test(fixture.file));
  assert(/^[a-z]+-[0-9]+$/.test(fixture.value));
  assert(fixture.senderAttributionUser === undefined || /^U[A-Z0-9]+$/.test(fixture.senderAttributionUser), 'Invalid explicit sending-app identity');
  const name = process.env.OPENCLAW_CODEX_SANDBOX_NAME;
  const runtimeDigest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST;
  assert(name && /^[a-f0-9]{64}$/.test(runtimeDigest ?? ''));
  const getBox = async n => Sandbox.get({ ...config.credentials, name: n, resume: false, signal: AbortSignal.timeout(10000) });
  const owned = async () => {
    const box = await getBox(name);
    assert.equal(box.tags.owner, 'openclaw-connect-codex-v1');
    assert.equal(box.tags.runtime, runtimeDigest);
    return box;
  };
  if (command === 'idle') {
    assert(idleMode, 'Idle fixture required');
    const initial = await owned();
    assert.equal(initial.status, 'running');
    const result = { observations: [] };
    const warm = read('observe-warm.json');
    const workerName = warm.observations.at(-1).worker.name;
    const startedAt = Date.now();
    writeFileSync(join(root, 'idle.json'), '{}', { flag: 'wx', mode: 0o600 });
    while (Date.now() - startedAt < 55 * 60_000) {
      const box = await owned();
      assert.equal(box.currentSession().sessionId, initial.currentSession().sessionId, 'VM woke before idle observation completed');
      result.observations.push({ at: Date.now(), status: box.status, vmSession: box.currentSession().sessionId });
      if (box.status === 'stopped') {
        const snapshot = await Snapshot.get({ ...config.credentials, snapshotId: box.currentSnapshotId });
        const worker = await getBox(workerName);
        result.snapshot = { id: box.currentSnapshotId, status: snapshot.status, sourceSessionId: snapshot.sourceSessionId };
        result.worker = { name: worker.name, status: worker.status };
        save('idle.json', result);
        assert.equal(snapshot.status, 'created');
        assert.equal(snapshot.sourceSessionId, initial.currentSession().sessionId);
        assert.equal(worker.status, 'stopped');
        break;
      }
      save('idle.json', result);
      await sleep(3000);
    }
    assert(result.snapshot, 'Idle sleep not observed');
    console.log('IDLE_SLEEP_OBSERVED');
  } else if (command === 'verify') {
    const observations = Object.fromEntries(fixture.cases.map(c => [c.label, read(`observe-${c.label}.json`)]));
    const logs = readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).flatMap(r => r.logs ?? [r]);
    const eventIds = new Set(Object.values(observations).flatMap(o => o.admissions.filter(a => a.type === 'admitted' && a.at >= Number(o.timestamp) * 1000).map(a => a.eventId)));
    const receipts = logs.filter(l => l.message?.startsWith('codex lifecycle receipt ')).map(l => JSON.parse(l.message.slice('codex lifecycle receipt '.length))).filter(r => eventIds.has(r.eventId));
    const workers = [];
    for (const n of new Set(receipts.map(r => r.workerName))) {
      assert(/^ocw-[a-f0-9]{40}$/.test(n), 'Unexpected worker name');
      const box = await getBox(n);
      workers.push({ name: n, status: box.status, persistent: box.persistent });
    }
    if (!idleMode) assert.equal((await owned()).status, 'stopped');
    const runs = idleMode ? verifyNativeIdle({ fixture, observations, logs, idle: read('idle.json'), runtimeDigest }) : verifyNativeSlack({ fixture, observations, logs, workers, runtimeDigest });
    save('receipt.json', { status: 'passed', at: new Date().toISOString(), runtimeDigest, runs, workers,
      inputs: Object.fromEntries(['fixture.json', 'requests.jsonl', ...(idleMode ? ['idle.json'] : []), ...fixture.cases.map(c => `observe-${c.label}.json`)].map(p => [p, sha256(readFileSync(join(root, p)))])),
      verifierSha256: sha256(readFileSync(new URL(idleMode ? './native-idle-proof.mjs' : './native-slack-proof.mjs', import.meta.url))),
      notTested: ['OAuth expiry', 'cross-thread memory', 'crash recovery', 'adversarial isolation', 'Slack UI paint time'] });
    console.log(idleMode ? 'NATIVE_SLACK_WARM_IDLE_WAKE_PASS' : 'NATIVE_SLACK_TWO_TURN_SLEEP_WAKE_PASS');
    console.log(JSON.stringify(runs.map(({ replyMs }) => ({ replyMs }))));
  } else {
    const test = fixture.cases.find(c => c.label === label);
    assert(test && ['write', 'read'].includes(test.role));
    assert(!process.env.VERCEL_TOKEN, 'Connect test requires project OIDC');
    const policy = JSON.parse(process.env.OPENCLAW_NATIVE_SLACK_CONFIG ?? 'null');
    assert(policy?.channels.includes(fixture.channel) && policy.users.includes(fixture.user), 'Test outside explicit native allowlist');
    assert.equal((await owned()).status, idleMode && label === 'warm' ? 'running' : 'stopped', 'Unexpected initial VM1 state');
    const destination = join(root, `observe-${label}.json`);
    // Reserve evidence before arming; never overwrite an earlier observation.
    writeFileSync(destination, '{}', { flag: 'wx', mode: 0o600 });
    assert(process.env.SLACK_CONNECTOR, 'SLACK_CONNECTOR required');
    token = await getToken(process.env.SLACK_CONNECTOR, { subject: { type: 'app' }, scopes: ['channels:history', 'reactions:read'] }, { vercelToken: config.token });
    const messages = async () => {
      const url = new URL('https://slack.com/api/conversations.replies');
      url.search = new URLSearchParams({ channel: fixture.channel, ts: fixture.thread, limit: '100' }).toString();
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      assert(response.status !== 429, `Slack rate limit; wait ${response.headers.get('retry-after') ?? '60'} seconds before a new test`);
      assert(response.ok, 'Slack HTTP error');
      const body = await response.json();
      assert(body.ok, `Slack: ${body.error}`);
      assert(!body.has_more && !body.response_metadata?.next_cursor, 'Use a fresh, short test thread');
      return body.messages.map(({ ts, user, text, reactions }) => ({ ts, user, text, reactions }));
    };
    await messages();
    const armedAt = Date.now();
    const result = { runtimeDigest, thread: fixture.thread, timestamp: null, admissions: [], observations: [] };
    console.log('OBSERVER_ARMED');
    console.log(nativeSlackPrompt(fixture, test.role));
    let seen = false;
    while (Date.now() < armedAt + 360000) {
      result.messages = await messages();
      const inputs = result.messages.filter(m => m.user === fixture.user && Number(m.ts) * 1000 > armedAt && m.text?.includes(`<@${fixture.bot}>`));
      assert(inputs.length <= 1, 'Concurrent test mentions; use one per observation');
      if (inputs[0]) result.timestamp = inputs[0].ts;
      const box = await owned();
      const session = box.currentSession();
      const item = { at: Date.now(), status: box.status, vmSession: session.sessionId, eyes: Boolean(inputs[0]?.reactions?.some(r => r.name === 'eyes' && r.users?.includes(fixture.bot))) };
      if (box.status === 'running' && result.timestamp) {
        seen = true;
        // Session-scoped reads fail after sleep; sandbox-level reads could wake it.
        try {
          const b = await session.readFileToBuffer({ path: `${base}/host-admission.json.events` }, { signal: AbortSignal.timeout(2500) });
          if (b) result.admissions = b.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
        } catch {}
        if (idleMode) try {
          const runtime = JSON.parse(await session.readFileToBuffer({ path: `${base}/host-last-result.json` }, { signal: AbortSignal.timeout(2500) }));
          const worker = await getBox(runtime.workerName);
          assert(worker.tags?.owner === 'openclaw-vercel-worker-v1' && worker.persistent === false);
          item.worker = { name: worker.name, status: worker.status, persistent: worker.persistent };
          if (worker.status === 'running') {
            const path = resolve(runtime.workerWorkspace, fixture.file);
            assert(path.startsWith(runtime.workerWorkspace + '/'));
            const bytes = await worker.currentSession().readFileToBuffer({ path }, { signal: AbortSignal.timeout(2500) });
            if (bytes) item.worker.fileSha256 = sha256(bytes);
          }
        } catch {}
        try {
          const key = `agent:main:slack:channel:${fixture.channel.toLowerCase()}:thread:${fixture.thread}`;
          const state = JSON.parse(await session.readFileToBuffer({ path: `${base}/sessions/${sha256(key)}.json` }, { signal: AbortSignal.timeout(2500) }));
          const path = resolve(state.worktree.path, fixture.file);
          assert(path.startsWith(base + '/'));
          const b = await session.readFileToBuffer({ path }, { signal: AbortSignal.timeout(2500) });
          if (b) item.file = { path: fixture.file, sessionId: state.sessionId, sha256: sha256(b) };
          else if (b === null) item.fileAbsent = fixture.file;
        } catch {}
      }
      result.observations.push(item);
      save(`observe-${label}.json`, result);
      if (idleMode && seen && item.worker?.fileSha256 && !item.eyes && result.admissions.some(a => a.type === 'delivered' && a.at >= Number(result.timestamp) * 1000)) break;
      if (seen && box.status === 'stopped' && !item.eyes) {
        const snapshot = await Snapshot.get({ ...config.credentials, snapshotId: box.currentSnapshotId, signal: AbortSignal.timeout(10000) });
        if (snapshot.status === 'created' && snapshot.sourceSessionId === item.vmSession) {
          result.snapshot = { id: box.currentSnapshotId, status: snapshot.status, sourceSessionId: snapshot.sourceSessionId };
          save(`observe-${label}.json`, result);
          break;
        }
      }
      await sleep(3000);
    }
    if (idleMode) assert(result.observations.at(-1).worker?.fileSha256 && !result.observations.at(-1).eyes, 'Warm reply and file not observed');
    else assert(result.snapshot, 'Timed out without current-session snapshot; inspect host logs, do not assume cleanup');
    console.log(`OBSERVATION_COMPLETE ${label}`);
  }
} catch (error) {
  console.error(redact(error.message, [process.env.VERCEL_OIDC_TOKEN, process.env.VERCEL_TOKEN, token]));
  process.exitCode = 1;
}
