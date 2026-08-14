/**
 * Live end-to-end validation of the suspend/wake lifecycle, using the real
 * host code (lib/wake.ts, lib/suspend.ts) against a real sandbox.
 *
 * Usage (any linked Vercel project for OIDC):
 *   OPENCLAW_IMAGE=<image-ref> OPENCLAW_GATEWAY_TOKEN=<token> \
 *     npx tsx --env-file=.env.local scripts/e2e-lifecycle.ts
 *
 * Runs the production sequence twice: create/resume + gateway boot + health,
 * then prepare -> ready -> stop (snapshot). The second cycle proves the
 * snapshot-restore + gateway-restart path.
 *
 * NOTE deliberately not exercised here: lease renewal, cancel (resume), and
 * the conflict shape. Observed live 2026-08-11 on 2026.7.2-beta.7: once
 * prepare returns ready, the gateway's WebSocket listener goes down and does
 * not come back at lease expiry (process survives, port closed) — so any
 * post-ready call fails with a transport error. The production idle path is
 * unaffected (after ready the host only calls sandbox.stop()), but this is
 * upstream contract question 6 territory; re-add those steps once fixed.
 */
import { ensureAwake } from '../lib/wake';
import { attemptSuspend, createSandboxGatewayCaller } from '../lib/suspend';

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-e2e';
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

function step(name: string) {
  console.log(`\n=== ${name}`);
}

async function cycle(label: string) {
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN required');

  step(`${label}: ensureAwake (sandbox + gateway + health)`);
  const t0 = Date.now();
  const awake = await ensureAwake(SANDBOX_NAME);
  console.log(`awake in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  step(`${label}: attemptSuspend (prepare -> ready -> stop, the real idle path)`);
  const call = createSandboxGatewayCaller(awake.sandbox, token);
  // A freshly-woken gateway can truthfully report busy while its own startup
  // work drains (the idle cron would simply come back on a later tick), so
  // model that: retry busy a few times before treating it as a failure.
  let decision;
  for (let attempt = 1; ; attempt++) {
    decision = await attemptSuspend({
      call,
      stop: async () => {
        await awake.sandbox.stop();
      },
      requestId: `e2e-${label}`,
    });
    console.log(`decision (attempt ${attempt}):`, JSON.stringify(decision));
    if (decision.action === 'stop' || attempt >= 6) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (decision.action !== 'stop') {
    throw new Error(`expected stop after retries, got ${decision.action}`);
  }
  console.log('sandbox stopped, disk snapshotted');
}

async function main() {
  console.log(`image: ${process.env.OPENCLAW_IMAGE ?? '(default)'}  sandbox: ${SANDBOX_NAME}`);
  await cycle('cycle1');
  step('cycle2 proves snapshot-restore + gateway restart (onResume)');
  await cycle('cycle2');
  console.log('\nE2E COMPLETE: two full sleep/wake cycles through the production code path');
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
