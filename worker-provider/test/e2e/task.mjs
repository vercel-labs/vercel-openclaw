import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { probeOperatorAuthority } from './e2e-authority.mjs';

const scenario = process.argv[2];
assert(['success', 'loss', 'cancel', 'restored', 'authority'].includes(scenario));
if (!existsSync('/tmp/ocw-e2e-worker-only')) {
  writeFileSync('/tmp/ocw-e2e-local-fallback', 'detected');
  throw new Error('Task ran outside its enrolled worker');
}
const marker = JSON.parse(readFileSync('/tmp/ocw-e2e-worker-only', 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
if (['loss', 'cancel', 'authority'].includes(scenario)) {
  writeFileSync(`/tmp/ocw-e2e-${scenario}-started`, 'started');
  const timer = setInterval(() => writeFileSync(`/tmp/ocw-e2e-${scenario}-heartbeat`, String(Date.now())), 200);
  await new Promise(resolve => setTimeout(resolve, 100_000));
  clearInterval(timer);
  throw new Error('The test failed to interrupt this task');
}

const result = {
  scenario, nonceHash: digest(marker.nonce), cwd: process.cwd(),
  adminEnvironmentAbsent: ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_NPM_AUTHORIZATION', 'E2E_OPERATOR_TOKEN', 'E2E_MODEL_TOKEN', 'OC_WORKER_BOOTSTRAP', 'OC_WORKER_ENROLLMENT'].every(key => !process.env[key]),
  gatewayFileAbsent: !existsSync('/vercel/sandbox/e2e/gateway-only-canary'),
  gatewayPolicyPathAbsent: !existsSync('/vercel/sandbox/e2e/state/openclaw.json'),
};
result.operatorDenied = await probeOperatorAuthority(marker.gatewayOrigin);
try {
  const response = await fetch(`${marker.gatewayOrigin}/__openclaw__/worker-bootstrap/artifacts/${'0'.repeat(64)}`, { signal: AbortSignal.timeout(10_000) });
  result.gatewayReachable = response.status === 404;
} catch { result.gatewayReachable = false; }
try {
  const response = await fetch('https://example.com/', { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  result.externalDenied = false;
} catch { result.externalDenied = true; }
writeFileSync(`e2e-result-${scenario}.json`, JSON.stringify(result));
process.stdout.write(`E2E_FILE_WRITTEN_${scenario}\n`);
