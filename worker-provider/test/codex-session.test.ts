import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { connectTestOperator } from './codex-e2e/gateway-session.mjs';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(require.resolve('ws', { paths: [require.resolve('openclaw')] }));

async function fixture(t: any, handle?: (frame: any, reply: (payload: any) => void, socket: any) => void, scopes = ['operator.approvals', 'operator.read', 'operator.write'], connectError?: any) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let connections = 0;
  const requests: any[] = [];
  const peers: any[] = [];
  server.on('connection', (socket: any) => {
    const connection = ++connections;
    peers.push(socket);
    socket.on('error', () => {});
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'synthetic', ts: Date.now() } }));
    socket.on('message', (bytes: Buffer) => {
      const frame = JSON.parse(bytes.toString());
      requests.push({ ...frame, connection });
      const reply = (payload: any) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
      if (frame.method === 'connect') {
        if (connectError) { socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: connectError })); return; }
        reply({ type: 'hello-ok', protocol: frame.params.maxProtocol, server: { version: 'synthetic', connId: `conn-${connection}` },
          features: { methods: ['chat.send', 'chat.abort', 'agent.wait'], events: ['agent'] }, snapshot: {},
          auth: { role: 'operator', scopes }, policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 30000 } });
      } else if (handle) handle(frame, reply, socket);
      else if (frame.method === 'chat.send') reply({ runId: frame.params.idempotencyKey, status: 'started' });
      else if (frame.method === 'chat.abort') reply({ aborted: true, runIds: [frame.params.runId] });
      else if (frame.method === 'agent.wait') reply({ status: 'ok' });
    });
  });
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(resolve)); });
  const options = { url: `ws://127.0.0.1:${server.address().port}`, token: 'synthetic-test-token', sessionKey: 'agent:main:codex-test' };
  return { options, requests, peers, connections: () => connections };
}

test('Codex test controller uses one real SDK connection for send, wait and exact-run cancellation', async t => {
  const peer = await fixture(t);
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const turn = await session.send('synthetic prompt', 'turn-1');
  await session.cancel(turn.runId);
  assert.equal((await session.wait(turn.runId)).status, 'ok');
  assert.equal(peer.connections(), 1);
  assert.deepEqual(peer.requests.map(frame => frame.method), ['connect', 'chat.send', 'chat.abort', 'agent.wait']);
  assert(peer.requests.every(frame => frame.connection === 1));
  assert.deepEqual(peer.requests[0].params.scopes, ['operator.approvals', 'operator.read', 'operator.write']);
  assert.equal(peer.requests[0].params.auth.token, 'synthetic-test-token');
  const device = peer.requests[0].params.device;
  assert.equal(device.id, createHash('sha256').update(Buffer.from(device.publicKey, 'base64url')).digest('hex'));
  assert.equal(typeof device.signature, 'string');
  assert.equal(peer.requests[1].params.deliver, false);
  assert.equal(peer.requests[1].params.timeoutMs, 120000);
  assert.equal(peer.requests[2].params.sessionKey, peer.options.sessionKey);
  assert(!JSON.stringify(session.trace()).includes('synthetic-test-token'));
});

test('a no-op cancellation and an unrelated run cannot be counted as cancellation proof', async t => {
  const peer = await fixture(t, (frame, reply) => reply(frame.method === 'chat.send' ? { runId: 'owned' } : { aborted: false, runIds: [] }));
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  await assert.rejects(session.cancel('not-owned'), /unknown run/);
  assert.equal(peer.requests.length, 1);
  await session.send('test', 'owned');
  await assert.rejects(session.cancel('owned'), /acknowledge cancellation/);
});

test('callback evidence records only the scoped tool outcome, never arguments or result content', async t => {
  const peer = await fixture(t, (_frame, reply) => reply({ status: 'ok' }));
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  assert.deepEqual(peer.requests[0].params.caps, ['tool-events', 'plugin-approvals']);
  peer.peers[0].send(JSON.stringify({ type: 'event', event: 'agent', payload: {
    sessionKey: peer.options.sessionKey, runId: 'run', stream: 'tool',
    data: { name: 'session_status', phase: 'result', isError: false, args: { secret: 'private-canary' }, result: 'private-canary' },
  } }));
  await session.request('health', {});
  assert(session.trace().some(entry => entry.tool === 'session_status' && entry.phase === 'result' && entry.isError === false && entry.runHash === createHash('sha256').update('run').digest('hex')));
  assert(!JSON.stringify(session.trace()).includes('private-canary'));
});

test('controller fails closed on scope changes instead of asking for admin privileges', async t => {
  for (const scopes of [['operator.read'], ['operator.read', 'operator.write'], ['operator.approvals', 'operator.read', 'operator.write', 'operator.admin']]) {
    const peer = await fixture(t, undefined, scopes);
    await assert.rejects(connectTestOperator(peer.options), /effective scopes/);
    assert.equal(peer.requests.length, 1);
  }
});

test('persistent approval presenter resolves only its owned run and exact placement', async t => {
  const expected = { sessionKey: 'agent:main:codex-test', sessionId: 'session', runId: 'owned', environmentId: 'environment', nodeId: 'node', cwd: '/worker/project', ownerEpoch: 2, placementGeneration: 3 };
  const peer = await fixture(t, (frame, reply) => {
    if (frame.method === 'chat.send') return reply({ runId: 'owned' });
    if (frame.method === 'plugin.approval.list') return reply([{ id: 'approval', approvalKind: 'plugin', expiresAtMs: Date.now() + 10_000, request: {
      pluginId: 'codex', severity: 'critical', sessionKey: expected.sessionKey, runId: expected.runId, allowedDecisions: ['allow-once'],
      placementGrant: { ...expected, pluginId: 'codex', agentId: 'main', command: 'codex.exec-server.stdio.v1', approvalScope: 'codex.exec-server', pairingGeneration: 'pairing' },
    } }]);
    return reply({ status: 'ok' });
  });
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  await session.send('test', 'owned');
  await assert.rejects(session.approveLaunch({ ...expected, runId: 'unowned' }), /unknown run/);
  await assert.rejects(session.approveLaunch({ ...expected, sessionKey: 'other-session' }), /session/);
  await assert.rejects(session.approveLaunch({ ...expected, nodeId: 'other-node' }), /nodeId/);
  assert.equal(peer.requests.filter(frame => frame.method === 'plugin.approval.resolve').length, 0);
  assert.equal(await session.approveLaunch(expected), true);
  assert.deepEqual(peer.requests.at(-1).params, { id: 'approval', decision: 'allow-once' });
  await assert.rejects(session.approveLaunch(expected), /second exec-server launch/);
  assert.equal(peer.requests.filter(frame => frame.method === 'plugin.approval.resolve').length, 1);
  await session.wait('owned');
  assert.equal(peer.connections(), 1);
  assert(peer.requests.every(frame => frame.connection === 1));
  await assert.rejects(session.request('plugin.approval.resolve', { id: 'arbitrary', decision: 'allow-always' }), /method/);
});

test('native channel turns are adopted only from one exact placement-bound launch request', async t => {
  const expected = { sessionKey: 'agent:main:codex-test', sessionId: 'session', environmentId: 'environment', nodeId: 'node', cwd: '/worker/project', ownerEpoch: 2, placementGeneration: 3 };
  let pending: unknown[] = [];
  const peer = await fixture(t, (frame, reply) => reply(frame.method === 'plugin.approval.list' ? pending : { status: 'ok' }));
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  assert.equal(await session.adoptNativeTurn(expected), undefined);
  const approval = { id: 'approval', approvalKind: 'plugin', expiresAtMs: Date.now() + 10_000, request: {
    pluginId: 'codex', severity: 'critical', sessionKey: expected.sessionKey, runId: 'native-run', allowedDecisions: ['allow-once'],
    placementGrant: { ...expected, pluginId: 'codex', agentId: 'main', command: 'codex.exec-server.stdio.v1', approvalScope: 'codex.exec-server', pairingGeneration: 'pairing' },
  } };
  pending = [approval];
  await assert.rejects(session.adoptNativeTurn({ ...expected, nodeId: 'other' }), /nodeId/);
  pending = [approval, approval];
  await assert.rejects(session.adoptNativeTurn(expected), /Ambiguous/);
  pending = [approval];
  assert.deepEqual(await session.adoptNativeTurn(expected), { runId: 'native-run' });
  assert.equal(peer.requests.filter(frame => frame.method === 'chat.send' || frame.method === 'plugin.approval.resolve').length, 0);
  assert.equal(await session.approveLaunch({ ...expected, runId: 'native-run' }), true);
  await session.wait('native-run');
});

test('an abort during approval lookup cannot resolve a launch and still permits cleanup cancellation', async t => {
  const controller = new AbortController();
  const expected = { sessionKey: 'agent:main:codex-test', sessionId: 'session', runId: 'owned', environmentId: 'environment', nodeId: 'node', cwd: '/worker/project', ownerEpoch: 2, placementGeneration: 3 };
  const peer = await fixture(t, (frame, reply) => {
    if (frame.method === 'chat.send') return reply({ runId: 'owned' });
    if (frame.method === 'chat.abort') return reply({ aborted: true, runIds: ['owned'] });
    if (frame.method === 'plugin.approval.list') {
      controller.abort(new Error('execution deadline'));
      return reply([{ id: 'approval', approvalKind: 'plugin', expiresAtMs: Date.now() + 10000, request: {
        pluginId: 'codex', severity: 'critical', sessionKey: expected.sessionKey, runId: expected.runId, allowedDecisions: ['allow-once'],
        placementGrant: { ...expected, pluginId: 'codex', agentId: 'main', command: 'codex.exec-server.stdio.v1', approvalScope: 'codex.exec-server', pairingGeneration: 'pairing' },
      } }]);
    }
    assert.fail(`unexpected ${frame.method}`);
  });
  const session = await connectTestOperator({ ...peer.options, signal: controller.signal });
  t.after(() => session.close());
  await session.send('test', 'owned');
  await assert.rejects(session.approveLaunch(expected), /execution deadline/);
  assert.equal(peer.requests.some((frame: any) => frame.method === 'plugin.approval.resolve'), false);
  await session.cancel('owned');
  assert.equal(peer.requests.at(-1).method, 'chat.abort');
});

test('native Slack uses the local SDK approval presenter without broadening the turn connection', async t => {
  const expected = { sessionKey: 'agent:main:codex-test', sessionId: 'session', environmentId: 'environment', nodeId: 'node', cwd: '/worker/project', ownerEpoch: 2, placementGeneration: 3 };
  const peer = await fixture(t);
  const requests: any[] = [];
  let closed = false;
  const session = await connectTestOperator({ ...peer.options, localApprovals: true, createApprovalClient: async (options: any) => {
    assert.equal(options.config.gateway.mode, 'local');
    assert.equal(options.config.gateway.port, Number(new URL(peer.options.url).port));
    assert.equal(options.config.gateway.auth.token, peer.options.token);
    assert.equal(options.gatewayUrl, undefined);
    return {
      start: () => options.onHelloOk({auth:{role:'operator',scopes:['operator.approvals']}}),
      stop: () => {}, stopAndWait: async () => { closed = true; },
      request: async (method: string, params: any) => {
        requests.push({method,params});
        return method === 'plugin.approval.list' ? [{id:'approval',approvalKind:'plugin',expiresAtMs:Date.now()+10000,request:{
          pluginId:'codex',severity:'critical',sessionKey:expected.sessionKey,runId:'native-owned',allowedDecisions:['allow-once'],
          placementGrant:{...expected,pluginId:'codex',agentId:'main',command:'codex.exec-server.stdio.v1',approvalScope:'codex.exec-server',pairingGeneration:'pairing'},
        }}] : {status:'ok'};
      },
    };
  }});
  t.after(() => session.close());
  assert.deepEqual(await session.adoptNativeTurn(expected), {runId:'native-owned'});
  await assert.rejects(session.approveLaunch({...expected,runId:'native-owned',nodeId:'wrong'}), /nodeId/);
  assert.equal(requests.some(r=>r.method==='plugin.approval.resolve'),false);
  assert.equal(await session.approveLaunch({...expected,runId:'native-owned'}),true);
  assert.deepEqual(requests.at(-1),{method:'plugin.approval.resolve',params:{id:'approval',decision:'allow-once'}});
  await session.wait('native-owned');
  assert.deepEqual(peer.requests.map(r=>r.method),['connect','agent.wait']);
  await session.close();
  assert.equal(closed,true);
});

test('local approval presenter rejects nonlocal endpoints and broader effective scopes', async t => {
  await assert.rejects(connectTestOperator({url:'wss://gateway.example',token:'synthetic',sessionKey:'test',localApprovals:true}), /owned loopback/);
  const peer = await fixture(t);
  let closed = false;
  await assert.rejects(connectTestOperator({...peer.options,localApprovals:true,createApprovalClient:async(options:any)=>({
    start:()=>options.onHelloOk({auth:{role:'operator',scopes:['operator.approvals','operator.admin']}}),
    stop:()=>{},stopAndWait:async()=>{closed=true;},
  })}),/presenter scopes differ/);
  assert.equal(closed,true);
  assert.deepEqual(peer.requests.map(r=>r.method),['connect']);
});

test('disconnect after a sent request poisons the owner connection and never retries the turn', async t => {
  const peer = await fixture(t, (_frame, _reply, socket) => socket.close());
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  await assert.rejects(session.send('test', 'lost'));
  await assert.rejects(session.send('test', 'retry'), /connection|closed|uncertain/i);
  assert.equal(peer.requests.filter(frame => frame.method === 'chat.send').length, 1);
  assert.equal(peer.connections(), 1);
});

test('event gaps invalidate the test trace and disable further dispatch', async t => {
  const peer = await fixture(t);
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const socket = peer.peers[0];
  socket.send(JSON.stringify({ type: 'event', event: 'agent', seq: 1, payload: { runId: 'synthetic' } }));
  socket.send(JSON.stringify({ type: 'event', event: 'agent', seq: 3, payload: { runId: 'synthetic' } }));
  await session.disconnected;
  await assert.rejects(session.send('test', 'after-gap'), /gap/);
  assert.equal(peer.requests.length, 1);
});

test('the six-attempt budget has no seventh call or generic request bypass', async t => {
  const peer = await fixture(t);
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  for (let i = 0; i < 6; i++) { const turn = await session.send('test', `run-${i}`); await session.wait(turn.runId); }
  await assert.rejects(session.send('test', 'run-6'), /attempt budget/);
  await assert.rejects(session.request('chat.send', {}), /method/);
  assert.equal(peer.requests.filter(frame => frame.method === 'chat.send').length, 6);
});

test('a lost send response has a bounded deadline and cannot lead to a duplicate dispatch', async t => {
  const peer = await fixture(t, () => {});
  const session = await connectTestOperator({ ...peer.options, requestTimeoutMs: 50 });
  t.after(() => session.close());
  await assert.rejects(session.send('test', 'unknown'), /timeout|uncertain/i);
  await assert.rejects(session.send('test', 'duplicate'), /uncertain|closed/i);
  assert.equal(peer.requests.filter(frame => frame.method === 'chat.send').length, 1);
});

test('concurrent sends cannot race the one-active-turn guard', async t => {
  let accept: ((payload: any) => void) | undefined;
  const peer = await fixture(t, (_frame, reply) => { accept = reply; });
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const first = session.send('test', 'first');
  await assert.rejects(session.send('test', 'second'), /active turn/);
  while (!accept) await new Promise(resolve => setImmediate(resolve));
  accept({ runId: 'first' });
  await first;
  assert.equal(peer.requests.filter(frame => frame.method === 'chat.send').length, 1);
});

test('generic RPC cannot create a turn or mutate session placement outside the counted send path', async t => {
  const peer = await fixture(t);
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  for (const method of ['sessions.create', 'sessions.patch', 'sessions.dispatch', 'environments.reclaim', 'agent', 'sessions.send', 'chat.abort']) {
    await assert.rejects(session.request(method, { message: 'test' }), /method/);
  }
  assert.equal(peer.requests.length, 1);
});

test('an agent.wait timeout attempts exact-run cancellation before invalidating the connection', async t => {
  const peer = await fixture(t, (frame, reply) => {
    if (frame.method === 'chat.send') reply({ runId: 'timeout-run' });
    else if (frame.method === 'agent.wait') reply({ status: 'timeout' });
    else reply({ aborted: true, runIds: [frame.params.runId] });
  });
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const turn = await session.send('test', 'timeout-run');
  await assert.rejects(session.wait(turn.runId), /deadline/);
  assert.deepEqual(peer.requests.slice(1).map(frame => frame.method), ['chat.send', 'agent.wait', 'chat.abort']);
  await assert.rejects(session.send('test', 'next'), /unconfirmed/);
});

test('absent handshake has a bounded connection deadline and closes the socket', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(resolve)); });
  await assert.rejects(connectTestOperator({ url: `ws://127.0.0.1:${server.address().port}`, token: 'synthetic', sessionKey: 'test', connectTimeoutMs: 50 }), /timeout/);
});

test('retryable startup rejection never opens a second owner socket', async t => {
  const peer = await fixture(t, undefined, undefined, { code: 'UNAVAILABLE', message: 'starting', retryable: true, retryAfterMs: 100, details: { reason: 'startup-sidecars' } });
  await assert.rejects(connectTestOperator({ ...peer.options, connectTimeoutMs: 400 }), /closed/);
  assert.equal(peer.connections(), 1);
});

test('wire-level auth rejection never falls back to ambient credentials', async t => {
  const peer = await fixture(t, undefined, undefined, { code: 'UNAUTHORIZED', message: 'synthetic-test-token rejected', details: { code: 'AUTH_TOKEN_MISMATCH' } });
  await assert.rejects(connectTestOperator(peer.options), error => {
    assert(!String(error).includes('synthetic-test-token'));
    return /rejected/.test(String(error));
  });
  assert.equal(peer.connections(), 1);
  assert.equal(peer.requests.length, 1);
});

test('trace excludes arbitrary server labels and marks a recording failure as incomplete', async t => {
  const peer = await fixture(t, (_frame, reply) => reply({ status: 'ok' }));
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const socket = peer.peers[0];
  socket.send(JSON.stringify({ type: 'event', event: 'synthetic-test-token', payload: {} }));
  await session.request('health', {});
  assert(!JSON.stringify(session.trace()).includes('synthetic-test-token'));
  const remaining = 9999 - session.trace().length;
  for (let i = 0; i < remaining; i++) socket.send(JSON.stringify({ type: 'event', event: 'tick', payload: {} }));
  const deadline = Date.now() + 3000;
  while (session.trace().length < 9999 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(session.trace().length, 9999);
  await assert.rejects(session.request('health', {}), /trace limit/);
  assert.equal(session.traceStatus().complete, false);
});

test('malformed or wrong-run cancellation acknowledgments fail exact membership', async t => {
  for (const runIds of ['unrelated-owned-suffix', ['not-owned'], [123], null]) {
    const peer = await fixture(t, (frame, reply) => reply(frame.method === 'chat.send' ? { runId: 'owned' } : { aborted: true, runIds }));
    const session = await connectTestOperator(peer.options);
    t.after(() => session.close());
    await session.send('test', 'owned');
    await assert.rejects(session.cancel('owned'), /exact run/);
  }
});

test('a delayed wait uses the original turn deadline and cancels when the client timer expires', async t => {
  const peer = await fixture(t, (frame, reply) => {
    if (frame.method === 'chat.send') reply({ runId: 'deadline-run' });
    if (frame.method === 'chat.abort') reply({ aborted: true, runIds: [frame.params.runId] });
  });
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  const initial = Date.now();
  t.mock.method(Date, 'now', () => initial);
  const turn = await session.send('test', 'deadline-run');
  t.mock.method(Date, 'now', () => initial + 119950);
  await assert.rejects(session.wait(turn.runId), /timeout/);
  const wait = peer.requests.find(frame => frame.method === 'agent.wait');
  assert.equal(wait.params.timeoutMs, 50);
  assert.equal(peer.requests.at(-1).method, 'chat.abort');
});

test('an operator session cannot inherit remote cleartext auth or missing credentials', async () => {
  for (const patch of [{ token: '' }, { url: 'ws://remote.example/' }, { url: 'wss://token@example.org/' }, { url: 'wss://example.org/?token=secret' }]) {
    await assert.rejects(connectTestOperator({ url: 'ws://127.0.0.1:9999', token: 'synthetic', sessionKey: 'test', ...patch }));
  }
});

test('invalid URL errors omit the original secret-bearing input', async () => {
  await assert.rejects(connectTestOperator({ url: 'malformed-secret-canary', token: 'synthetic', sessionKey: 'test' }), error => {
    assert(!inspect(error).includes('malformed-secret-canary'));
    return true;
  });
});

test('cancellation validation errors omit arbitrary server values', async t => {
  const peer = await fixture(t, (frame, reply) => reply(frame.method === 'chat.send' ? { runId: 'owned' } : { aborted: 'server-secret-canary', runIds: ['owned'] }));
  const session = await connectTestOperator(peer.options);
  t.after(() => session.close());
  await session.send('test', 'owned');
  await assert.rejects(session.cancel('owned'), error => {
    assert(!inspect(error).includes('server-secret-canary'));
    return true;
  });
});
