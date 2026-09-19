import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

export function createNodeProbeRelay() {
  const require = createRequire(import.meta.url);
  const { WebSocket, WebSocketServer } = createRequire(require.resolve('openclaw'))('ws');
  const server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  const records = new Set();
  const parse = bytes => { try { return JSON.parse(bytes.toString()); } catch { return null; } };
  const fail = record => {
    if (record.pending) { clearTimeout(record.pending.timer); record.pending.reject(new Error('Original node connection closed during probe')); record.pending = undefined; }
    records.delete(record);
    record.client.terminate(); record.upstream.terminate();
  };
  return {
    path: '/',
    upgrade(req, socket, head, upstreamPort, headers) {
      const forwarded = { ...headers };
      for (const name of Object.keys(forwarded)) if (name.toLowerCase().startsWith('sec-websocket-') || ['connection', 'upgrade'].includes(name.toLowerCase())) delete forwarded[name];
      server.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}/`, { headers: forwarded, perMessageDeflate: false, handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024 });
        const record = { client, upstream, admitted: false, nodeId: undefined, connectId: undefined, pending: undefined };
        records.add(record);
        const queue = [];
        let queuedBytes = 0;
        upstream.on('open', () => { for (const [bytes, binary] of queue) upstream.send(bytes, { binary }); queue.length = 0; });
        client.on('message', (bytes, binary) => {
          const frame = parse(bytes);
          if (frame?.type === 'req' && frame.method === 'connect' && frame.params?.role === 'node') {
            record.nodeId = frame.params.device?.id;
            record.connectId = frame.id;
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
          else if (upstream.readyState === WebSocket.CONNECTING && queue.length < 4 && (queuedBytes += bytes.length) < 65_536) queue.push([bytes, binary]);
          else fail(record);
        });
        upstream.on('message', (bytes, binary) => {
          const frame = parse(bytes);
          if (frame?.type === 'res' && frame.id === record.connectId && frame.ok === true && frame.payload?.type === 'hello-ok' && frame.payload.auth?.role === 'node') record.admitted = true;
          if (record.pending && frame?.type === 'res' && frame.id === record.pending.id) {
            const pending = record.pending;
            record.pending = undefined;
            clearTimeout(pending.timer);
            try {
              assert.equal(frame.ok, false);
              assert.equal(frame.error?.code, 'INVALID_REQUEST');
              assert.equal(frame.error?.message, 'unauthorized role: node');
              pending.resolve({ admitted: true, role: 'node', nodeId: record.nodeId, method: 'config.patch', denied: true, sameConnection: true });
            } catch { pending.reject(new Error('Expected node-role denial, not another failure')); }
            return;
          }
          if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
        });
        for (const peer of [client, upstream]) { peer.on('error', () => fail(record)); peer.on('close', () => fail(record)); }
      });
    },
    probe({ nodeId }) {
      const matches = [...records].filter(record => record.admitted && record.nodeId === nodeId && record.upstream.readyState === WebSocket.OPEN);
      assert.equal(matches.length, 1, 'Require the exact currently admitted node connection');
      const record = matches[0];
      assert(!record.pending);
      return new Promise((resolve, reject) => {
        const id = `e2e-node-${randomUUID()}`;
        const timer = setTimeout(() => { record.pending = undefined; reject(new Error('Node authorization response timed out')); }, 5000);
        record.pending = { id, resolve, reject, timer };
        record.upstream.send(JSON.stringify({ type: 'req', id, method: 'config.patch', params: { raw: '{"tools":{"elevated":{"enabled":true}}}', baseHash: '0'.repeat(64) } }));
      });
    },
    close() { for (const record of records) fail(record); server.close(); },
  };
}
