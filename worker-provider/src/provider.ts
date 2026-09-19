import { readFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { WorkerProviderError, type WorkerProvider } from 'openclaw/plugin-sdk/plugin-entry';
import { AllocationJournal } from './journal.js';
import { allocationName, networkPolicy, OWNER, parseProfile, profileIntent, type Profile } from './profile.js';

type Options = NonNullable<Parameters<WorkerProvider['provision']>[2]>;
type Enrollment = Awaited<ReturnType<NonNullable<Options['beginNodeEnrollment']>>>;
export type Box = Pick<Sandbox, 'name' | 'status' | 'persistent' | 'tags' | 'runCommand' | 'writeFiles' | 'update' | 'stop'>;
export type Client = {
  checkCredentials?(): void;
  create(profile: Profile, name: string, intent: string, signal?: AbortSignal): Promise<Box>;
  get(profile: Profile, name: string): Promise<Box>;
};

export function controllerToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.OPENCLAW_HOST_CREDENTIALS_PATH
    ? JSON.parse(readFileSync(env.OPENCLAW_HOST_CREDENTIALS_PATH, 'utf8')).token
    : env.VERCEL_TOKEN ?? env.VERCEL_OIDC_TOKEN;
  if (typeof token !== 'string' || !token.trim()) throw new Error('A gateway-only Vercel credential is required.');
  return token;
}

export function sdkClient(): Client {
  const credentials = (profile: Profile) => {
    const token = controllerToken();
    return { token, projectId: profile.projectId, teamId: profile.teamId };
  };
  return {
    checkCredentials() {
      controllerToken();
    },
    create: (profile, name, intent, signal) => Sandbox.create({
      ...credentials(profile), name, ...(profile.workerSnapshot ? { source: { type: 'snapshot' as const, snapshotId: profile.workerSnapshot } } : { image: profile.workerImage ?? 'vercel/sandbox/node:26' }),
      persistent: false, timeout: profile.timeoutMs, ports: [],
      tags: { owner: OWNER, intent }, networkPolicy: networkPolicy(profile, true, process.env.OPENCLAW_NPM_AUTHORIZATION
        ? { registry: process.env.OPENCLAW_NPM_AUTH_REGISTRY ?? '', authorization: process.env.OPENCLAW_NPM_AUTHORIZATION } : undefined), signal,
    }),
    get: (profile, name) => Sandbox.get({ ...credentials(profile), name, resume: false, signal: AbortSignal.timeout(30_000) }),
  };
}

function attest(box: Box, name: string, intent: string): void {
  if (box.name !== name || box.tags?.owner !== OWNER || box.tags?.intent !== intent || box.persistent) {
    throw new Error('Worker ownership or creation policy mismatch; refusing to execute or stop it.');
  }
}

function validateEnrollment(enrollment: Enrollment, profile: Profile): void {
  const artifact = enrollment.nodeBootstrap;
  const url = new URL(artifact.url);
  if (url.origin !== profile.gatewayOrigin || url.username || url.password || url.search || url.hash || url.pathname !== `/__openclaw__/worker-bootstrap/artifacts/${artifact.sha256}` || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 512 * 1024 * 1024) {
    throw new Error('Worker bootstrap artifact does not match the approved gateway origin or integrity contract.');
  }
  if (artifact.tlsFingerprint) throw new Error('This prototype requires a publicly trusted gateway certificate; private TLS pins are not implemented.');
}

export function createVercelWorkerProvider(deps: {
  journal: AllocationJournal;
  client?: Client;
  bootstrap?: (box: Box, enrollment: Enrollment, signal: AbortSignal, profile: Profile) => Promise<void>;
}): WorkerProvider & { dispose(): Promise<void> } {
  const client = deps.client ?? sdkClient();
  const bootstrap = deps.bootstrap ?? runBootstrap;
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  const owned = async (profile: Profile, name: string) => {
    const allocation = deps.journal.get(name);
    if (!allocation || allocation.intent !== profileIntent(profile)) throw new Error('Worker allocation journal is missing or does not match the frozen profile.');
    const box = await client.get(profile, name);
    attest(box, name, allocation.intent);
    return box;
  };
  const provider: WorkerProvider = {
    id: 'vercel-worker', supportedExecutionModes: ['worker-turn', 'remote-exec'],
    provisionBeforeInstallation: true, requiresNodeEnrollment: true,
    resolveProvisionTimeoutMs: () => 900_000,
    resolveDestroyTimeoutMs: () => 150_000,
    async resolveAllocation(profile, operationId) {
      parseProfile(profile);
      return { leaseId: allocationName(operationId), sharedHost: false };
    },
    async provision(input, operationId, options) {
      const profile = parseProfile(input);
      const mode = options?.executionMode;
      if (options?.machineClass !== undefined || (mode !== undefined && mode !== 'worker-turn' && mode !== 'remote-exec')) throw new WorkerProviderError('This provider supports worker-turn and remote-exec with default Vercel sizing.');
      if (!options?.beginNodeEnrollment) throw new WorkerProviderError('Environment-owned node enrollment is required.');
      const signal = AbortSignal.any([shutdown.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(840_000)]);
      signal.throwIfAborted();
      client.checkCredentials?.();
      const name = allocationName(operationId);
      const timed = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        try { return await run(); }
        finally { console.info('vercel worker phase', JSON.stringify({ name, phase, startedAt, durationMs: Date.now() - startedAt })); }
      };
      const { allocation, created } = deps.journal.reserve(name, profileIntent(profile));
      if (['destroying', 'destroyed'].includes(allocation.phase)) throw new WorkerProviderError('This worker allocation is retired; use a new placement.');
      // A lost create response may be adopted by exact name, but never causes a second create.
      const box = created
        ? await timed('create', () => client.create(profile, name, allocation.intent, signal))
        : await owned(profile, name);
      attest(box, name, allocation.intent);
      if (box.status !== 'running') throw new Error('Worker is not running; reclaim this placement before dispatching a replacement.');
      try {
        signal.throwIfAborted();
        const enrollment = await timed('enrollment-begin', () => options.beginNodeEnrollment!());
        const lifetime = enrollment.signal ? AbortSignal.any([signal, enrollment.signal]) : signal;
        lifetime.throwIfAborted();
        validateEnrollment(enrollment, profile);
        if (allocation.phase !== 'active') {
          deps.journal.transition(name, ['creating', 'bootstrapping'], 'bootstrapping');
          await timed('bootstrap', () => bootstrap(box, enrollment, lifetime, profile));
        }
        lifetime.throwIfAborted();
        const deviceId = await timed('enrollment-wait', () => enrollment.waitForDeviceId());
        lifetime.throwIfAborted();
        await timed('firewall', () => box.update({ networkPolicy: networkPolicy(profile, false) }));
        lifetime.throwIfAborted();
        deps.journal.transition(name, ['bootstrapping', 'active'], 'active');
        return { leaseId: name, sharedHost: false, node: { deviceId } };
      } catch (error) {
        // A failed bootstrap is fenced by stopping its whole VM, including detached children.
        try { await provider.destroy({ leaseId: name, profile: input }); }
        catch (cleanupError) { throw WorkerProviderError.cleanupIndeterminate(name, error, cleanupError); }
        throw error;
      }
    },
    async inspect({ leaseId, profile: input }) {
      const profile = parseProfile(input);
      const record = deps.journal.get(leaseId);
      if (record?.intent !== profileIntent(profile)) throw new Error('Worker inspection has no matching allocation journal.');
      if (record.phase === 'destroyed') return { status: 'destroyed' };
      const box = await owned(profile, leaseId);
      if (box.status === 'running') return { status: 'active', sharedHost: false };
      if (box.status === 'stopped') {
        deps.journal.transition(leaseId, ['creating', 'bootstrapping', 'active', 'destroying'], 'destroyed');
        return { status: 'destroyed' };
      }
      return { status: 'unknown' };
    },
    async destroy({ leaseId, profile: input }) {
      const profile = parseProfile(input);
      const record = deps.journal.get(leaseId);
      if (!record) return;
      if (record.intent !== profileIntent(profile)) throw new Error('Cleanup profile differs from the original allocation.');
      if (record.phase === 'destroyed') return;
      deps.journal.transition(leaseId, ['creating', 'bootstrapping', 'active', 'destroying'], 'destroying');
      const box = await owned(profile, leaseId);
      await box.stop({ signal: AbortSignal.timeout(60_000) });
      const stopped = await owned(profile, leaseId);
      if (stopped.status !== 'stopped') throw new Error('Worker shutdown is not confirmed; retry cleanup.');
      deps.journal.transition(leaseId, ['destroying'], 'destroyed');
    },
  };
  const provision = provider.provision;
  const inspect = provider.inspect;
  const destroy = provider.destroy;
  provider.provision = (...args) => track(provision(...args));
  provider.inspect = (...args) => track(inspect(...args));
  provider.destroy = (...args) => track(destroy(...args));
  return Object.assign(provider, {
    async dispose() {
      shutdown.abort();
      await Promise.allSettled(pending);
    },
  });
}

async function runBootstrap(box: Box, enrollment: Enrollment, signal: AbortSignal, profile: Profile): Promise<void> {
  const source = readFileSync(new URL('../assets/bootstrap.mjs', import.meta.url), 'utf8');
  const result = await box.runCommand({
    cmd: 'node', args: ['--input-type=module', '--eval', `${source}\nawait runBootstrapCli();`], signal,
    env: { OC_WORKER_BOOTSTRAP: JSON.stringify(enrollment.nodeBootstrap), OC_WORKER_ENROLLMENT: JSON.stringify({ mode: enrollment.mode, displayName: enrollment.displayName, ...(enrollment.mode === 'connect' ? { setupCode: enrollment.setupCode } : {}) }), OC_WORKER_NPM_POLICY: JSON.stringify({ registry: profile.npmRegistry, minReleaseAgeDays: profile.npmMinReleaseAgeDays, exclusions: profile.npmReleaseAgeExclusions }), ...((profile.workerImage || profile.workerSnapshot) ? { OC_WORKER_PREBUILT_RUNTIME: '/tmp/openclaw-codex-e2e' } : {}) },
  });
  if (result.exitCode !== 0) {
    const phase = (await result.stderr()).match(/Worker bootstrap failed at ([a-z-]+); credentials redacted\./)?.[1];
    const safePhases = ['descriptor', 'download', 'installation', 'image-verification', 'runtime-verification', 'plugin-activation', 'node-launch'];
    throw new Error(`Native worker bootstrap failed${phase && safePhases.includes(phase) ? ` at ${phase}` : ''}; cleanup will stop this disposable worker.`);
  }
}
