import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { startIngress } from './e2e/gateway-services.mjs';
import { createNodeProbeRelay } from './codex-e2e/node-relay.mjs';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = createRequire(require.resolve('openclaw'))('ws');
for (const mode of ['valid', 'wrong-role', 'wrong-denial', 'disconnect'] as const) test(`node denial probe preserves the original connection: ${mode}`, async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let connections = 0, mutations = 0;
  wss.on('connection', (peer: any) => {
    connections++;
    peer.on('message', (bytes: Buffer) => {
      const frame = JSON.parse(bytes.toString());
      if (frame.method === 'connect') peer.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', auth: { role: mode === 'wrong-role' ? 'operator' : 'node' } } }));
      else if (frame.method === 'config.patch') {
        mutations++;
        if (mode === 'disconnect') { peer.close(); return; }
        peer.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: mode === 'wrong-denial' ? 'config syntax error' : 'unauthorized role: node' } }));
      } else peer.send(bytes);
    });
  });
  const ingress = await startIngress({ origin: 'https://gateway.example.org', upstreamPort: (server.address() as any).port, upgradeRelay: createNodeProbeRelay() });
  const client = new WebSocket(`ws://127.0.0.1:${ingress.port}/`);
  try {
    await once(client, 'open');
    assert.throws(() => ingress.probe({ nodeId: 'node' }), /currently admitted/);
    const hello = once(client, 'message');
    client.send(JSON.stringify({ type: 'req', id: 'hello', method: 'connect', params: { role: 'node', device: { id: 'node' }, auth: { deviceToken: 'never-log-this' } } }));
    await hello;
    if (mode === 'wrong-role') { assert.throws(() => ingress.probe({ nodeId: 'node' }), /currently admitted/); return; }
    assert.throws(() => ingress.probe({ nodeId: 'another' }), /currently admitted/);
    const probe = ingress.probe({ nodeId: 'node' });
    if (mode === 'valid') {
      const result = await probe;
      assert.deepEqual(result, { admitted: true, role: 'node', nodeId: 'node', method: 'config.patch', denied: true, sameConnection: true });
      assert(!JSON.stringify(result).includes('never-log-this'));
      const echo = once(client, 'message');
      client.send('{ "method":"echo","opaque":"unchanged" }');
      assert.equal((await echo)[0].toString(), '{ "method":"echo","opaque":"unchanged" }');
      assert.equal(connections, 1);
    } else await assert.rejects(probe);
    assert.equal(mutations, 1);
  } finally {
    client.terminate(); await ingress.close(); for (const peer of wss.clients) peer.terminate();
    await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
  }
});
