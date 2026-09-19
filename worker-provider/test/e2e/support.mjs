import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OPENCLAW_VERSION = '2026.9.2';
export const OPENCLAW_SHA256 = '3431f4cd2d8dbd6b936def2694ac27e19fa0256295cf4ada0f652ecf1c9ee520';
export const OPENCLAW_INTEGRITY = 'sha512-M6C7UsnX815nv26qBJFYGe6aGzv+ftZLRzV6S9oRXUtXg2Yn67eVntpssT94kgkquKVSeUxerUg0j1ONp4WYQg==';
export const VM_TIMEOUT = 45 * 60_000;
export const OWNER = 'openclaw-native-e2e-v1';
export const REQUIRED = ['public-auth', 'native-enrollment', 'worker-execution', 'workspace-reconciliation', 'guardrails', 'admitted-worker-rpc', 'worker-loss', 'redispatch', 'cancellation', 'native-reclaim', 'cleanup'];
export const hash = value => createHash('sha256').update(value).digest('hex');

export function assertRetainedSnapshot(snapshot, sourceSessionId) {
  assert(snapshot.snapshotId && snapshot.status === 'created', 'Snapshot is not ready');
  assert(sourceSessionId && snapshot.sourceSessionId === sourceSessionId, 'Snapshot source session differs');
  assert.equal(snapshot.expiresAt, undefined, 'Snapshot must not expire');
}

export function settings(env, mode = 'fixture', now = Date.now()) {
  assert(['fixture', 'model'].includes(mode), 'Unknown E2E mode');
  assert.equal(env.OPENCLAW_E2E_RUN, '1', 'Set OPENCLAW_E2E_RUN=1 to opt into paid disposable tests');
  assert(/^prj_[A-Za-z0-9]+$/.test(env.VERCEL_PROJECT_ID ?? ''), 'Explicit VERCEL_PROJECT_ID required');
  assert(/^team_[A-Za-z0-9]+$/.test(env.VERCEL_TEAM_ID ?? ''), 'Explicit VERCEL_TEAM_ID required');
  assert(env.OPENCLAW_E2E_PROJECT_NAME, 'Explicit OPENCLAW_E2E_PROJECT_NAME required');
  const token = env.VERCEL_TOKEN || env.VERCEL_OIDC_TOKEN;
  assert(token, 'Gateway-only Sandbox credential required');
  if (!env.VERCEL_TOKEN) {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.equal(claims.project_id, env.VERCEL_PROJECT_ID, 'OIDC project mismatch');
    assert.equal(claims.owner_id, env.VERCEL_TEAM_ID, 'OIDC team mismatch');
    assert.equal(claims.project, env.OPENCLAW_E2E_PROJECT_NAME, 'OIDC project name mismatch');
    assert(Number.isFinite(claims.exp) && claims.exp * 1000 > now + VM_TIMEOUT + 300_000, 'Refresh the test-project OIDC token before running');
  }
  assert(isAbsolute(env.OPENCLAW_E2E_RESULTS_DIR ?? ''), 'Explicit absolute OPENCLAW_E2E_RESULTS_DIR required');
  const results = resolve(env.OPENCLAW_E2E_RESULTS_DIR);
  assert(!results.startsWith(resolve(ROOT) + '/') || results.startsWith(join(resolve(ROOT), 'results') + '/'), 'Repository results must be inside ignored results/');
  if (mode === 'model') {
    assert(env.AI_GATEWAY_API_KEY, 'Existing AI_GATEWAY_API_KEY required for the live-model smoke');
    assert(/^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/.test(env.OPENCLAW_E2E_MODEL ?? ''), 'Explicit OPENCLAW_E2E_MODEL required');
  }
  const age = Number(env.OPENCLAW_E2E_NPM_MIN_AGE ?? 2);
  assert(Number.isFinite(age) && age >= 2 && age <= 365, 'Test installs retain a minimum two-day dependency age');
  const exceptions = (env.OPENCLAW_E2E_NPM_EXCEPTIONS ?? '').split(',').filter(Boolean);
  assert(exceptions.every(name => ['openclaw', '@openclaw/ai'].includes(name)), 'Only explicitly approved pinned release exceptions are supported');
  return {
    mode, results, token, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID,
    projectName: env.OPENCLAW_E2E_PROJECT_NAME, model: env.OPENCLAW_E2E_MODEL,
    modelKey: mode === 'model' ? env.AI_GATEWAY_API_KEY : undefined,
    npmAge: age, npmExceptions: exceptions,
    credentials: { token, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID },
  };
}

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/((?:token|apiKey|setupCode|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export function builtArtifacts() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/openclaw']?.version, OPENCLAW_VERSION, 'OpenClaw lock pin differs');
  assert.equal(lock.packages['node_modules/openclaw']?.integrity, OPENCLAW_INTEGRITY, 'OpenClaw published integrity differs');
  assert.equal(lock.packages['node_modules/@vercel/sandbox']?.version, '3.2.1', 'Sandbox lock pin differs');
  assert.equal(lock.packages['node_modules/@openclaw/ai']?.version, OPENCLAW_VERSION, 'AI dependency lock pin differs');
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/openclaw/package.json'), 'utf8'));
  assert.equal(installed.version, OPENCLAW_VERSION, 'Installed OpenClaw differs');
  const build = JSON.parse(readFileSync(join(ROOT, 'node_modules/openclaw/dist/build-info.json'), 'utf8'));
  assert.equal(build.commit, '3928bad9badfcb6c7d140530435e806fb8092190', 'Published OpenClaw build revision differs');
  for (const file of ['dist/index.js', 'dist/provider.js', 'dist/profile.js', 'dist/journal.js']) assert(existsSync(join(ROOT, file)), `Build required: ${file}`);
  const harness = readdirSync(join(ROOT, 'test/e2e')).filter(file => file.endsWith('.mjs')).sort().map(file => `test/e2e/${file}`);
  return Object.fromEntries(['package.json', 'package-lock.json', 'openclaw.plugin.json', 'dist/index.js', 'dist/provider.js', 'dist/profile.js', 'dist/journal.js', 'assets/bootstrap.mjs', ...harness].map(file => [file, hash(readFileSync(join(ROOT, file)))]));
}

export function rpcResult(output) {
  const lines = output.split('\n').filter(line => line.startsWith('E2E_RPC_RESULT='));
  assert.equal(lines.length, 1, 'Expected one unambiguous native RPC result');
  return JSON.parse(lines[0].slice('E2E_RPC_RESULT='.length));
}

export function testOperatorPairing(failure, list) {
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'NOT_PAIRED', 'Expected the test operator pairing request');
  const requestId = failure.message?.match(/device pairing required \(requestId: ([a-f0-9-]{36})\)/)?.[1];
  assert(requestId, 'Missing exact operator pairing request id');
  assert.equal(list.pending?.length, 1, 'Unexpected pending device in isolated gateway');
  const pending = list.pending[0];
  assert.equal(pending.requestId, requestId);
  assert.equal(pending.clientId, 'cli');
  assert.equal(pending.role, 'operator');
  assert.deepEqual(pending.scopes, ['operator.read']);
  assert(typeof pending.deviceId === 'string' && pending.deviceId.length > 0);
  return { requestId, deviceId: pending.deviceId };
}

export function observablePolicy(policy) {
  const value = structuredClone(policy);
  for (const rules of Object.values(value.allow)) for (const rule of rules) for (const transform of rule.transform ?? []) {
    for (const key of Object.keys(transform.headers ?? {})) transform.headers[key] = '<redacted>';
  }
  return value;
}

export function assertCancellationAck(ack, runId) {
  assert(ack?.aborted === true, 'Gateway did not acknowledge cancellation');
  assert(Array.isArray(ack.runIds) && ack.runIds.every(id => typeof id === 'string') && ack.runIds.includes(runId), 'Cancellation did not acknowledge the exact run');
}

export function assertNativeReceipt(receipt, config, artifacts) {
  assert.equal(receipt.status, 'passed', 'Run the deterministic native test first');
  assert.equal(receipt.mode, 'fixture');
  assert.equal(receipt.projectId, config.projectId);
  assert.equal(receipt.teamId, config.teamId);
  assert.deepEqual(receipt.artifacts, artifacts, 'Native proof must use these exact built artifacts');
  assert.equal(receipt.resources.length, 3);
  assert(receipt.resources.every(resource => resource.cleanup === 'stopped'));
  assert(REQUIRED.every(name => receipt.assertions.some(check => check.name === name)));
}

/** @param {() => Promise<unknown>} probe @param {{timeout?: number, interval?: number, signal?: AbortSignal, label?: string}} options */
export async function until(probe, { timeout = 60_000, interval = 1000, signal, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  do {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export class Receipt {
  constructor(directory, secrets = [], required = REQUIRED) {
    assert(!existsSync(directory), 'Use a fresh results directory for each run');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.secrets = secrets;
    this.required = required;
    this.data = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', assertions: [], resources: [], missingAssertions: [], notTested: ['gateway sleep/wake', 'webhook delivery', 'customer host', 'OAuth refresh'] };
    this.save();
  }
  save() { writeFileSync(join(this.directory, 'receipt.json'), redact(JSON.stringify(this.data, null, 2), this.secrets), { mode: 0o600 }); }
  check(name, details = {}) {
    this.data.assertions.push({ name, at: new Date().toISOString(), ...details });
    this.save();
    process.stdout.write(`PASS ${name}\n`);
  }
  intent(name, tags) {
    if (this.data.resources.some(r => r.name === name)) return;
    this.data.resources.push({ name, tags, cleanup: 'unconfirmed' });
    this.save();
  }
  log(name, value) { writeFileSync(join(this.directory, `${name}.log`), redact(value, this.secrets), { mode: 0o600 }); }
  finish(error) {
    const clean = this.data.resources.every(r => r.cleanup === 'stopped');
    this.data.missingAssertions = this.required.filter(name => !this.data.assertions.some(check => check.name === name));
    this.data.status = error || !clean || this.data.missingAssertions.length ? 'failed' : 'passed';
    if (error) this.data.error = redact(error.stack ?? error, this.secrets);
    this.data.finishedAt = new Date().toISOString();
    this.save();
    assert.equal(this.data.status, 'passed', 'E2E failed; inspect the redacted receipt');
  }
}

export async function stopOwned(Sandbox, credentials, record) {
  const get = () => Sandbox.get({ ...credentials, name: record.name, resume: false, signal: AbortSignal.timeout(30_000) });
  const box = await get();
  assert.equal(box.name, record.name, 'Cleanup name mismatch');
  assert.equal(box.persistent, false, 'Refusing cleanup of a persistent resource');
  for (const [key, value] of Object.entries(record.tags)) assert.equal(box.tags?.[key], value, 'Cleanup ownership mismatch');
  if (box.status !== 'stopped') await box.stop({ signal: AbortSignal.timeout(60_000) });
  assert.equal((await get()).status, 'stopped', 'Stopped state not confirmed');
  record.cleanup = 'stopped';
}
