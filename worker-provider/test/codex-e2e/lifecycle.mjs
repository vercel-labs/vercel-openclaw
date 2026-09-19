import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Sandbox } from '@vercel/sandbox';
import lifecycle from '../../../host/lib/codex-lifecycle.ts';
import { parseProfile, profileIntent, OWNER } from '../../dist/profile.js';
import { hash, settings, redact } from '../e2e/support.mjs';
import { lifecycleFixture } from './lifecycle-fixture.mjs';

const { CODEX_BASE, CODEX_OWNER, runCodexLifecycle } = lifecycle;

export async function testPersistentLifecycle() {
  assert(!process.env.VERCEL_TOKEN, 'This host test requires project OIDC');
  const config = settings(process.env, 'model');
  const name = process.env.OPENCLAW_CODEX_SANDBOX_NAME;
  const runtimeDigest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST;
  assert(name && runtimeDigest?.match(/^[a-f0-9]{64}$/), 'Prepared sandbox name and runtime digest required');
  assert(process.env.OPENCLAW_GATEWAY_TOKEN, 'Explicit test gateway credential required');
  mkdirSync(config.results, { mode: 0o700 });
  const fixture = lifecycleFixture();
  const sessionKey = `agent:main:slack-C${randomBytes(6).toString('hex').toUpperCase()}`;
  const evidence = { at: new Date().toISOString(), name, runtimeDigest, status: 'running', runs: [], fileReadbacks: [], replies: [],
    projectId: config.projectId, teamId: config.teamId, nicknameHash: hash(fixture.nickname), fileContentHash: hash(fixture.fileContent),
    driverHash: hash(readFileSync(new URL(import.meta.url))), fixtureHash: hash(readFileSync(new URL('./lifecycle-fixture.mjs', import.meta.url))),
    hostHash: hash(readFileSync(new URL('../../../host/lib/codex-lifecycle.ts', import.meta.url))),
    boundary: 'Real host lifecycle and VMs; Connect/Slack delivery NOT_TESTED' };
  const get = target => Sandbox.get({ ...config.credentials, name: target, resume: false, signal: AbortSignal.timeout(10_000) });
  const assertOwned = box => {
    assert.equal(box.persistent, true);
    assert.equal(box.tags?.owner, CODEX_OWNER);
    assert.equal(box.tags?.runtime, runtimeDigest);
  };
  let owned = false;
  let intent;
  const discoverIntent = async box => {
    const bytes = await box.readFileToBuffer({ path: `${CODEX_BASE}/runtime-manifest.json` });
    assert(bytes && hash(bytes) === runtimeDigest, 'Runtime manifest changed');
    const manifest = JSON.parse(bytes.toString());
    assert.equal(manifest.config.model, config.model, 'Prepared runtime model differs from the test');
    return profileIntent(parseProfile({ gatewayOrigin: box.domain(3000), projectId: config.projectId, teamId: config.teamId,
      npmRegistry: manifest.config.npmRegistry, npmMinReleaseAgeDays: manifest.config.npmAge }));
  };
  try {
    const initial = await get(name);
    assertOwned(initial);
    assert.equal(initial.status, 'stopped');
    owned = true;
    const initialSession = initial.currentSession().sessionId;
    assert(initialSession, 'Missing platform session identity');
    for (const [index, message] of fixture.messages.entries()) {
      assert.equal((await get(name)).status, 'stopped');
      const start = Date.now();
      process.stdout.write(`STEP lifecycle turn ${index + 1}\n`);
      const result = await runCodexLifecycle({ name, sessionKey, eventId: `Ev${randomBytes(12).toString('hex')}`, message, oidcToken: config.token,
        publish: async reply => {
          evidence.replies.push({ index, hash: hash(reply), recallsNickname: reply.includes(fixture.nickname), includesFile: reply.includes(fixture.fileContent) });
          fixture.assertReply(reply, index);
          const awake = await get(name);
          assertOwned(awake);
          assert.equal(awake.status, 'running', 'Reply must precede VM1 stop');
          intent = await discoverIntent(awake);
          const savedBytes = await awake.readFileToBuffer({ path: `${CODEX_BASE}/sessions/${hash(sessionKey.toLowerCase())}.json` });
          assert(savedBytes, 'Missing host session ownership');
          const saved = JSON.parse(savedBytes.toString());
          const file = await awake.readFileToBuffer({ path: `${saved.worktree.path}/persisted.txt` });
          assert(file && file.toString().trim() === fixture.fileContent, 'Accepted VM1 file differs');
          evidence.fileReadbacks.push(hash(file));
        },
      });
      const stopped = await get(name);
      assert.equal(stopped.status, 'stopped');
      assert.equal((await get(result.workerName)).status, 'stopped');
      const vmSession = stopped.currentSession().sessionId;
      assert(vmSession, 'Missing platform session identity');
      evidence.runs.push({ ...result, reply: undefined, replyHash: hash(result.reply), vmSession, durationMs: Date.now() - start });
    }
    assert.equal(evidence.runs[0].sessionId, evidence.runs[1].sessionId);
    assert.notEqual(initialSession, evidence.runs[0].vmSession);
    assert.notEqual(evidence.runs[0].vmSession, evidence.runs[1].vmSession);
    assert.notEqual(evidence.runs[0].workerName, evidence.runs[1].workerName);
    assert.equal(evidence.fileReadbacks[0], evidence.fileReadbacks[1]);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = redact(error.message, [config.token, config.modelKey, process.env.OPENCLAW_GATEWAY_TOKEN, process.env.OPENCLAW_NPM_AUTHORIZATION]);
  } finally {
    try {
      if (owned) {
        const box = await get(name);
        assertOwned(box);
        if (box.status !== 'stopped') {
          try { intent = await discoverIntent(box); }
          finally { await box.stop({ signal: AbortSignal.timeout(20_000) }); }
        }
        if (intent) for await (const worker of await Sandbox.list({ ...config.credentials, tags: { intent } })) {
          assert.equal(worker.tags.owner, OWNER);
          assert.equal(worker.persistent, false);
          if (worker.status !== 'stopped') await worker.stop({ signal: AbortSignal.timeout(20_000) });
          assert.equal((await get(worker.name)).status, 'stopped');
        }
        assert.equal((await get(name)).status, 'stopped');
        evidence.cleanup = 'stopped';
      }
    } catch {
      evidence.status = 'failed';
      evidence.cleanup = 'unconfirmed; inspect owned resources';
    }
    writeFileSync(`${config.results}/receipt.json`, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  }
  assert.equal(evidence.status, 'passed', `Lifecycle failed; inspect private receipt in ${config.results}`);
  process.stdout.write('CODEX_PERSISTENT_LIFECYCLE_PASS\n');
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  testPersistentLifecycle().catch(() => { process.stderr.write('Lifecycle failed; inspect private results\n'); process.exitCode = 1; });
}
