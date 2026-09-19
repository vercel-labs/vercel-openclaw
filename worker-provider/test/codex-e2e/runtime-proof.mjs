import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';

assert.equal(process.platform, 'linux');
const processes = [];
const forbiddenKeys = ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_NPM_AUTHORIZATION', 'OC_WORKER_BOOTSTRAP', 'OC_WORKER_ENROLLMENT'];
const secretsAbsent = id => {
  const env = readFileSync(`/proc/${id}/environ`, 'utf8').split('\0');
  return forbiddenKeys.every(key => !env.some(value => value.startsWith(`${key}=`) && value.length > key.length + 1));
};
for (const id of readdirSync('/proc').filter(id => /^\d+$/.test(id))) {
  try {
    const exe = readlinkSync(`/proc/${id}/exe`);
    if (basename(exe) !== 'codex') continue;
    const args = readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0');
    const role = args.includes('exec-server') ? 'exec-server' : args.includes('app-server') ? 'app-server' : undefined;
    if (!role) continue;
    const administrativeEnvironmentAbsent = secretsAbsent(id);
    processes.push({ pid: Number(id), role, sha256: createHash('sha256').update(readFileSync(exe)).digest('hex'), administrativeEnvironmentAbsent });
  } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
}
const result = { processes };
if (process.argv[2]) {
  const origin = new URL(process.argv[2]);
  assert.equal(origin.protocol, 'https:');
  const pid = Number(process.argv[3]);
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  assert.equal(cwd, process.argv[4]);
  assert(basename(readlinkSync(`/proc/${pid}/exe`)) === 'node' && resolve(cwd, args[1]) === resolve(cwd, 'e2e-task.mjs') && args[2] === 'cancel', 'PID does not identify the expected cancellation task');
  const stat = id => readFileSync(`/proc/${id}/stat`, 'utf8').split(') ').at(-1).split(' ');
  const initial = stat(pid);
  let parent = Number(initial[1]);
  const ancestors = new Set();
  for (let depth = 0; parent > 1 && depth < 32; depth++) { ancestors.add(parent); parent = Number(stat(parent)[1]); }
  assert(processes.some(process => process.role === 'exec-server' && ancestors.has(process.pid)), 'Task is not a child of the native exec-server');
  Object.assign(result, {
    task: { pid, startTicks: initial[19], nativeExecAncestor: true, administrativeEnvironmentAbsent: secretsAbsent(pid) },
    gatewayCanaryAbsent: !existsSync('/tmp/openclaw-codex-e2e/gateway-only-canary'),
    gatewayConfigAbsent: !existsSync('/tmp/openclaw-codex-e2e/state/openclaw.json'),
  });
  const response = await fetch(`${origin.origin}/__openclaw__/worker-bootstrap/artifacts/${'0'.repeat(64)}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  result.gatewayReachable = response.status === 404;
  await response.body?.cancel();
  try {
    const external = await fetch('https://example.com', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    await external.body?.cancel();
    result.externalDenied = false;
  } catch { result.externalDenied = true; }
  assert.equal(stat(pid)[19], initial[19], 'Task identity changed during the independent probe');
}
process.stdout.write(JSON.stringify(result));
