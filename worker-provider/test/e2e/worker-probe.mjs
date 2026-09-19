import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const WORKER_PATH = '/__openclaw__/worker';
const identity = value => Object.fromEntries(['environmentId', 'sessionId', 'ownerEpoch', 'rpcSetVersion'].map(key => [key, value[key]]));
const parse = data => { try { return JSON.parse(data.toString()); } catch { return null; } };

export function assertWorkerDenial(proof, expected) {
  assert.equal(proof.environmentId, expected.environmentId);
  assert.equal(proof.sessionId, expected.sessionId);
  assert.equal(proof.runId, expected.runId);
  assert.equal(proof.id, expected.id);
  assert.equal(proof.method, 'config.patch');
  assert.equal(proof.admitted, true);
  assert.equal(proof.heartbeatConfirmed, true);
  assert.equal(proof.heartbeatResponseCount, 1);
  assert.equal(proof.mutationSendCount, 1);
  assert.equal(proof.responseCount, 1);
  assert.deepEqual(proof.response, { type: 'res', id: expected.id, ok: false, error: {
    code: 'INVALID_REQUEST', message: 'worker protocol request rejected', details: { reason: 'method-not-allowed' },
  } });
  assert.deepEqual(proof.close, { code: 1008, reason: 'method-not-allowed' });
}

export async function createWorkerRelay() {
  const require = createRequire(import.meta.url);
  const { WebSocket, WebSocketServer } = createRequire(require.resolve('openclaw'))('ws');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024, perMessageDeflate: false });
  const connections = new Set();
  const finish = (record, error) => {
    if (!record.pending) return;
    const pending = record.pending;
    record.pending = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else {
      try { assertWorkerDenial(pending.proof, pending.proof); pending.resolve(pending.proof); }
      catch (failure) { pending.reject(failure); }
    }
  };
  const closePeer = (peer, code, reason) => {
    if (peer.readyState !== WebSocket.OPEN) { peer.terminate(); return; }
    if (code === 1006 || code === 1005 || code === 1015) peer.terminate();
    else peer.close(code, reason);
  };
  return {
    upgrade(req, socket, head, upstreamPort, headers) {
      if (connections.size >= 8) { socket.destroy(); return; }
      const forwarded = { ...headers };
      for (const name of Object.keys(forwarded)) if (name.toLowerCase().startsWith('sec-websocket-') || ['connection', 'upgrade'].includes(name.toLowerCase())) delete forwarded[name];
      wss.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${WORKER_PATH}`, { headers: forwarded, perMessageDeflate: false, maxPayload: 25 * 1024 * 1024, handshakeTimeout: 10_000 });
        const record = { client, upstream, admitted: false, connect: undefined, pending: undefined };
        connections.add(record);
        const queue = [];
        let queuedBytes = 0;
        upstream.on('open', () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
        client.on('message', (data, binary) => {
          const frame = parse(data);
          if (frame?.type === 'req' && frame.method === 'connect' && frame.params?.role === 'worker' && frame.params.admission) {
            if (record.connect) { client.terminate(); upstream.terminate(); return; }
            record.connect = { id: frame.id, runId: frame.params.admission.runId, features: frame.params.admission.handshake?.protocolFeatures, ...identity(frame.params.admission) };
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else if (upstream.readyState === WebSocket.CONNECTING && (queuedBytes += data.length) <= 65_536 && queue.length < 4) queue.push([data, binary]);
          else { client.terminate(); upstream.terminate(); }
        });
        upstream.on('message', (data, binary) => {
          const frame = parse(data);
          if (frame?.type === 'res' && frame.id === record.connect?.id && frame.ok === true && frame.payload?.type === 'worker-hello-ok') {
            record.admitted = JSON.stringify(identity(frame.payload)) === JSON.stringify(identity(record.connect)) &&
              Array.isArray(record.connect.features) && Array.isArray(frame.payload.protocolFeatures) &&
              JSON.stringify([...frame.payload.protocolFeatures].sort()) === JSON.stringify([...record.connect.features].sort());
          }
          const pending = record.pending;
          if (pending && frame?.id === pending.heartbeatId) {
            pending.proof.heartbeatResponseCount++;
            if (pending.phase !== 'heartbeat') return;
            pending.phase = 'denial';
            if (frame.type !== 'res' || frame.ok !== true || frame.payload?.status !== 'ok' || frame.payload.ownerEpoch !== record.connect.ownerEpoch) {
              finish(record, new Error('Worker ownership heartbeat was not accepted'));
            } else {
              pending.proof.heartbeatConfirmed = true;
              pending.proof.mutationSendCount++;
              upstream.send(JSON.stringify({ type: 'req', id: pending.proof.id, method: 'config.patch', params: {
                raw: '{"tools":{"elevated":{"enabled":true}}}', baseHash: '0'.repeat(64),
              } }));
            }
            return;
          }
          if (pending && frame?.id === pending.proof.id) {
            pending.proof.responseCount++;
            pending.proof.response = frame;
            return;
          }
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        upstream.on('close', (code, reason) => {
          if (record.pending) record.pending.proof.close = { code, reason: reason.toString() };
          finish(record);
          connections.delete(record);
          closePeer(client, code, reason);
        });
        client.on('close', (code, reason) => { finish(record, new Error('Worker closed before gateway denial')); connections.delete(record); closePeer(upstream, code, reason); });
        upstream.on('error', () => { finish(record, new Error('Worker relay upstream failed')); client.terminate(); });
        client.on('error', () => { finish(record, new Error('Worker relay client failed')); upstream.terminate(); });
      });
    },
    probe({ environmentId, sessionId, runId, id }) {
      assert(typeof environmentId === 'string' && environmentId.length > 0);
      assert(typeof sessionId === 'string' && sessionId.length > 0 && typeof runId === 'string' && runId.length > 0);
      assert(/^e2e-authority-[a-f0-9]{32}$/.test(id));
      const matches = [...connections].filter(r => r.admitted && r.connect.environmentId === environmentId && r.connect.sessionId === sessionId && r.connect.runId === runId && r.upstream.readyState === WebSocket.OPEN);
      assert.equal(matches.length, 1, 'Require one live admitted worker for this environment');
      const record = matches[0];
      assert(!record.pending, 'A worker probe is already pending');
      return new Promise((resolve, reject) => {
        const proof = { environmentId, sessionId, runId, id, method: 'config.patch', admitted: true, heartbeatConfirmed: false, heartbeatResponseCount: 0, mutationSendCount: 0, responseCount: 0 };
        record.pending = { proof, resolve, reject, phase: 'heartbeat', heartbeatId: `${id}-heartbeat`, timer: setTimeout(() => finish(record, new Error('Worker denial timed out')), 10_000) };
        record.upstream.send(JSON.stringify({ type: 'req', id: record.pending.heartbeatId, method: 'worker.heartbeat', params: { sentAtMs: Date.now(), status: 'busy' } }));
      });
    },
    close() {
      for (const record of connections) { finish(record, new Error('Worker relay closed')); record.client.terminate(); record.upstream.terminate(); }
      wss.close();
    },
  };
}
