import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox';
import { createExecutionBudget, operationTimeoutMs, type ExecutionBudget } from './execution-budget';
import { codexPhaseRunner, retryableReadinessError } from './codex-diagnostics';
import { sleepCapability, sleepUrl } from './codex-sleep-auth';

export const CODEX_BASE = '/tmp/openclaw-codex-e2e';
export const CODEX_OWNER = 'openclaw-connect-codex-v1';
const RESUME_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 45_000;
const TURN_ADMISSION_RESERVE_MS = 235_000 + 3 * 60_000;
const TURN_CLEANUP_RESERVE_MS = 80_000;
// Preserve sleeping state indefinitely while deleting checkpoints beyond the last two.
const SNAPSHOT_RETENTION = { snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0, deleteEvicted: true } };

export function codexRuntimeWindow(timeoutMs: number, now = Date.now()) {
  if (timeoutMs <= TURN_CLEANUP_RESERVE_MS) throw new Error('Insufficient time for a turn and cleanup');
  return { executionDeadlineMs: now + timeoutMs - TURN_CLEANUP_RESERVE_MS };
}

export interface CodexTurnReceipt {
  reply: string;
  sessionId: string;
  worktree: string;
  workerName: string;
  runId: string;
  gatewayStopped: boolean;
  platformSessionId?: string;
  gatewayPid?: number;
  workerReused?: boolean;
  idleTimeoutMs?: number;
  nativeSlackDelivered?: true;
  vm1SnapshotId?: string;
  phases?: { phase: string; at: number }[];
  suspension?: { status: 'ready'; suspensionId: string; expiresAtMs: number };
}

export function parseCodexReceipt(stdout: string, now = Date.now()): CodexTurnReceipt {
  const lines = stdout.split('\n').filter(line => line.startsWith('OPENCLAW_HOST_RESULT='));
  if (lines.length !== 1) throw new Error('Missing unique Codex lifecycle receipt');
  const value = JSON.parse(lines[0].slice('OPENCLAW_HOST_RESULT='.length)) as CodexTurnReceipt;
  const stopped = value.gatewayStopped === true && value.suspension?.status === 'ready' && value.suspension.suspensionId && Number.isFinite(value.suspension.expiresAtMs) && value.suspension.expiresAtMs > now;
  const warm = value.gatewayStopped === false && value.platformSessionId && Number.isSafeInteger(value.gatewayPid) && value.gatewayPid! > 0 && Number.isSafeInteger(value.idleTimeoutMs) && value.idleTimeoutMs! > 0 && value.idleTimeoutMs! <= 45 * 60_000 && value.suspension === undefined;
  if (!value.reply?.trim() || !value.sessionId || !value.workerName || !value.runId || !(stopped || warm)) throw new Error('Incomplete Codex lifecycle receipt');
  return value;
}

export function codexHostPolicy(modelKey: string, slackToken?: string): NetworkPolicy {
  if (!modelKey.trim()) throw new Error('AI_GATEWAY_API_KEY required for Codex');
  // VM1 is the trusted controller; VM2 retains the provider's gateway-only egress policy.
  return { allow: { 'ai-gateway.vercel.sh': [{ transform: [{ headers: { Authorization: `Bearer ${modelKey}` } }] }],
    ...(slackToken ? { 'slack.com': [{ match: { path: { startsWith: '/api/' }, method: ['GET', 'POST'] }, transform: [{ headers: { Authorization: `Bearer ${slackToken}` } }] }] } : {}), '*': [] } };
}

export function codexRegistryEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const authorization = env.OPENCLAW_NPM_AUTHORIZATION;
  const registry = env.OPENCLAW_NPM_AUTH_REGISTRY;
  if (!authorization && !registry) return {};
  if (!authorization || !registry) throw new Error('Complete scoped registry credential required');
  const url = new URL(registry);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid registry credential scope');
  return { OPENCLAW_NPM_AUTHORIZATION: authorization, OPENCLAW_NPM_AUTH_REGISTRY: registry };
}

export interface LifecycleSteps {
  execute: () => Promise<CodexTurnReceipt>;
  onNativeDelivered?: () => void;
  publish: (reply: string) => Promise<void>;
  stop: () => Promise<void>;
  isStopped: () => Promise<boolean>;
}

export async function finishCodexLifecycle(steps: LifecycleSteps): Promise<CodexTurnReceipt> {
  const receipt = await steps.execute();
  try {
    if (receipt.nativeSlackDelivered) steps.onNativeDelivered?.();
    if (!receipt.nativeSlackDelivered) await steps.publish(receipt.reply);
  } finally {
    // The runtime has reconciled VM2, fenced work and exited the gateway before returning.
    if (receipt.gatewayStopped) await steps.stop();
  }
  if (receipt.gatewayStopped && !(await steps.isStopped())) throw new Error('VM1 stop is not confirmed');
  return receipt;
}

export async function runCodexLifecycle(options: {
  name: string;
  sessionKey: string;
  eventId: string;
  message: string;
  nativeSlack?: { rawBody: string; token: string };
  onNativeDelivered?: () => void;
  oidcToken: string;
  budget?: ExecutionBudget;
  publish: (reply: string) => Promise<void>;
}): Promise<CodexTurnReceipt> {
  const phase = codexPhaseRunner(options.eventId);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const runtimeDigest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  const modelKey = process.env.AI_GATEWAY_API_KEY;
  const callbackUrl = sleepUrl();
  await phase('config', () => {
    if (!gatewayToken || !runtimeDigest?.match(/^[a-f0-9]{64}$/) || !projectId || !teamId || !modelKey) throw new Error('Codex host configuration is incomplete');
  });
  const budget = options.budget ?? createExecutionBudget();
  const credentials = { token: options.oidcToken, projectId: projectId!, teamId: teamId! };
  const signal = (capMs: number, reserveReply = true) => AbortSignal.timeout(operationTimeoutMs(budget, 'Codex host', { capMs, reserveReply }));
  const get = (resume: boolean, reserveReply = true) => Sandbox.get({ ...credentials, name: options.name, resume, signal: signal(resume ? RESUME_TIMEOUT_MS : 10_000, reserveReply) });
  const owned = (box: Sandbox) => box.persistent && box.tags?.owner === CODEX_OWNER && box.tags?.runtime === runtimeDigest;
  let sandbox = await phase('inspect', () => get(false));
  await phase('ownership', () => {
    if (!owned(sandbox)) throw new Error('Refusing an unowned or mismatched Codex sandbox');
    if (!['stopped', 'running'].includes(sandbox.status)) throw new Error('Codex sandbox is transitioning; retry after it settles');
  });
  if (sandbox.status === 'running' && sandbox.expiresAt && sandbox.expiresAt.getTime() - Date.now() <= TURN_ADMISSION_RESERVE_MS) {
    const result = await stopCodexSession({ name: options.name, platformSessionId: sandbox.currentSession().sessionId, oidcToken: options.oidcToken, rollover: true });
    if (result.action !== 'sleep') throw new Error('Platform deadline rollover is blocked by active work');
    sandbox = await get(false);
  }
  const cold = sandbox.status === 'stopped';
  const previousSession = sandbox.currentSession().sessionId;
  await phase('policy', () => sandbox.update({ ...SNAPSHOT_RETENTION, networkPolicy: codexHostPolicy(modelKey!, options.nativeSlack?.token) }, { signal: signal(10_000) }));
  const startupStep = async <T>(name: 'resume' | 'readiness', operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await phase(name, operation); }
      catch (error) {
        if (attempt !== 0 || !retryableReadinessError((error as Error).cause)) throw error;
      }
    }
  };
  try {
    if (cold) sandbox = await startupStep('resume', () => get(true));
    await phase('ownership', () => {
      if (!owned(sandbox) || (cold && sandbox.currentSession().sessionId === previousSession)) throw new Error('Resumed sandbox identity is unconfirmed');
    });
    // Only named wake and the side-effect-free probe may retry; never the runtime.
    await startupStep('readiness', async () => {
      const result = await sandbox.currentSession().runCommand({ cmd: 'true', signal: signal(20_000), timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error('Readiness command failed');
    });
  } catch (error) {
    if (!cold) throw error;
    try {
      await phase('startup-cleanup', async () => {
        const current = await get(false);
        if (!owned(current)) throw new Error('Startup cleanup ownership is unconfirmed');
        if (current.status === 'stopped') return;
        if (current.status !== 'running' || current.currentSession().sessionId === previousSession) throw new Error('Startup cleanup session is unconfirmed');
        // No runtime has been submitted; the held admission lease owns this empty wake.
        try {
          await phase('stop', () => current.stop({ signal: signal(STOP_TIMEOUT_MS) }));
        } catch (stopError) {
          if ((await get(false)).status === 'stopped') return;
          throw stopError;
        }
        if ((await get(false)).status !== 'stopped') throw new Error('Startup cleanup stop is unconfirmed');
      });
    } catch { /* The cleanup phase records its own failure; retain the original cause. */ }
    throw error;
  }
  let vm1SnapshotId: string | undefined;
  const receipt = await finishCodexLifecycle({
    execute: async () => {
      const timeoutMs = operationTimeoutMs(budget, 'Codex lifecycle', { capMs: 265_000 });
      const window = codexRuntimeWindow(timeoutMs);
      const result = await phase('runtime', () => sandbox.currentSession().runCommand({ cmd: 'node', args: [`${CODEX_BASE}/runtime/turn.mjs`], cwd: CODEX_BASE,
        timeoutMs, signal: AbortSignal.timeout(timeoutMs), env: {
          ...(options.nativeSlack ? {} : codexRegistryEnvironment(process.env)),
          OPENCLAW_GATEWAY_TOKEN: gatewayToken!, VERCEL_OIDC_TOKEN: options.oidcToken,
          OPENCLAW_HOST_INPUT: JSON.stringify({ runtimeDigest, origin: sandbox.domain(3000), ...window, platformSessionId: sandbox.currentSession().sessionId, hardDeadlineMs: sandbox.expiresAt?.getTime(), sleepUrl: callbackUrl, sleepCapability: sleepCapability(options.name, sandbox.currentSession().sessionId, runtimeDigest!), sessionKey: options.sessionKey, eventId: options.eventId, message: options.message, ...(options.nativeSlack ? { slackRawBody: options.nativeSlack.rawBody } : {}) }),
        } }));
      return phase('receipt', async () => {
        if (result.exitCode !== 0) throw new Error(`Codex runtime exit ${result.exitCode}; successful sleep/wake is unconfirmed`);
        const receipt = parseCodexReceipt(await result.stdout({ signal: signal(5000) }));
        if (!receipt.gatewayStopped && receipt.platformSessionId !== sandbox.currentSession().sessionId) throw new Error('Runtime receipt belongs to another platform session');
        if (options.nativeSlack && receipt.nativeSlackDelivered !== true) throw new Error('Native Slack delivery is unconfirmed');
        return receipt;
      });
    },
    publish: reply => phase('publish', () => options.publish(reply)),
    onNativeDelivered: options.onNativeDelivered,
    stop: () => phase('stop', async () => { await sandbox.stop({ signal: signal(STOP_TIMEOUT_MS, false) }); }),
    isStopped: () => phase('confirm', async () => {
      const stopped = await get(false, false);
      if (!owned(stopped) || stopped.status !== 'stopped') throw new Error('VM1 stop is not confirmed');
      if (!stopped.currentSnapshotId) throw new Error('VM1 snapshot is not confirmed');
      const snapshot = await Snapshot.get({ ...credentials, snapshotId: stopped.currentSnapshotId, signal: signal(10_000, false) });
      if (snapshot.status !== 'created' || snapshot.sourceSessionId !== sandbox.currentSession().sessionId) throw new Error('VM1 snapshot is not confirmed');
      if (snapshot.expiresAt !== undefined) throw new Error('VM1 snapshot retention is not confirmed');
      vm1SnapshotId = snapshot.snapshotId;
      return true;
    }),
  });
  return { ...receipt, vm1SnapshotId };
}

export async function stopCodexSession(options: { name: string; platformSessionId: string; oidcToken: string; rollover?: boolean }) {
  const runtimeDigest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST!;
  const credentials = { token: options.oidcToken, projectId: process.env.VERCEL_PROJECT_ID!, teamId: process.env.VERCEL_TEAM_ID! };
  const get = () => Sandbox.get({ ...credentials, name: options.name, resume: false, signal: AbortSignal.timeout(10_000) });
  const sandbox = await get();
  if (!sandbox.persistent || sandbox.tags?.owner !== CODEX_OWNER || sandbox.tags?.runtime !== runtimeDigest) throw new Error('Sleep ownership mismatch');
  if (sandbox.currentSession().sessionId !== options.platformSessionId || sandbox.status !== 'running') return { action: 'stale' };
  const result = await sandbox.currentSession().runCommand({ cmd: 'node', args: [`${CODEX_BASE}/runtime/turn.mjs`], cwd: CODEX_BASE, timeoutMs: 120_000, signal: AbortSignal.timeout(125_000), env: {
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN!, VERCEL_OIDC_TOKEN: options.oidcToken,
    OPENCLAW_HOST_INPUT: JSON.stringify({ action: 'sleep', runtimeDigest, platformSessionId: options.platformSessionId, rollover: options.rollover === true }),
  } });
  if (result.exitCode !== 0) throw new Error('Resident sleep failed');
  const lines = (await result.stdout()).split('\n').filter(line => line.startsWith('OPENCLAW_HOST_RESULT='));
  if (lines.length !== 1) throw new Error('Missing sleep receipt');
  const receipt = JSON.parse(lines[0].slice('OPENCLAW_HOST_RESULT='.length));
  if (receipt.platformSessionId !== options.platformSessionId || receipt.runtimeDigest !== runtimeDigest) throw new Error('Stale sleep receipt');
  if (['none', 'busy'].includes(receipt.action)) return { action: receipt.action as string };
  // The resident permanently rejects turns after confirmed process exit, even if the gateway lease has since expired.
  if (receipt.action !== 'sleep' || receipt.gatewayStopped !== true || receipt.residentFenced !== true || receipt.workerStopped !== true || receipt.suspension?.status !== 'ready' || !receipt.suspension.suspensionId) throw new Error('Invalid suspension fence');
  const current = await get();
  if (current.status !== 'running' || current.currentSession().sessionId !== options.platformSessionId) throw new Error('Session changed before stop');
  await current.update(SNAPSHOT_RETENTION, { signal: AbortSignal.timeout(10_000) });
  await current.stop({ signal: AbortSignal.timeout(STOP_TIMEOUT_MS) });
  const stopped = await get();
  if (stopped.status !== 'stopped' || stopped.currentSession().sessionId !== options.platformSessionId || !stopped.currentSnapshotId) throw new Error('VM1 stop is not confirmed');
  const snapshot = await Snapshot.get({ ...credentials, snapshotId: stopped.currentSnapshotId, signal: AbortSignal.timeout(10_000) });
  if (snapshot.status !== 'created' || snapshot.sourceSessionId !== options.platformSessionId) throw new Error('VM1 snapshot is not confirmed');
  if (snapshot.expiresAt !== undefined) throw new Error('VM1 snapshot retention is not confirmed');
  return { action: 'sleep', reason: receipt.reason, platformSessionId: options.platformSessionId, snapshotId: snapshot.snapshotId };
}
