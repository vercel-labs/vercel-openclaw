import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Owner, RedisStore, Unavailable} from './owner.mjs';
import {NativeGateway} from './native.mjs';
import {Worker} from './worker.mjs';
import {PROFILE, SOURCE_COMMIT} from './config.mjs';

export class Controller {
  constructor(config, deps = {}) {
    this.config = config; this.owner = deps.owner ?? new Owner(new RedisStore(config.redisUrl, config.redisToken), config.agent);
    this.worker = deps.worker ?? new Worker(config, this.owner); this.createGateway = deps.createGateway ?? (async () => new NativeGateway(config, await mkdtemp('/tmp/openclaw-gateway-'), randomBytes(32).toString('hex')));
    this.phase = 'uninitialized'; this.sessions = new Set(); this.placements = new Map(); this.active = false;
  }
  async bootstrap() {
    this.boot ??= this.initialize().catch(error => {this.phase = 'failed'; throw error;});
    await this.boot;
    return this.status();
  }
  async initialize() {
    await this.owner.acquire(); this.phase = 'starting';
    this.gateway = await this.createGateway();
    await this.gateway.configure();
    await this.owner.assertCurrent(); await this.gateway.start();
    this.phase = 'enrolling';
    await this.worker.allocate();
    await this.owner.assertCurrent();
    const setup = await this.gateway.rpc('device.pair.setupCode', {bootstrapProfile: 'node', includeQr: false, publicUrl: this.config.publicUrl.toString().replace(/^https:/, 'wss:')});
    assert(typeof setup.setupCode === 'string', 'Gateway did not issue a scoped node setup code');
    await this.worker.start(setup.setupCode);
    let identity;
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      try {identity = await this.worker.command(['node', 'identity', '--json'], 10000); if (identity.deviceId) break;} catch {}
      await delay(1000);
    }
    assert(identity?.deviceId, 'Node did not create its pairing identity');
    await this.waitConnected(identity.deviceId);
    this.deviceId = identity.deviceId;
    await this.owner.assertCurrent();
    await this.gateway.stop(); await this.gateway.configure(this.deviceId); await this.owner.assertCurrent(); await this.gateway.start();
    await this.waitConnected(this.deviceId);
    if (this.closing) throw new Unavailable('Gateway is shutting down');
    this.phase = 'ready';
  }
  async waitConnected(deviceId) {
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      await this.owner.assertCurrent();
      const list = await this.gateway.rpc('node.list', {}, 10000);
      if (list.nodes?.some(n => n.nodeId === deviceId && n.connected && !n.gatewayLocal)) return;
      await delay(1000);
    }
    throw new Error('Expected Sandbox node did not connect to the native gateway');
  }
  async assertReady() {
    await this.owner.assertCurrent();
    if (this.closing || this.phase !== 'ready') throw new Unavailable('Gateway is not ready');
    if (this.gateway.child && (this.gateway.child.exitCode !== null || this.gateway.child.signalCode)) {this.phase = 'failed'; throw new Unavailable('Native gateway exited');}
  }
  async session() {
    await this.assertReady();
    if (this.active) throw new Unavailable('Another operation is active');
    this.active = true;
    try {
      const result = await this.gateway.rpc('sessions.create', {agentId: 'assistant', displayName: 'native-split-proof', worktree: true, worktreeSource: 'empty'});
      this.lastSession = result;
      assert(result.ok === true && typeof result.key === 'string' && !result.runError, 'Native session preparation failed; inspect the known session before retrying');
      this.sessions.add(result.key);
      const placement = await this.waitPlacement(result);
      this.placements.set(result.key, placement);
      return {...result, placement};
    } catch (error) {this.phase = 'uncertain'; throw error;} finally {this.active = false;}
  }
  async waitPlacement(created) {
    for (const deadline = Date.now() + 120000; Date.now() < deadline;) {
      await this.owner.assertCurrent();
      const described = await this.gateway.rpc('sessions.describe', {key: created.key, agentId: 'assistant'}, 10000);
      this.lastPlacement = described;
      const s = described.session; const p = s?.placement;
      if (p?.state === 'failed') throw new Error('Native placement failed; inspect lastPlacement');
      if (s?.sessionId === created.sessionId && p?.state === 'active' && p.providerId === 'device' && p.profileId === PROFILE && p.inference === 'worker' && p.runner?.kind === 'device' && p.runner.status === 'available' && p.runner.deviceId === this.deviceId && typeof p.remoteWorkspaceDir === 'string') return p;
      await delay(1000);
    }
    throw new Error('Native placement readiness unconfirmed');
  }
  async proof(input) {
    await this.assertReady();
    if (this.active) throw new Unavailable('Another operation is active');
    this.active = true;
    try {
      const original = this.placements.get(input.sessionKey);
      assert(original, 'Unknown proof session');
      const described = await this.gateway.rpc('sessions.describe', {key: input.sessionKey, agentId: 'assistant'});
      const current = described.session?.placement;
      for (const field of ['environmentId', 'activeOwnerEpoch', 'remoteWorkspaceDir']) assert.deepEqual(current?.[field], original[field], 'Placement changed before verification');
      assert(original.remoteWorkspaceDir.startsWith('/data/openclaw-node/'), 'Proof workspace is outside worker Drive');
      await this.owner.assertCurrent();
      const file = await this.worker.session.readFileToBuffer({path: `${original.remoteWorkspaceDir}/split-proof.txt`}, {signal: AbortSignal.timeout(15000)});
      const transcript = await this.gateway.rpc('sessions.get', {key: input.sessionKey, agentId: 'assistant', limit: 50});
      return {file: file?.toString(), transcript, placement: current, worker: this.worker.descriptor()};
    } catch (error) {this.phase = 'uncertain'; throw error;} finally {this.active = false;}
  }
  async message(input) {
    await this.assertReady();
    assert(this.sessions.has(input.sessionKey), 'Session was not created by this owner');
    assert(typeof input.message === 'string' && input.message.length > 0 && input.message.length <= 128000, 'Message must be 1–128000 characters');
    assert(typeof input.idempotencyKey === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey), 'A stable idempotency key is required');
    if (this.active) throw new Unavailable('Another turn is active');
    this.active = true;
    this.lastTurn = {sessionKey: input.sessionKey, idempotencyKey: input.idempotencyKey, status: 'submitting'};
    try {
      const accepted = await this.gateway.rpc('agent', {agentId: 'assistant', sessionKey: input.sessionKey, message: input.message, idempotencyKey: input.idempotencyKey, deliver: false, timeout: 120}, 180000);
      assert(typeof accepted.runId === 'string', 'Native agent did not return a run ID');
      this.lastTurn.accepted = accepted; this.lastTurn.status = 'waiting';
      const completed = await this.gateway.rpc('agent.wait', {runId: accepted.runId, timeoutMs: 180000}, 195000);
      this.lastTurn.completed = completed; this.lastTurn.status = completed.status;
      if (completed.status !== 'ok') this.phase = 'uncertain';
      return {accepted, completed};
    } catch (error) {this.phase = 'uncertain'; throw error;} finally {this.active = false;}
  }
  status() {return {phase: this.phase, ownerId: this.owner.id, sourceCommit: SOURCE_COMMIT, gatewayStorage: 'ephemeral-proof', automaticTakeover: false, deviceId: this.deviceId, lastSession: this.lastSession, lastPlacement: this.lastPlacement, lastTurn: this.lastTurn, worker: this.worker.sandbox ? this.worker.descriptor() : undefined};}
  async close() {
    this.closing = true; const uncertain = this.active || this.phase === 'uncertain';
    this.owner.fence(); this.phase = 'stopping';
    const results = await Promise.allSettled([this.gateway?.stop(), this.worker.stop()]);
    if (results.some(r => r.status === 'rejected')) throw new Error('Shutdown unconfirmed; owner reservation and resources retained');
    this.phase = uncertain || this.phase === 'uncertain' ? 'uncertain' : 'stopped';
  }
}
