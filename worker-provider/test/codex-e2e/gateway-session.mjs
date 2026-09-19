import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { GatewayClient, createOperatorApprovalsGatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';
import { assertCancellationAck } from '../e2e/support.mjs';
import { exactLaunchApproval } from './policy.mjs';

const SCOPES = ['operator.approvals', 'operator.read', 'operator.write'];
const TURN_TIMEOUT = 120_000;
const METHODS = new Set(['health', 'environments.status', 'chat.history']);
const EVENTS = new Set(['connect.challenge', 'agent', 'chat', 'tick', 'presence', 'health', 'shutdown']);

export async function connectTestOperator({ url, token, sessionKey, requestTimeoutMs = 10_000, connectTimeoutMs = 10_000, localApprovals = false, createApprovalClient = createOperatorApprovalsGatewayClient, signal }) {
  signal?.throwIfAborted();
  let address;
  try { address = new URL(url); }
  catch { throw new Error('Invalid Gateway URL'); }
  assert(address.protocol === 'wss:' || (address.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(address.hostname)), 'Explicit TLS or loopback Gateway required');
  assert(!address.username && !address.password && !address.search && !address.hash, 'Gateway URL must not contain credentials or overrides');
  if (localApprovals) {
    assert(address.protocol === 'ws:' && address.hostname === '127.0.0.1' && address.pathname === '/', 'Local approval presenter requires the owned loopback Gateway');
    assert(!process.env.OPENCLAW_GATEWAY_URL && (!process.env.OPENCLAW_GATEWAY_PORT || process.env.OPENCLAW_GATEWAY_PORT === address.port), 'Local approval presenter forbids ambient Gateway overrides');
  }
  assert(typeof token === 'string' && token.trim(), 'Explicit test Gateway token required');
  assert(typeof sessionKey === 'string' && sessionKey.trim(), 'Explicit isolated session required');
  for (const timeout of [requestTimeoutMs, connectTimeoutMs]) assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 30_000, 'Bounded client timeout required');
  const log = [];
  const turns = new Map();
  const keys = new Set();
  let attempts = 0;
  let sending = false;
  let failure;
  let connected = false;
  let closing = false;
  let traceComplete = true;
  let client;
  let approvalClient, approvalReadyReject;
  let readyResolve;
  let readyReject;
  let disconnectResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const disconnected = new Promise(resolve => { disconnectResolve = resolve; });
  const fail = reason => {
    if (!failure) failure = new Error(reason);
    traceComplete = false;
    connected = false;
    readyReject(failure);
    approvalReadyReject?.(failure);
    disconnectResolve();
    client?.stop();
    approvalClient?.stop();
  };
  const record = entry => {
    if (log.length >= 10_000) { fail('Gateway test trace limit'); throw failure; }
    log.push({ at: new Date().toISOString(), ...entry });
  };
  // An approval presenter needs a signed identity; never borrow the operator's personal identity.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const deviceIdentity = {
    deviceId: createHash('sha256').update(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).digest('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  client = new GatewayClient({
    url, token, clientName: 'cli', mode: 'cli', role: 'operator', scopes: SCOPES, caps: ['tool-events', 'plugin-approvals'],
    deviceIdentity, sharedStateMode: 'read-only', requestTimeoutMs, notifyOnStartupRetry: true,
    hostDeps: { logDebug: () => {}, logError: () => {} },
    onHelloOk: hello => {
      if (connected || failure) { fail('Gateway owner connection changed'); return; }
      if (hello.auth?.role !== 'operator' || !Array.isArray(hello.auth.scopes) || JSON.stringify([...hello.auth.scopes].sort()) !== JSON.stringify(SCOPES)) {
        fail('Gateway effective scopes differ from the test operator'); return;
      }
      connected = true;
      record({ kind: 'connected', connection: 1 });
      readyResolve();
    },
    onEvent: event => {
      const entry = { kind: 'event', event: EVENTS.has(event.event) ? event.event : 'unknown', ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}) };
      const payload = event.payload;
      if (event.event === 'agent' && payload?.sessionKey === sessionKey && typeof payload.runId === 'string' && payload.runId.length <= 256 && payload.stream === 'tool' && payload.data?.name === 'session_status' && ['start', 'result'].includes(payload.data.phase)) {
        Object.assign(entry, { tool: 'session_status', phase: payload.data.phase, runHash: createHash('sha256').update(payload.runId).digest('hex'), ...(typeof payload.data.isError === 'boolean' ? { isError: payload.data.isError } : {}) });
      }
      record(entry);
    },
    onConnectError: () => fail('Gateway connection rejected'),
    onClose: () => { if (!closing) fail('Gateway owner connection closed'); },
    onGap: () => fail('Gateway event sequence gap'),
  });
  const timer = setTimeout(() => fail('Gateway connection timeout'), connectTimeoutMs);
  try { client.start(); await ready; signal?.throwIfAborted(); }
  catch (error) { await client.stopAndWait(); throw error; }
  finally { clearTimeout(timer); }

  if (localApprovals) {
    let approvalReadyResolve;
    const approvalReady = new Promise((resolve, reject) => { approvalReadyResolve = resolve; approvalReadyReject = reject; });
    void approvalReady.catch(() => {});
    const approvalTimer = setTimeout(() => fail('Local approval presenter timeout'), connectTimeoutMs);
    try {
      // Native channel approvals belong to the Gateway, not the CLI turn connection.
      approvalClient = await createApprovalClient({
        config: { gateway: { mode: 'local', bind: 'loopback', port: Number(address.port || 80), auth: { mode: 'token', token } } },
        clientDisplayName: 'OpenClaw sandbox launch presenter',
        onHelloOk: hello => {
          if (hello.auth?.role !== 'operator' || JSON.stringify(hello.auth.scopes) !== '["operator.approvals"]') { fail('Local approval presenter scopes differ'); return; }
          approvalReadyResolve();
        },
        onConnectError: () => fail('Local approval presenter rejected'),
        onClose: () => { if (!closing) fail('Local approval presenter closed'); },
      });
      if (failure) throw failure;
      signal?.throwIfAborted();
      approvalClient.start();
      await approvalReady;
      signal?.throwIfAborted();
    } catch (error) {
      closing = true;
      await Promise.all([client.stopAndWait(), approvalClient?.stopAndWait()]);
      throw error;
    } finally { clearTimeout(approvalTimer); }
  }

  const call = async (method, params, timeoutMs = requestTimeoutMs) => {
    if (failure) throw failure;
    assert(connected, 'Gateway connection is not ready');
    record({ kind: 'request', method });
    try {
      const target = approvalClient && method.startsWith('plugin.approval.') ? approvalClient : client;
      const result = await target.request(method, params, { timeoutMs });
      if (failure) throw failure;
      record({ kind: 'response', method, ok: true });
      return result;
    } catch (error) {
      record({ kind: 'response', method, ok: false });
      if (failure) throw failure;
      throw new Error(`Gateway ${method} ${error?.code === 'CLIENT_TIMEOUT' ? 'timeout' : 'request rejected'}`);
    }
  };
  const owned = runId => { assert(turns.has(runId), 'Cannot operate on an unknown run'); return turns.get(runId); };
  return {
    disconnected,
    trace: () => structuredClone(log),
    traceStatus: () => ({ complete: traceComplete, ...(traceComplete ? {} : { reason: failure?.message }) }),
    async request(method, params) {
      assert(METHODS.has(method), 'Gateway method is not exposed by the test controller');
      return call(method, params);
    },
    async approveLaunch(expected) {
      signal?.throwIfAborted();
      const turn = owned(expected.runId);
      assert.equal(expected.sessionKey, sessionKey, 'Cannot approve another session');
      const decision = exactLaunchApproval(await call('plugin.approval.list', {}), expected);
      signal?.throwIfAborted();
      if (!decision) return false;
      assert(!turn.launchDecisionSent, 'Unexpected second exec-server launch during one attempt');
      turn.launchDecisionSent = true;
      await call('plugin.approval.resolve', decision);
      return true;
    },
    async adoptNativeTurn(expected) {
      assert.equal(expected.sessionKey, sessionKey, 'Cannot adopt another session');
      assert(!sending && turns.size === 0 && attempts < 6, 'Wait for the active turn before adopting another');
      const pending = await call('plugin.approval.list', {});
      assert(Array.isArray(pending), 'Invalid pending approvals');
      const matches = pending.filter(item => item.request?.sessionKey === sessionKey);
      if (!matches.length) return undefined;
      assert.equal(matches.length, 1, 'Ambiguous native channel launch');
      const runId = matches[0].request.runId;
      assert(typeof runId === 'string' && runId && !keys.has(runId), 'Native run identity missing or reused');
      exactLaunchApproval(matches, { ...expected, runId });
      attempts++;
      keys.add(runId);
      turns.set(runId, { deadline: Date.now() + TURN_TIMEOUT, launchDecisionSent: false });
      return { runId };
    },
    async send(message, idempotencyKey) {
      if (failure) throw failure;
      assert(attempts < 6, 'Codex attempt budget exhausted');
      assert(!sending && turns.size === 0, 'Wait for the active turn before another dispatch');
      assert(typeof message === 'string' && message.trim(), 'Non-empty test message required');
      assert(typeof idempotencyKey === 'string' && idempotencyKey.trim() && !keys.has(idempotencyKey), 'Fresh idempotency key required');
      attempts++;
      sending = true;
      keys.add(idempotencyKey);
      const deadline = Date.now() + TURN_TIMEOUT;
      try {
        const result = await call('chat.send', { sessionKey, message, idempotencyKey, deliver: false, timeoutMs: TURN_TIMEOUT });
        assert(typeof result.runId === 'string' && result.runId, 'Gateway omitted run identity');
        turns.set(result.runId, { deadline, launchDecisionSent: false });
        return result;
      } catch (error) {
        // A lost send response is not permission to dispatch the same work again.
        fail('Gateway dispatch outcome uncertain; stop owned resources');
        throw error;
      } finally { sending = false; }
    },
    async cancel(runId) {
      owned(runId);
      const ack = await call('chat.abort', { sessionKey, runId });
      assertCancellationAck(ack, runId);
      return ack;
    },
    async wait(runId) {
      const { deadline } = owned(runId);
      const remaining = deadline - Date.now();
      try {
        assert(remaining > 0, 'Codex attempt deadline exceeded');
        const result = await call('agent.wait', { runId, timeoutMs: remaining }, remaining);
        assert(['ok', 'error', 'timeout'].includes(result.status), 'Gateway omitted terminal status');
        if (result.status === 'timeout') throw new Error('Codex attempt deadline exceeded');
        turns.delete(runId);
        return result;
      } catch (error) {
        try { await this.cancel(runId); }
        finally { fail('Gateway turn terminal state unconfirmed; stop owned resources'); }
        throw error;
      }
    },
    async close() {
      // Socket closure is not evidence that a remote process or sandbox stopped.
      closing = true;
      connected = false;
      failure ??= new Error('Gateway test connection closed');
      disconnectResolve();
      await Promise.all([client.stopAndWait(), approvalClient?.stopAndWait()]);
    },
  };
}
