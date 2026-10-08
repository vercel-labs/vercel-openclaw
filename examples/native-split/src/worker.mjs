import assert from 'node:assert/strict';
import {Sandbox, Drive} from '@vercel/sandbox';
import {NODE_STATE, NODE_CONFIG, nodeConfig, workerPolicy} from './config.mjs';

export class Worker {
  constructor(config, owner, platform = {Sandbox, Drive}) {this.config = config; this.owner = owner; this.platform = platform; this.pending = undefined;}
  async allocate() {
    this.pending ??= this.create();
    return await this.pending;
  }
  async create() {
    await this.owner.assertCurrent();
    const c = this.config; const name = `oc-native-${c.agent}`;
    const drive = await this.platform.Drive.getOrCreate({...c.credentials, name, region: 'iad1', maxSize: 4 * 1024 ** 3, signal: AbortSignal.timeout(30000)});
    assert(!drive.currentSessionId && !drive.currentSandboxName, 'Worker Drive already attached; preserve and inspect its owner');
    await this.owner.assertCurrent();
    const sandbox = await this.platform.Sandbox.create({...c.credentials, name, image: c.image, region: 'iad1', persistent: false,
      timeout: 65 * 60000, resources: {vcpus: 2}, mounts: {'/data': drive},
      tags: {example: 'native-split', agent: c.agent}, networkPolicy: workerPolicy(c.publicUrl, c.gatewayKey, c.deploymentToken), signal: AbortSignal.timeout(120000)});
    this.sandbox = sandbox; this.session = sandbox.currentSession(); this.drive = drive;
    assert.equal(sandbox.image, c.image, 'Allocated image differs from pinned runtime');
    this.env = {HOME: '/data', OPENCLAW_STATE_DIR: NODE_STATE, OPENCLAW_CONFIG_PATH: NODE_CONFIG, WORKER_PROXY_AUTH: 'sandbox-firewall-brokered'};
    await this.session.writeFiles([{path: NODE_CONFIG, content: Buffer.from(JSON.stringify(nodeConfig(c.model))), mode: 0o600}]);
    await this.command(['config', 'validate', '--json']);
    return this;
  }
  async command(args, timeoutMs = 60000) {
    await this.owner.assertCurrent();
    const result = await this.session.runCommand({cmd: 'node', args: ['/app/openclaw.mjs', ...args], cwd: '/app', env: this.env, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 5000)});
    assert.equal(result.exitCode, 0, 'Native node command failed; preserve Sandbox command logs');
    return JSON.parse(await result.stdout());
  }
  async start(setupCode) {
    await this.owner.assertCurrent();
    assert(!this.commandHandle, 'Node process already started');
    await this.session.writeFiles([{path: '/tmp/openclaw-join', content: Buffer.from(`oc-pair://${setupCode}`), mode: 0o600}]);
    this.commandHandle = await this.session.runCommand({cmd: 'node', args: ['/app/openclaw.mjs', 'connect', '--target-file', '/tmp/openclaw-join', '--session-host', '--display-name', `split-${this.config.agent}`],
      cwd: '/app', env: this.env, detached: true, signal: AbortSignal.timeout(30000)});
  }
  async stop() {
    await this.pending?.catch(() => {});
    if (!this.session) return;
    await this.session.stop({signal: AbortSignal.timeout(30000)});
    const drives = await this.platform.Drive.list({...this.config.credentials, signal: AbortSignal.timeout(10000)});
    let drive;
    for await (const candidate of drives) {if (candidate.driveId === this.drive.driveId) {drive = candidate; break;}}
    assert(drive && !drive.currentSessionId && !drive.currentSandboxName, 'Worker Drive detachment unconfirmed');
  }
  descriptor() {return {name: this.sandbox.name, sessionId: this.session.sessionId, driveId: this.drive.driveId, image: this.sandbox.image, commandId: this.commandHandle?.cmdId};}
}
