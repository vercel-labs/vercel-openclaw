import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Drive, Sandbox } from '@vercel/sandbox';
import { agentDriveName, redact, sessionId, VERSION, type Settings } from './config.js';
import { configuration } from './openclaw.js';
import { initializeDrive } from './initialize.js';
import { AgentRun, type Platform } from './runtime.js';
import { Receipt } from './receipt.js';
import type { Job, MessageInput, Resource, Store } from './controller-store.js';

export function validateMessage(raw: unknown): MessageInput {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected a message object.');
  const v = raw as Record<string, unknown>;
  assert(Object.keys(v).every(k => ['agent','requestId','conversation','message'].includes(k)), 'Unknown message field.');
  assert(typeof v.agent === 'string', 'Agent is required.'); agentDriveName(v.agent);
  assert(typeof v.requestId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v.requestId), 'Invalid request ID.');
  assert(typeof v.message === 'string' && v.message.trim().length > 0 && v.message.length <= 16_000, 'Message must be 1–16000 characters.');
  const conversation = v.conversation ?? 'main';
  assert(typeof conversation === 'string', 'Invalid conversation.'); sessionId(conversation);
  return { agent: v.agent, requestId: v.requestId, conversation, message: v.message };
}
export function publicJob(job: Job): Omit<Job, 'owner' | 'fingerprint'> {
  const { owner: _owner, fingerprint: _fingerprint, ...visible } = job;
  return visible;
}
type Run = Pick<AgentRun, 'start' | 'turn' | 'quiesce' | 'stop' | 'sandbox'>;
export interface ControllerDependencies {
  platform: Platform;
  initialize: typeof initializeDrive;
  attach: (settings: Settings, agent: string, receipt: Receipt, options: { services: Platform; image?: string }) => Promise<Run>;
  receipt: () => Receipt;
}

export class Controller {
  readonly fingerprint: string;
  private dependencies: ControllerDependencies;
  constructor(readonly settings: Settings, readonly store: Store, results: string, dependencies?: Partial<ControllerDependencies>) {
    this.fingerprint = createHash('sha256').update(JSON.stringify({ release: VERSION, image: settings.image, config: configuration(settings.model) })).digest('hex');
    this.dependencies = {
      platform: { drive: p => Drive.getOrCreate(p), create: p => Sandbox.create(p) },
      initialize: initializeDrive, attach: (...args) => AgentRun.attach(...args),
      receipt: () => new Receipt(results, [settings.credentials.token, settings.gatewayKey]), ...dependencies,
    };
  }
  async message(input: MessageInput): Promise<{ status: number; body: unknown }> {
    const admission = await this.store.begin(input, this.fingerprint);
    if (admission.kind === 'duplicate') return { status: admission.job.status === 'running' ? 202 : 200, body: { duplicate: true, job: publicJob(admission.job) } };
    if (admission.kind !== 'accepted') return { status: 409, body: { error: admission.kind } };
    let job = admission.job;
    let dispatched = false;
    const resources: Resource[] = [];
    let receipt: Receipt | undefined;
    let drive: Job['drive'];
    const patch = async (change: Partial<Job>, finish = false) => {
      job = await this.store.patch(input.agent, input.requestId, job.owner, change, finish);
    };
    const services: Platform = {
      drive: async options => {
        assert(options.name && (!drive || drive.name === options.name), 'Controller requires one named agent Drive.');
        drive ??= { name: options.name };
        await patch({ drive: { ...drive } });
        const resolved = await this.dependencies.platform.drive(options);
        drive.id = resolved.driveId;
        await patch({ drive: { ...drive } });
        return resolved;
      },
      create: async options => {
        assert(options?.name, 'Controller requires a named sandbox before allocation.');
        const resource: Resource = { name: options.name!, kind: options.image === 'vercel/sandbox/node:24' ? 'initializer' : 'workload' };
        resources.push(resource);
        await patch({ phase: 'allocating', resources: structuredClone(resources) });
        const box = await this.dependencies.platform.create(options);
        resource.sessionId = box.currentSession().sessionId; resource.image = box.image;
        await patch({ resources: structuredClone(resources) });
        return box;
      },
    };
    try {
      receipt = this.dependencies.receipt();
      receipt.event('controller-start', { agent: input.agent, requestId: input.requestId });
      if (!admission.ready) {
        await this.dependencies.initialize(this.settings, input.agent, receipt, services);
        await this.store.ready(input.agent, job.owner, { fingerprint: this.fingerprint });
      }
      const run = await this.dependencies.attach(this.settings, input.agent, receipt, { services, image: admission.ready?.image });
      await this.store.ready(input.agent, job.owner, { fingerprint: this.fingerprint, image: run.sandbox.image });
      await patch({ phase: 'starting' });
      await run.start();
      await patch({ phase: 'dispatching' });
      dispatched = true;
      const reply = await run.turn(sessionId(input.conversation), input.message);
      await patch({ phase: 'reply-recorded', reply: reply.text, nativeSessionId: reply.sessionId });
      await run.quiesce();
      await patch({ phase: 'gateway-quiesced' });
      await run.stop();
      await patch({ phase: 'detached', status: 'completed' }, true);
      try { receipt.finish('passed', { requestId: input.requestId, job: publicJob(job) }); }
      catch { /* Redis already contains the completed result. */ }
      return { status: 200, body: { duplicate: false, job: publicJob(job) } };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), [this.settings.credentials.token, this.settings.gatewayKey]);
      try {
        receipt?.event('controller-failure', { requestId: input.requestId, message, resources, drive });
        receipt?.finish('failed', { requestId: input.requestId, message, resourcesPreserved: true });
      } catch { /* Local diagnostics must not prevent durable finalization. */ }
      try { await patch({ status: dispatched ? 'interrupted' : 'failed', error: message,
        resources: structuredClone(resources), ...(drive ? { drive: { ...drive } } : {}) }, true); }
      catch { return { status: 503, body: { requestId: input.requestId, error: 'Request outcome is uncertain. Inspect saved status and resources; do not retry with a new ID.' } }; }
      return { status: 503, body: { job: publicJob(job) } };
    }
  }
}
