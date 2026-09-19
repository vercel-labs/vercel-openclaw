import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const scenario = process.argv[2];
assert(['repair', 'cancel', 'loss'].includes(scenario));
if (!existsSync('/tmp/ocw-codex-marker')) {
  writeFileSync('/tmp/ocw-codex-local-fallback', 'detected');
  throw new Error('Command ran outside the owned execution worker');
}
if (scenario !== 'repair') {
  writeFileSync(`/tmp/ocw-codex-${scenario}-heartbeat`, String(Date.now()));
  writeFileSync(`/tmp/ocw-codex-${scenario}-started`, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const heartbeat = setInterval(() => writeFileSync(`/tmp/ocw-codex-${scenario}-heartbeat`, String(Date.now())), 200);
  await new Promise(resolve => setTimeout(resolve, 100_000));
  clearInterval(heartbeat);
  throw new Error('Test did not interrupt the active process');
}
const marker = JSON.parse(readFileSync('/tmp/ocw-codex-marker', 'utf8'));
const keys = ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_NPM_AUTHORIZATION', 'OPENCLAW_NPM_AUTH_REGISTRY', 'OC_WORKER_BOOTSTRAP', 'OC_WORKER_ENROLLMENT'];
const result = {
  nonceHash: createHash('sha256').update(marker.nonce).digest('hex'), cwd: process.cwd(),
  administrativeEnvironmentAbsent: keys.every(key => !process.env[key]),
  gatewayCanaryAbsent: !existsSync('/tmp/openclaw-codex-e2e/gateway-only-canary'),
  gatewayConfigAbsent: !existsSync('/tmp/openclaw-codex-e2e/state/openclaw.json'),
};
const gateway = await fetch(`${marker.origin}/__openclaw__/worker-bootstrap/artifacts/${'0'.repeat(64)}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
result.gatewayReachable = gateway.status === 404;
await gateway.body?.cancel();
try {
  const external = await fetch('https://example.com', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  await external.body?.cancel();
  result.externalDenied = false;
} catch { result.externalDenied = true; }
writeFileSync('isolation-result.json', JSON.stringify(result));
process.stdout.write(`WORKER_MARKER=${marker.nonce}\n`);
