import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, Drive, Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { agentDriveName, assertVersion, DRIVE_BYTES, MOUNT, REGION, STATE, VERSION, WORKSPACE, type Settings } from './config.js';
import { Receipt } from './receipt.js';
import { configuration, parseAgentReply, agentArgs, bootstrapScript, inventoryScript, assertCleanShutdown, type AgentReply } from './openclaw.js';

export interface Platform {
  drive: typeof Drive.getOrCreate;
  create: typeof Sandbox.create;
}
const platform: Platform = {
  drive: options => Drive.getOrCreate(options),
  create: options => Sandbox.create(options),
};
export const SHUTDOWN_WAIT_MS = 335_000;

export function runtimeNetworkPolicy(gatewayKey: string, slackToken?: string, installing = false): NetworkPolicy {
  return { allow: {
    'ai-gateway.vercel.sh': [{ transform: [{ headers: { Authorization: `Bearer ${gatewayKey}`, Host: 'ai-gateway.vercel.sh' } }] }],
    ...(slackToken ? { 'slack.com': [
      { match: { path: { startsWith: '/api/' }, method: ['GET','POST'] }, transform: [{ headers: { Authorization: `Bearer ${slackToken}` } }] },
      { response: { statusCode: 403 } },
    ] } : {}),
    ...(installing ? { 'registry.npmjs.org': [] } : {}),
  } };
}

export interface RuntimeExtension {
  config: object; environment: Record<string, string>; slackToken: string;
  prepare: (run: AgentRun) => Promise<void>;
  gatewayEntrypoint?: string;
}

export interface RuntimeHandle { name: string; sessionId: string; driveId: string; image: string; commandId: string; createdAt: number }
const WARM_ENV = '/tmp/openclaw-drives-runtime.json';

export type Inventory = Record<string, { sha256: string; bytes: number } | { symlink: string }>;
export type Stage = 'attached' | 'ready' | 'turn' | 'failed' | 'quiesced' | 'stopped';

export class AgentRun {
  stage: Stage = 'attached';
  private gateway?: Command;
  private readonly token: string;
  readonly env: Record<string, string>;
  private constructor(readonly sandbox: Sandbox, readonly drive: Drive,
    private readonly settings: Settings, private readonly receipt: Receipt,
    private readonly services: Platform, private readonly detachAttempts: number, private readonly extension?: RuntimeExtension) {
    this.token = randomBytes(32).toString('hex');
    receipt.addSecret(this.token);
    if (extension) { receipt.addSecret(extension.slackToken); Object.values(extension.environment).forEach(v => receipt.addSecret(v)); }
    this.env = {
      HOME: '/home/node', OPENCLAW_STATE_DIR: STATE, OPENCLAW_CONFIG_PATH: `${STATE}/openclaw.json`,
      OPENCLAW_GATEWAY_TOKEN: this.token, OPENCLAW_DRIVES_MODEL_KEY: 'sandbox-brokered',
      ...extension?.environment,
    };
  }

  static async attach(settings: Settings, agent: string, receipt: Receipt,
    options: { services?: Platform; image?: string; detachAttempts?: number; extension?: RuntimeExtension; timeoutMs?: number } = {}): Promise<AgentRun> {
    const services = options.services ?? platform;
    const name = agentDriveName(agent);
    receipt.event('drive-requested', { name, region: REGION });
    const drive = await services.drive({ ...settings.credentials, name, region: REGION, maxSize: DRIVE_BYTES, signal: AbortSignal.timeout(30_000) });
    receipt.event('drive-found', { name, driveId: drive.driveId, attachedSession: drive.currentSessionId ?? null });
    assert(!drive.currentSessionId && !drive.currentSandboxName, `Drive ${name} already has a writer. Stop that run explicitly before retrying.`);
    const sandboxName = `${name}-${randomUUID().slice(0,8)}`;
    const image = options.image ?? settings.image;
    receipt.event('sandbox-requested', { name: sandboxName, image, persistent: false });
    const sandbox = await services.create({
      ...settings.credentials, name: sandboxName, image, region: REGION,
      persistent: false, timeout: options.timeoutMs ?? 15 * 60_000, resources: { vcpus: 2 },
      mounts: { [MOUNT]: drive },
      tags: { example: 'openclaw-drives', release: VERSION },
      networkPolicy: runtimeNetworkPolicy(settings.gatewayKey, options.extension?.slackToken),
      signal: AbortSignal.timeout(120_000),
    });
    receipt.event('sandbox-created', { name: sandbox.name, sessionId: sandbox.currentSession().sessionId,
      region: sandbox.region, image: sandbox.image, persistent: sandbox.persistent, mounts: sandbox.mounts });
    assert.equal(sandbox.persistent, false, 'The persistence test must not restore sandbox snapshots.');
    assert(sandbox.image?.includes('@sha256:'), 'The platform did not report a resolved image digest.');
    if (options.image) assert.equal(sandbox.image, options.image, 'Fresh VM resolved a different image.');
    assert(sandbox.mounts?.[MOUNT], 'Agent Drive is not mounted at the configured state path.');
    return new AgentRun(sandbox, drive, settings, receipt, services, options.detachAttempts ?? 60, options.extension);
  }

  handle(): RuntimeHandle {
    assert(this.gateway, 'Gateway command is missing.');
    return {name:this.sandbox.name,sessionId:this.sandbox.currentSession().sessionId,driveId:this.drive.driveId,
      image:this.sandbox.image!,commandId:this.gateway.cmdId,createdAt:this.sandbox.currentSession().createdAt.getTime()};
  }

  static async reconnect(settings: Settings, agent: string, receipt: Receipt, handle: RuntimeHandle,
    options: {services?: Platform; slackToken?: string; allowQuiesced?: boolean} = {}): Promise<AgentRun> {
    const services=options.services??platform;
    const sandbox=await Sandbox.get({...settings.credentials,name:handle.name,resume:false,signal:AbortSignal.timeout(30000)});
    assert(sandbox.status==='running' && sandbox.currentSession().sessionId===handle.sessionId,'Saved warm VM is not the same running session. Inspect before recovery.');
    assert(sandbox.persistent===false && sandbox.image===handle.image,'Warm VM image or persistence changed.');
    const drive=await services.drive({...settings.credentials,name:agentDriveName(agent),region:REGION,maxSize:DRIVE_BYTES});
    assert(drive.driveId===handle.driveId && drive.currentSessionId===handle.sessionId && drive.currentSandboxName===handle.name,'Warm Drive attachment differs.');
    const bytes=await sandbox.readFileToBuffer({path:WARM_ENV},{signal:AbortSignal.timeout(15000)});
    assert(bytes,'Warm runtime credentials are missing.');
    const saved=JSON.parse(bytes.toString());
    assert(saved.sessionId===handle.sessionId && saved.env?.HOME==='/home/node' && saved.env.OPENCLAW_STATE_DIR===STATE &&
      saved.env.OPENCLAW_CONFIG_PATH===`${STATE}/openclaw.json` && saved.env.OPENCLAW_DRIVES_MODEL_KEY==='sandbox-brokered' &&
      /^[a-f0-9]{64}$/.test(saved.env.OPENCLAW_GATEWAY_TOKEN) && /^[a-f0-9]{64}$/.test(saved.env.SLACK_SIGNING_SECRET) &&
      saved.env.SLACK_BOT_TOKEN==='xoxb-sandbox-brokered','Warm runtime binding or credentials are invalid.');
    const allowed=['HOME','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_DRIVES_MODEL_KEY','OPENCLAW_GATEWAY_TOKEN','SLACK_SIGNING_SECRET','SLACK_BOT_TOKEN'];
    assert(Object.keys(saved.env).every(k=>allowed.includes(k)),'Unexpected saved environment field.');
    const run=new AgentRun(sandbox,drive,settings,receipt,services,60);
    Object.assign(run.env,saved.env);Object.values(run.env).forEach(v=>receipt.addSecret(v));
    run.gateway=await sandbox.getCommand(handle.commandId,{signal:AbortSignal.timeout(15000)});
    if(run.gateway.exitCode!==null){
      assert(options.allowQuiesced,'Warm gateway exited; inspect before recovery.');
      const logs=await run.diagnostics();assertCleanShutdown(run.gateway.exitCode,logs??'');run.stage='quiesced';return run;
    }
    if(options.slackToken) await sandbox.update({networkPolicy:runtimeNetworkPolicy(settings.gatewayKey,options.slackToken)},{signal:AbortSignal.timeout(30000)});
    run.stage='ready';receipt.event('gateway-reused',{...handle});return run;
  }

  private async command(label: string, args: string[], timeoutMs = 30_000): Promise<string> {
    const result = await this.sandbox.runCommand({ cmd: 'node', args, cwd: '/app', env: this.env, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 5000) });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    this.receipt.event('command', { label, sessionId: this.sandbox.currentSession().sessionId, commandId: result.cmdId, exitCode: result.exitCode, stdout, stderr });
    assert.equal(result.exitCode, 0, `${label} failed; inspect the saved command output.`);
    return stdout;
  }

  async inventory(): Promise<Inventory> {
    assert(this.stage === 'attached' || this.stage === 'quiesced', 'Read the stable inventory before startup or after gateway exit.');
    return JSON.parse(await this.command('state-inventory', ['-e', inventoryScript, STATE], 30_000));
  }

  async start(): Promise<void> {
    assert.equal(this.stage, 'attached');
    try {
      const identity = JSON.parse(await this.command('runtime-user', ['-e', `console.log(JSON.stringify(require('node:os').userInfo()))`]));
      assert(identity.username === 'node' && identity.uid === 1000 && identity.gid === 1000, 'Official image must run as node (1000:1000).');
      assertVersion(await this.command('version', ['/app/openclaw.mjs', '--version']));
      await this.command('initialize-state', ['-e', bootstrapScript, STATE, JSON.stringify(this.extension?.config ?? configuration(this.settings.model)), VERSION], 30_000);
      if (this.extension) {
        await this.extension.prepare(this);
        await this.command('extension-config-validate', ['/app/openclaw.mjs', 'config', 'validate', '--json'], 30000);
      }
      if (this.extension) await this.sandbox.writeFiles([{path:WARM_ENV,content:Buffer.from(JSON.stringify({sessionId:this.sandbox.currentSession().sessionId,env:this.env})),mode:0o600}]);
      this.gateway = await this.sandbox.runCommand({ cmd: 'tini', args: ['-s', '--', 'node', ...(this.extension?.gatewayEntrypoint ? [this.extension.gatewayEntrypoint] : ['/app/openclaw.mjs', 'gateway'])],
        cwd: '/app', env: this.env, detached: true, signal: AbortSignal.timeout(30_000) });
      this.receipt.event('gateway-started', { commandId: this.gateway.cmdId, sessionId: this.sandbox.currentSession().sessionId });
      await this.command('gateway-health', ['-e', `
        const end = performance.now() + 90000;
        (async () => {
          while (performance.now() < end) {
            try { const r = await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(2000) });
              if (r.ok) { console.log('healthy'); return; }
            } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
          throw new Error('Gateway did not become healthy within 90 seconds');
        })().catch(e => { console.error(e.message); process.exitCode = 1; });
      `], 95_000);
      this.stage = 'ready';
    } catch (error) { this.stage = 'failed'; await this.diagnostics(); throw error; }
  }

  async turn(session: string, message: string): Promise<AgentReply> {
    assert.equal(this.stage, 'ready', 'Only one turn may run at a time.');
    assert(message.length > 0 && message.length <= 16_000, 'Message must be 1–16000 characters.');
    this.stage = 'turn';
    try {
      const reply = parseAgentReply(await this.command('agent-turn', agentArgs(session, message), 190_000), this.settings.model);
      this.stage = 'ready';
      return reply;
    } catch (error) { this.stage = 'failed'; await this.diagnostics(); throw error; }
  }

  async readWorkspaceFile(name: string): Promise<Buffer> {
    assert(['MEMORY.md', 'restart-proof.txt'].includes(name), 'Only acceptance-test files may be read here.');
    const content = await this.sandbox.readFileToBuffer({ path: `${WORKSPACE}/${name}` }, { signal: AbortSignal.timeout(15_000) });
    assert(content, `Expected workspace file ${name} is absent.`);
    return content;
  }

  async quiesce(): Promise<void> {
    assert.equal(this.stage, 'ready', 'Cannot claim clean shutdown during an active or failed turn.');
    assert(this.gateway, 'Gateway command is missing.');
    this.stage = 'turn';
    try {
      await this.gateway.kill('SIGTERM', { abortSignal: AbortSignal.timeout(10_000) });
      const result = await this.gateway.wait({ signal: AbortSignal.timeout(SHUTDOWN_WAIT_MS) });
      const logs = await this.diagnostics();
      assertCleanShutdown(result.exitCode, logs ?? '');
      this.stage = 'quiesced';
      this.receipt.event('gateway-quiesced', { commandId: result.cmdId, exitCode: result.exitCode });
    } catch (error) { this.stage = 'failed'; await this.diagnostics(); throw error; }
  }

  async stop(): Promise<void> {
    assert.equal(this.stage, 'quiesced', 'Stop requires confirmed clean gateway exit.');
    try {
      await this.sandbox.stop({ signal: AbortSignal.timeout(120_000) });
      const detachDeadline = AbortSignal.timeout(60_000);
      for (let attempt = 0; attempt < this.detachAttempts; attempt++) {
        const current = await this.services.drive({ ...this.settings.credentials, name: this.drive.name,
          region: REGION, maxSize: DRIVE_BYTES, signal: AbortSignal.any([detachDeadline, AbortSignal.timeout(10_000)]) });
        if (!current.currentSessionId && !current.currentSandboxName) {
          this.stage = 'stopped'; this.receipt.event('drive-detached', { name: current.name }); return;
        }
        if (attempt + 1 < this.detachAttempts) await delay(1000, undefined, { signal: detachDeadline });
      }
      throw new Error('Drive did not detach within the bounded handoff window.');
    } catch (error) { this.stage = 'failed'; throw error; }
  }

  async diagnostics(): Promise<string | undefined> {
    if (!this.gateway) return;
    let stdout = '', stderr = '';
    let complete = false;
    try {
      for await (const log of this.gateway.logs({ signal: AbortSignal.timeout(5000) })) {
        if (log.stream === 'stdout') stdout += log.data;
        else stderr += log.data;
      }
      complete = true;
    } catch { /* Preserve partial startup logs when the gateway is still running. */ }
    this.receipt.event('gateway-output', { commandId: this.gateway.cmdId, stdout, stderr, complete });
    return complete ? stdout + '\n' + stderr : undefined;
  }
}
