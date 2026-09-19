import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { startIngress } from './e2e/gateway-services.mjs';
import { assertWorkerDenial } from './e2e/worker-probe.mjs';
import { registryAuthorization, authenticatedRegistryFetch } from './e2e/npm-auth.mjs';
import { networkPolicy, parseProfile } from '../src/profile.ts';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = createRequire(require.resolve('openclaw'))('ws');
const target = { environmentId: 'env-test', sessionId: 'session-test', runId: 'run-test', id: `e2e-authority-${'a'.repeat(32)}` };
const denial = { type: 'res', id: target.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'worker protocol request rejected', details: { reason: 'method-not-allowed' } } };

test('worker proof requires exact turn identity, admitted ownership, rejection and gateway closure', () => {
  const proof = { ...target, method: 'config.patch', admitted: true, heartbeatConfirmed: true, heartbeatResponseCount: 1, mutationSendCount: 1, responseCount: 1, response: denial, close: { code: 1008, reason: 'method-not-allowed' } };
  assertWorkerDenial(proof, target);
  for (const patch of [{ runId: 'old' }, { sessionId: 'other' }, { environmentId: 'other' }, { admitted: false }, { heartbeatConfirmed: false }, { responseCount: 2 }, { response: { ...denial, ok: true } }, { response: { ...denial, error: { ...denial.error, details: { reason: 'owner-epoch-mismatch' } } } }, { close: undefined }, { close: { code: 1008, reason: 'invalid-frame' } }]) assert.throws(() => assertWorkerDenial({ ...proof, ...patch }, target));
});

test('registry authentication stays scoped and disappears from steady-state worker egress', async () => {
  const registry = 'https://registry.example.org/npm/';
  const config = '//registry.npmjs.org/:_authToken=unrelated\n//registry.example.org/npm/:username=user\n//registry.example.org/npm/:_password=cGFzcw==';
  const auth = registryAuthorization(config, registry);
  assert.equal(auth, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  assert.equal(registryAuthorization(config, 'https://another.example.org/'), undefined);
  assert.equal(registryAuthorization('//registry.example.org/npm/:_authToken=${SCOPED}', registry, { SCOPED: 'token' }), 'Bearer token');
  let calls = 0;
  const fetcher = authenticatedRegistryFetch(registry, auth, async (_url, options) => { calls++; assert.equal(new Headers(options?.headers).get('authorization'), auth); assert.equal(options?.redirect, 'error'); return new Response('{}'); });
  await fetcher(`${registry}package`);
  for (const url of ['https://registry.example.org/elsewhere', 'https://another.example.org/npm/package', 'https://user@registry.example.org/npm/package']) assert.throws(() => fetcher(url));
  assert.equal(calls, 1);
  const profile = parseProfile({ gatewayOrigin: 'https://gateway.example.org', projectId: 'prj_test', teamId: 'team_test', npmRegistry: registry });
  const credential = { registry, authorization: auth! };
  const setup = networkPolicy(profile, true, credential);
  for (const npmRegistry of ['https://another.example.org/npm/', 'https://registry.example.org/elsewhere/', 'https://registry.example.org/']) {
    assert.throws(() => networkPolicy({ ...profile, npmRegistry }, true, credential), /scope mismatch/);
  }
  assert(JSON.stringify(setup).includes(auth!));
  assert.deepEqual((setup as any).allow['registry.example.org'][0].match, { path: { startsWith: '/npm/' }, method: ['GET', 'HEAD'] });
  assert(!JSON.stringify(networkPolicy(profile, false, credential)).includes(auth!));
  assert(!JSON.stringify(profile).includes(auth!));
  assert(!JSON.stringify(setup).includes('registry.npmjs.org'));
});

for (const mode of ['valid', 'wrong-hello', 'wrong-role', 'wrong-denial', 'duplicate', 'duplicate-heartbeat', 'wrong-close'] as const) test(`worker relay handles ${mode} without inventing admission or denial`, async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const identity = { environmentId: target.environmentId, sessionId: target.sessionId, ownerEpoch: 1, rpcSetVersion: 1 };
  const seen: string[] = [];
  wss.on('connection', (peer: any) => peer.on('message', (data: Buffer) => {
    const text = data.toString();
    seen.push(text);
    const frame = JSON.parse(text);
    if (frame.method === 'connect') peer.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { type: 'worker-hello-ok', ...identity, ...(mode === 'wrong-hello' ? { ownerEpoch: 2 } : {}), protocolFeatures: ['worker-heartbeat-v1'] } }));
    else if (frame.method === 'worker.heartbeat') {
      const response = JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { status: 'ok', ownerEpoch: 1, receivedAtMs: Date.now() } });
      peer.send(response);
      if (mode === 'duplicate-heartbeat') peer.send(response);
    }
    else if (frame.method === 'config.patch') {
      const frame = mode === 'wrong-denial' ? { ...denial, error: { ...denial.error, details: { reason: 'invalid-credential' } } } : denial;
      peer.send(JSON.stringify(frame));
      if (mode === 'duplicate') peer.send(JSON.stringify(frame));
      peer.close(1008, mode === 'wrong-close' ? 'invalid-frame' : 'method-not-allowed');
    } else peer.send(text);
  }));
  const ingress = await startIngress({ origin: 'https://gateway.example.org', upstreamPort: (server.address() as any).port, workerProbe: true });
  const client = new WebSocket(`ws://127.0.0.1:${ingress.port}/__openclaw__/worker`);
  const received: string[] = [];
  client.on('message', (data: Buffer) => received.push(data.toString()));
  try {
    await once(client, 'open');
    assert.throws(() => ingress.probe(target), /one live admitted/);
    const hello = once(client, 'message');
    const connect = JSON.stringify({ type: 'req', id: 'connect-id', method: 'connect', params: { role: mode === 'wrong-role' ? 'operator' : 'worker', admission: { ...identity, runId: target.runId, credential: 'never-save-this', handshake: { protocolFeatures: ['worker-heartbeat-v1'] } } } });
    client.send(connect);
    await hello;
    assert.equal(seen[0], connect);
    if (mode === 'wrong-role' || mode === 'wrong-hello') { assert.throws(() => ingress.probe(target), /one live admitted/); return; }
    const echoed = once(client, 'message');
    const opaque = '{ "type":"test", "nested":{"text":"bytes unchanged"}}';
    client.send(opaque);
    assert.equal((await echoed)[0].toString(), opaque);
    assert.throws(() => ingress.probe({ ...target, runId: 'old-run' }), /one live admitted/);
    const closed = once(client, 'close');
    const pending = ingress.probe(target);
    assert.throws(() => ingress.probe(target), /already pending/);
    if (mode === 'valid') {
      const proof = await pending;
      assertWorkerDenial(proof, target);
      assert(!JSON.stringify(proof).includes('never-save-this'));
    } else await assert.rejects(pending);
    const [code, reason] = await closed;
    assert.equal(seen.filter(text => JSON.parse(text).method === 'config.patch').length, 1);
    assert.equal(code, 1008);
    assert.equal(reason.toString(), mode === 'wrong-close' ? 'invalid-frame' : 'method-not-allowed');
    assert(received.every(text => !text.includes(target.id)));
    assert.throws(() => ingress.probe(target), /one live admitted/);
  } finally {
    client.terminate(); await ingress.close(); for (const peer of wss.clients) peer.terminate();
    await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
  }
});
