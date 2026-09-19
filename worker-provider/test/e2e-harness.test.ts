import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertCancellationAck, assertNativeReceipt, assertRetainedSnapshot, observablePolicy, Receipt, redact, REQUIRED, rpcResult, settings, stopOwned, testOperatorPairing, until } from './e2e/support.mjs';
import { completion, startModelFixture } from './e2e/model-fixture.mjs';
import { gatewayConfig } from './e2e/gateway-config.mjs';
import { startIngress } from './e2e/gateway-services.mjs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { verifyLockedDependencyAges } from './e2e/dependency-policy.mjs';

test('snapshot preparation requires a ready non-expiring checkpoint from the exact session', () => {
  const snapshot = { snapshotId: 'snap_test', status: 'created', sourceSessionId: 'session' };
  assertRetainedSnapshot(snapshot, 'session');
  for (const patch of [{ snapshotId: '' }, { status: 'deleted' }, { status: 'failed' }, { sourceSessionId: 'other' }, { expiresAt: new Date(Date.now() + 7 * 86400000) }]) {
    assert.throws(() => assertRetainedSnapshot({ ...snapshot, ...patch }, 'session'));
  }
});

test('a receipt cannot pass without the live admitted-worker RPC proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocw-rpc-proof-'));
  try {
    const receipt = new Receipt(join(dir, 'result'));
    for (const name of REQUIRED.filter(name => name !== 'admitted-worker-rpc')) receipt.check(name);
    assert.throws(() => receipt.finish());
    assert.deepEqual(receipt.data.missingAssertions, ['admitted-worker-rpc']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locked dependencies are age-checked even when npm ci would reuse their exact versions', async () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const lock = { packages: { 'node_modules/openclaw': { version: '2026.9.2', integrity: 'sha512-synthetic', resolved: 'https://registry.npmjs.org/openclaw/-/openclaw-2026.9.2.tgz' } } };
  const policy = { registry: 'https://registry.example.org/npm/', minReleaseAgeDays: 2, exclusions: [] as string[] };
  const fetcher: typeof fetch = async url => {
    assert.equal(String(url), 'https://registry.example.org/npm/openclaw');
    return new Response(JSON.stringify({ name: 'openclaw', time: { '2026.9.2': '2026-09-06T00:00:00Z' }, versions: { '2026.9.2': { dist: { integrity: 'sha512-synthetic' } } } }));
  };
  await assert.rejects(verifyLockedDependencyAges(lock, policy, fetcher, now), /age policy blocks/);
  const proof = await verifyLockedDependencyAges(lock, { ...policy, exclusions: ['openclaw'] }, fetcher, now);
  assert.equal(proof.checks.length, 1);
  assert.equal(proof.checks[0].exception, true);
  assert.equal(proof.sources.length, 1);
  await assert.rejects(verifyLockedDependencyAges(lock, { ...policy, exclusions: ['@openclaw/ai'] }, fetcher, now), /age policy blocks/);
  await assert.rejects(verifyLockedDependencyAges({ packages: {} }, policy, fetcher, now), /Missing/);
});

test('registry lockfiles may omit resolved URLs without skipping age or integrity checks', async () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const policy = { registry: 'https://registry.example.org/npm/', minReleaseAgeDays: 2, exclusions: [] };
  const entry = { version: '1.0.0', integrity: 'sha512-synthetic' };
  const lock = (patch = {}) => ({ packages: { 'node_modules/example': { ...entry, ...patch } } });
  const metadata = (publishedAt: string): typeof fetch => async url => {
    assert.equal(String(url), 'https://registry.example.org/npm/example');
    return new Response(JSON.stringify({ name: 'example', time: { '1.0.0': publishedAt }, versions: { '1.0.0': { dist: { integrity: entry.integrity } } } }));
  };
  const mature = metadata('2026-09-01T00:00:00Z');
  const proof = await verifyLockedDependencyAges(lock(), policy, mature, now);
  assert.equal(proof.checks.length, 1);
  assert.equal(proof.checks[0].exception, false);
  await assert.rejects(verifyLockedDependencyAges(lock(), policy, metadata('2026-09-06T00:00:00Z'), now), /age policy blocks/);
  await assert.rejects(verifyLockedDependencyAges(lock({ integrity: 'sha512-tampered' }), policy, mature, now), /integrity mismatch/);
  await assert.rejects(verifyLockedDependencyAges(lock({ resolved: 'https://unapproved.example/example.tgz' }), policy, mature, now), /bypasses selected registry/);
  await assert.rejects(verifyLockedDependencyAges(lock({ resolved: '' }), policy, mature, now));
  await assert.rejects(verifyLockedDependencyAges(lock({ link: true }), policy, mature, now), /Unverifiable/);
});

test('network readback hides transformation values but preserves the restricted shape', () => {
  const expected = { allow: { 'gateway.example.org': [{ transform: [{ headers: { Host: 'gateway.example.org' } }] }] } };
  assert.deepEqual(observablePolicy(expected), { allow: { 'gateway.example.org': [{ transform: [{ headers: { Host: '<redacted>' } }] }] } });
  assert.equal(expected.allow['gateway.example.org'][0].transform[0].headers.Host, 'gateway.example.org');
});

test('live dispatch checks the session policy with all expected transformations', () => {
  const runner = readFileSync(new URL('./e2e/run.mjs', import.meta.url), 'utf8');
  assert(runner.includes('assert.deepEqual(box.currentSession().networkPolicy, observablePolicy(networkPolicy(profile, false))'));
  assert(!runner.includes('assert.deepEqual(box.networkPolicy,'));
});

test('cancellation must acknowledge the requested run, never a no-op or unrelated run', () => {
  assertCancellationAck({ aborted: true, runIds: ['run'] }, 'run');
  for (const ack of [{ aborted: false, runIds: [] }, { aborted: true, runIds: ['another'] }, {}]) assert.throws(() => assertCancellationAck(ack, 'run'));
});

test('a receipt cannot pass when no lifecycle assertions ran', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocw-missing-'));
  try {
    const receipt = new Receipt(join(dir, 'result'));
    assert.throws(() => receipt.finish());
    assert.deepEqual(receipt.data.missingAssertions, REQUIRED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model smoke requires matching native evidence and confirmed cleanup', () => {
  const config = { projectId: 'prj_test', teamId: 'team_test' };
  const artifacts = { build: 'hash' };
  const receipt = { ...config, artifacts, mode: 'fixture', status: 'passed', resources: Array.from({ length: 3 }, () => ({ cleanup: 'stopped' })), assertions: REQUIRED.map(name => ({ name })) };
  assertNativeReceipt(receipt, config, artifacts);
  for (const patch of [{ status: 'failed' }, { mode: 'model' }, { projectId: 'prj_production' }, { resources: [] }, { assertions: [] }, { artifacts: {} }]) assert.throws(() => assertNativeReceipt({ ...receipt, ...patch }, config, artifacts));
});

test('RPC framing rejects missing or duplicate results', () => {
  assert.equal(rpcResult('startup log\nE2E_RPC_RESULT={"ok":true}\n').ok, true);
  assert.throws(() => rpcResult('{}'));
  assert.throws(() => rpcResult('E2E_RPC_RESULT={}\nE2E_RPC_RESULT={}'));
});

test('only the exact isolated read-only operator request may be paired', () => {
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const failure = { ok: false, code: 'NOT_PAIRED', message: `device pairing required (requestId: ${requestId})` };
  const pending = { requestId, deviceId: 'test-device', clientId: 'cli', role: 'operator', scopes: ['operator.read'] };
  assert.deepEqual(testOperatorPairing(failure, { pending: [pending] }), { requestId, deviceId: 'test-device' });
  for (const patch of [{ requestId: 'other' }, { clientId: 'other' }, { role: 'node' }, { scopes: ['operator.admin'] }]) assert.throws(() => testOperatorPairing(failure, { pending: [{ ...pending, ...patch }] }));
  assert.throws(() => testOperatorPairing(failure, { pending: [pending, pending] }));
  assert.throws(() => testOperatorPairing({ ...failure, code: 'INVALID_REQUEST' }, { pending: [pending] }));
});

test('gateway config isolates state, fixes authority, and routes both model modes through the bounded proxy', () => {
  for (const model of [undefined, 'vendor/model']) {
    const config = gatewayConfig({ origin: 'https://gateway.example.org', projectId: 'prj_test', teamId: 'team_test', model, npmRegistry: 'https://registry.example.org', npmAge: 2, npmExceptions: [] });
    assert.equal(config.gateway.bind, 'loopback');
    assert.deepEqual(config.gateway.trustedProxies, ['127.0.0.1', '::1']);
    assert.equal(config.tools.elevated.enabled, false);
    assert(!config.tools.allow.includes('gateway'));
    assert.equal(config.models.providers.e2e.baseUrl, 'http://127.0.0.1:4000/v1');
    assert.equal(config.models.providers.e2e.apiKey, '${E2E_MODEL_TOKEN}');
    assert.equal(config.cloudWorkers.profiles.vercel.settings.timeoutMs, 2_700_000);
  }
});

test('ingress preserves authorization and replaces spoofed forwarding headers', async () => {
  let observed: IncomingHttpHeaders | undefined;
  const upstream = createServer((req, res) => { observed = req.headers; res.end('upstream-ok'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const ingress = await startIngress({ origin: 'https://gateway.example.org', upstreamPort: (upstream.address() as any).port });
  try {
    const response = await fetch(`http://127.0.0.1:${ingress.port}/probe`, { headers: { authorization: 'Bearer synthetic', 'x-forwarded-for': 'spoofed', forwarded: 'for=spoofed', 'x-real-ip': 'spoofed' } });
    assert.equal(await response.text(), 'upstream-ok');
    assert(observed);
    assert.equal(observed.authorization, 'Bearer synthetic');
    assert.equal(observed.host, 'gateway.example.org');
    assert.equal(observed['x-forwarded-for'], '127.0.0.1');
    assert.equal(observed['x-forwarded-proto'], 'https');
    assert.equal(observed.forwarded, undefined);
    assert.equal(observed['x-real-ip'], undefined);
  } finally { await ingress.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('ingress transparently forwards upgrade bytes and closes both peers', async () => {
  const upstream = createServer();
  const sockets = new Set<any>();
  upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', bytes => socket.write(bytes));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const ingress = await startIngress({ origin: 'https://gateway.example.org', upstreamPort: (upstream.address() as any).port });
  const client = connect(ingress.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade timeout')), 2000);
      let data = '';
      client.on('error', reject);
      client.on('data', chunk => { data += chunk; if (data.includes('native-payload')) { clearTimeout(timer); resolve(); } });
      client.write('GET / HTTP/1.1\r\nHost: gateway.example.org\r\nAuthorization: Bearer synthetic\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nnative-payload');
    });
  } finally {
    client.destroy();
    await ingress.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

const base = { OPENCLAW_E2E_RUN: '1', VERCEL_TOKEN: 'synthetic-token', VERCEL_TEAM_ID: 'team_test', VERCEL_PROJECT_ID: 'prj_test', OPENCLAW_E2E_PROJECT_NAME: 'test-project', OPENCLAW_E2E_RESULTS_DIR: '/tmp/synthetic-e2e' };

test('E2E requires opt-in, explicit project, credentials and a private results location', () => {
  for (const key of Object.keys(base)) assert.throws(() => settings({ ...base, [key]: '' }));
  assert.equal(settings(base).projectId, 'prj_test');
  assert.throws(() => settings({ ...base, OPENCLAW_E2E_RESULTS_DIR: './results' }));
  assert.throws(() => settings({ ...base, OPENCLAW_E2E_NPM_MIN_AGE: '0' }));
  assert.throws(() => settings({ ...base, OPENCLAW_E2E_NPM_EXCEPTIONS: '*' }));
});

test('OIDC must match the target and remain valid throughout the bounded run', () => {
  const jwt = (patch = {}) => `header.${Buffer.from(JSON.stringify({ project_id: 'prj_test', owner_id: 'team_test', project: 'test-project', exp: 6000, ...patch })).toString('base64url')}.signature`;
  const env = { ...base, VERCEL_TOKEN: '', VERCEL_OIDC_TOKEN: jwt() };
  assert.equal(settings(env, 'fixture', 0).projectName, 'test-project');
  for (const patch of [{ exp: 1 }, { project_id: 'prj_wrong' }, { owner_id: 'team_wrong' }, { project: 'production' }]) assert.throws(() => settings({ ...env, VERCEL_OIDC_TOKEN: jwt(patch) }, 'fixture', 0));
});

test('live-model mode has no silent fixture fallback', () => {
  assert.throws(() => settings(base, 'model'));
  assert.throws(() => settings({ ...base, AI_GATEWAY_API_KEY: 'synthetic' }, 'model'));
  assert.equal(settings({ ...base, AI_GATEWAY_API_KEY: 'synthetic', OPENCLAW_E2E_MODEL: 'vendor/model' }, 'model').mode, 'model');
});

test('logs redact secrets, bearer tokens and JWTs before persistence', () => {
  const output = redact('custom-value Bearer abc.secret token=private apiKey="hidden" eyJhbGciOiJIUzI1NiJ9.payload.signature', ['custom-value']);
  for (const value of ['custom-value', 'abc.secret', 'private', 'hidden', 'eyJhb']) assert(!output.includes(value));
});

test('a resource without confirmed cleanup cannot produce a passing receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocw-e2e-'));
  try {
    const receipt = new Receipt(join(dir, 'result'));
    receipt.intent('box', { owner: 'fixture' });
    assert.throws(() => receipt.finish());
    assert.equal(JSON.parse(readFileSync(join(dir, 'result/receipt.json'), 'utf8')).status, 'failed');
    assert.throws(() => new Receipt(join(dir, 'result')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup checks ownership, disables resume, and treats missing resources as unresolved', async () => {
  const record = { name: 'test-box', tags: { owner: 'fixture' }, cleanup: 'unconfirmed' };
  let stops = 0;
  const box = { name: record.name, tags: record.tags, persistent: false, status: 'running', async stop() { stops++; this.status = 'stopped'; } };
  const api = { async get(input: { resume: boolean }) { assert.equal(input.resume, false); return box; } };
  await stopOwned(api, {}, record);
  assert.equal(record.cleanup, 'stopped');
  assert.equal(stops, 1);
  await assert.rejects(stopOwned({ get: async () => ({ ...box, tags: { owner: 'other' } }) }, {}, record), /ownership/);
  await assert.rejects(stopOwned({ get: async () => { throw new Error('404'); } }, {}, record), /404/);
});

test('waits are bounded and cancellation is propagated', async () => {
  await assert.rejects(until(async () => false, { timeout: 2, interval: 1 }), /Timed out/);
  await assert.rejects(until(async () => true, { signal: AbortSignal.abort() }));
});

test('fixture requires native exec and requests an actual command before completing', () => {
  const payload = { messages: [{ role: 'user', content: 'E2E_CASE=success' }], tools: [{ function: { name: 'exec' } }] };
  const call = completion(payload);
  assert.equal(call.reason, 'tool_calls');
  assert(call.delta.tool_calls);
  assert.equal(JSON.parse(call.delta.tool_calls[0].function.arguments).command, 'node e2e-task.mjs success');
  assert.equal(JSON.parse(call.delta.tool_calls[0].function.arguments).yieldMs, 120000);
  assert.throws(() => completion({ ...payload, tools: [] }), /exec/);
  assert.equal(completion({ ...payload, messages: [...payload.messages, { role: 'tool', content: 'done' }] }).reason, 'stop');
});

test('fixture exercises authenticated streaming HTTP without cloud resources', async () => {
  const fixture = await startModelFixture({ token: 'synthetic-fixture' });
  try {
    const url = `http://127.0.0.1:${fixture.port}/v1/chat/completions`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-fixture' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'E2E_CASE=success' }], tools: [{ function: { name: 'exec' } }] }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /tool_calls/);
    assert.match(stream, /data: \[DONE\]/);
    assert.equal(fixture.count(), 1);
  } finally { await fixture.close(); }
});

test('real-model proxy caps calls, input size and output tokens without changing credentials or model', async () => {
  let calls = 0;
  const fixture = await startModelFixture({ token: 'local-token', upstream: { model: 'vendor/model', token: 'upstream-token' }, fetchUpstream: async (url, options) => {
    calls++;
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
    assert(options && typeof options.body === 'string');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer upstream-token');
    const payload = JSON.parse(options.body);
    assert.equal(payload.max_tokens, 1024);
    assert.equal(payload.max_completion_tokens, undefined);
    assert.equal(payload.n, 1);
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const request = (payload: Record<string, unknown>) => fetch(`http://127.0.0.1:${fixture.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-token' }, body: JSON.stringify(payload) });
    assert.equal((await request({ model: 'vendor/model', messages: [{ content: 'x'.repeat(66000) }] })).status, 400);
    assert.equal(calls, 0);
    for (let i = 0; i < 4; i++) assert.equal((await request({ model: 'vendor/model', max_tokens: 9000, max_completion_tokens: 10000, n: 4 })).status, 200);
    assert.equal((await request({ model: 'vendor/model' })).status, 400);
    assert.equal(calls, 4);
  } finally { await fixture.close(); }
});
