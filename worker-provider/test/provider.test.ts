import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerProviderError } from 'openclaw/plugin-sdk/plugin-entry';
import { AllocationJournal } from '../src/journal.ts';
import { controllerToken, createVercelWorkerProvider, type Box, type Client } from '../src/provider.ts';
import { allocationName, networkPolicy, OWNER, parseProfile, profileIntent } from '../src/profile.ts';

const profile = { gatewayOrigin: 'https://gateway.example.org', projectId: 'prj_test', teamId: 'team_test', timeoutMs: 1_800_000 };
const artifact = { url: `https://gateway.example.org/__openclaw__/worker-bootstrap/artifacts/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 100, token: 'bootstrap-secret', openclawVersion: '2026.9.2', enabledPluginIds: [] as string[] };
const enrollment = () => ({ mode: 'connect' as const, setupCode: 'join-secret', setupId: 'setup', displayName: 'fixture', openclawVersion: '2026.9.2', nodeBootstrap: artifact, waitForDeviceId: async () => 'device-1' });

function fixture() {
  const journal = new AllocationJournal(join(mkdtempSync(join(tmpdir(), 'ocw-provider-')), 'state.sqlite'));
  const calls = { create: 0, get: 0, bootstrap: 0, stop: 0, policies: [] as unknown[] };
  const box = {
    name: allocationName('operation'), status: 'running', persistent: false,
    tags: { owner: OWNER, intent: profileIntent(parseProfile(profile)) },
    async stop() { calls.stop++; box.status = 'stopped'; },
    async update(value: unknown) { calls.policies.push(value); },
  };
  const client: Client = {
    async create() { calls.create++; return box as unknown as Box; },
    async get() { calls.get++; return box as unknown as Box; },
  };
  const bootstrap = async () => { calls.bootstrap++; };
  const provider = createVercelWorkerProvider({ journal, client, bootstrap });
  return { journal, calls, box, client, provider, bootstrap };
}

test('bootstrap is submitted in one command without an upload or credentials in its arguments', async () => {
  const f = fixture();
  let invoked = false;
  Object.assign(f.box, {
    async writeFiles() { throw new Error('Separate bootstrap upload is unnecessary'); },
    async runCommand(options: { cmd: string; args: string[]; env: Record<string, string> }) {
      invoked = true;
      assert.equal(options.cmd, 'node');
      assert.deepEqual(options.args.slice(0, 2), ['--input-type=module', '--eval']);
      assert.equal(options.args[2], readFileSync(new URL('../assets/bootstrap.mjs', import.meta.url), 'utf8') + '\nawait runBootstrapCli();');
      assert(!options.args.join(' ').includes('join-secret'));
      assert(!options.args.join(' ').includes('bootstrap-secret'));
      assert.equal(JSON.parse(options.env.OC_WORKER_ENROLLMENT).setupCode, 'join-secret');
      return { exitCode: 0 };
    },
  });
  const provider = createVercelWorkerProvider({ journal: f.journal, client: f.client });
  try {
    const lease = await provider.provision(profile, 'operation', { executionMode: 'remote-exec', beginNodeEnrollment: async () => enrollment() });
    assert(invoked);
    assert.equal(lease.node?.deviceId, 'device-1');
    assert.deepEqual(f.calls.policies, [{ networkPolicy: networkPolicy(parseProfile(profile), false) }]);
  } finally { await provider.dispose(); f.journal.close(); }
});

for (const executionMode of ['worker-turn', 'remote-exec'] as const) test(`${executionMode} returns node identity only after enrollment and firewall lockdown`, async () => {
  const f = fixture();
  const events: string[] = [];
  const requestedEnrollment = enrollment();
  if (executionMode === 'remote-exec') requestedEnrollment.nodeBootstrap = { ...artifact, enabledPluginIds: ['codex'] };
  const provider = createVercelWorkerProvider({ journal: f.journal, client: f.client,
    bootstrap: async (...args) => { assert.equal(args[1], requestedEnrollment); events.push('bootstrap'); await f.bootstrap(); },
  });
  requestedEnrollment.waitForDeviceId = async () => { events.push('enrolled'); return 'device-1'; };
  const update = f.box.update;
  f.box.update = async value => { events.push('locked'); await update(value); };
  try {
    assert.deepEqual(provider.supportedExecutionModes, ['worker-turn', 'remote-exec']);
    const lease = await provider.provision(profile, 'operation', { executionMode, beginNodeEnrollment: async () => requestedEnrollment });
    assert.deepEqual(lease.node, { deviceId: 'device-1' });
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.bootstrap, 1);
    assert.deepEqual(f.calls.policies, [{ networkPolicy: networkPolicy(parseProfile(profile), false) }]);
    assert.equal(f.journal.get(lease.leaseId)?.phase, 'active');
    assert.deepEqual(events, ['bootstrap', 'enrolled', 'locked']);
  } finally { f.journal.close(); }
});

test('lost create response is adopted by exact identity without allocating again', async () => {
  const f = fixture();
  const original = f.client.create;
  f.client.create = async (...args) => { await original(...args); throw new Error('response lost'); };
  try {
    await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() }), /response lost/);
    const restarted = createVercelWorkerProvider({ journal: f.journal, client: f.client, bootstrap: f.bootstrap });
    await restarted.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() });
    assert.equal(f.calls.create, 1);
  } finally { f.journal.close(); }
});

test('ambiguous missing allocation remains unresolved and never creates a replacement', async () => {
  const f = fixture();
  f.client.create = async () => { f.calls.create++; throw new Error('response lost'); };
  f.client.get = async () => { throw new Error('not found or inaccessible'); };
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() }));
    assert.equal(f.calls.create, 1);
    await assert.rejects(f.provider.destroy({ leaseId: allocationName('operation'), profile }));
    assert.equal(f.journal.get(allocationName('operation'))?.phase, 'destroying');
  } finally { f.journal.close(); }
});

test('cleanup is idempotent, never resumes, and terminal operation ids cannot be reused', async () => {
  const f = fixture();
  try {
    const lease = await f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() });
    await f.provider.destroy({ leaseId: lease.leaseId, profile });
    await f.provider.destroy({ leaseId: lease.leaseId, profile });
    assert.equal(f.calls.stop, 1);
    await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() }), /retired/);
    assert.equal(f.calls.create, 1);
  } finally { f.journal.close(); }
});

test('ownership mismatch prevents setup and destructive cleanup', async () => {
  const f = fixture();
  f.box.tags.owner = 'somebody-else';
  try {
    await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() }), /ownership/);
    await assert.rejects(f.provider.destroy({ leaseId: f.box.name, profile }), /ownership/);
    assert.equal(f.calls.bootstrap, 0);
    assert.equal(f.calls.stop, 0);
  } finally { f.journal.close(); }
});

test('enrollment failure stops all guest processes; failed cleanup remains explicit', async () => {
  const f = fixture();
  f.box.stop = async () => { throw new Error('stop unavailable'); };
  try {
    await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => { throw new Error('enrollment failed'); } }), WorkerProviderError.isCleanupIndeterminate);
    assert.equal(f.journal.get(f.box.name)?.phase, 'destroying');
  } finally { f.journal.close(); }
});

test('denied modes, machine overrides, and aborted attempts do not allocate', async () => {
  const f = fixture();
  try {
    for (const executionMode of ['', 'unknown', null]) {
      // The public JavaScript boundary can receive values outside the SDK union.
      await assert.rejects(f.provider.provision(profile, 'operation', { executionMode: executionMode as 'worker-turn', beginNodeEnrollment: async () => enrollment() }));
    }
    await assert.rejects(f.provider.provision(profile, 'operation', { executionMode: 'remote-exec' }), /enrollment/);
    await assert.rejects(f.provider.provision(profile, 'operation', { machineClass: 'large', beginNodeEnrollment: async () => enrollment() }));
    await assert.rejects(f.provider.provision(profile, 'operation', { signal: AbortSignal.abort(), beginNodeEnrollment: async () => enrollment() }));
    assert.equal(f.calls.create, 0);
  } finally { f.journal.close(); }
});

for (const failure of ['bootstrap', 'lockdown', 'enrollment-cancelled'] as const) test(`remote execution does not return a lease after ${failure}`, async () => {
  const f = fixture();
  const controller = new AbortController();
  const provider = createVercelWorkerProvider({ journal: f.journal, client: f.client,
    bootstrap: async () => { if (failure === 'bootstrap') throw new Error('activation failed'); },
  });
  if (failure === 'lockdown') f.box.update = async () => { throw new Error('lockdown failed'); };
  try {
    await assert.rejects(provider.provision(profile, 'operation', { executionMode: 'remote-exec',
      beginNodeEnrollment: async () => ({ ...enrollment(), signal: controller.signal,
        waitForDeviceId: async () => { if (failure === 'enrollment-cancelled') controller.abort(); return 'device-1'; },
      }),
    }));
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.stop, 1);
    assert.equal(f.journal.get(f.box.name)?.phase, 'destroyed');
  } finally { f.journal.close(); }
});

test('bootstrap cannot send a credential to another origin', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => ({ ...enrollment(), nodeBootstrap: { ...artifact, url: `https://attacker.example.org/__openclaw__/worker-bootstrap/artifacts/${artifact.sha256}` } }) }), /approved gateway/);
    assert.equal(f.calls.bootstrap, 0);
    assert.equal(f.calls.stop, 1);
  } finally { f.journal.close(); }
});

test('active replay never reinstalls code in an agent-modified worker', async () => {
  const f = fixture();
  try {
    await f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => enrollment() });
    await f.provider.provision(profile, 'operation', { beginNodeEnrollment: async () => ({ ...enrollment(), mode: 'resume', deviceId: 'device-1' }) });
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.bootstrap, 1);
  } finally { f.journal.close(); }
});

test('profile rejects credentials, arbitrary setup, private origins, and unbounded lifetime', () => {
  for (const input of [{ ...profile, token: 'secret' }, { ...profile, setup: 'echo unsafe' }, { ...profile, gatewayOrigin: 'http://localhost' }, { ...profile, gatewayOrigin: 'https://127.0.0.1' }, { ...profile, timeoutMs: 86_400_001 }]) assert.throws(() => parseProfile(input));
  assert.equal(parseProfile({ ...profile, timeoutMs: 86_400_000 }).timeoutMs, 86_400_000);
  const locked = networkPolicy(parseProfile(profile), false);
  assert.deepEqual(locked, { allow: { 'gateway.example.org': [{ transform: [{ headers: { Host: 'gateway.example.org' } }] }] } });
});

test('resident provider reads rotated credentials per operation and never falls back from a missing credential file', () => {
  assert.equal(controllerToken({ VERCEL_OIDC_TOKEN: 'fresh' }), 'fresh');
  assert.throws(() => controllerToken({ OPENCLAW_HOST_CREDENTIALS_PATH: '/missing/host-credentials.json', VERCEL_OIDC_TOKEN: 'stale' }));
});

test('prebuilt workers require an immutable image and never open registry egress', () => {
  const workerImage = `openclaw-runtime@sha256:${'a'.repeat(64)}`;
  const parsed = parseProfile({ ...profile, workerImage });
  assert.equal(parsed.workerImage, workerImage);
  assert.deepEqual(networkPolicy(parsed, true), networkPolicy(parsed, false));
  assert.notEqual(profileIntent(parsed), profileIntent(parseProfile(profile)));
  for (const workerImage of ['openclaw:latest', 'openclaw', 'https://secret@host/image', 'image@sha256:bad']) {
    assert.throws(() => parseProfile({ ...profile, workerImage }), /image/i);
  }
});

test('snapshot-backed workers bind an immutable snapshot and have no registry egress', () => {
  const parsed = parseProfile({ ...profile, workerSnapshot: 'snap_verified123' });
  assert.equal(parsed.workerSnapshot, 'snap_verified123');
  assert.deepEqual(networkPolicy(parsed, true), networkPolicy(parsed, false));
  assert.notEqual(profileIntent(parsed), profileIntent(parseProfile(profile)));
  assert.throws(() => parseProfile({ ...profile, workerSnapshot: 'latest' }));
  assert.throws(() => parseProfile({ ...profile, workerSnapshot: 'snap_verified123', workerImage: `image@sha256:${'a'.repeat(64)}` }));
});
