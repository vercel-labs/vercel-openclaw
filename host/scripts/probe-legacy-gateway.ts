/**
 * What happens when the host targets a gateway that PREDATES the suspend API
 * (anything before 2026.7.2)? Runs the real wake path against the image, then
 * calls gateway.suspend.prepare and prints the raw response so the host can
 * degrade gracefully instead of throwing an unrecognized-response error.
 *
 * Usage from host/:
 *   OPENCLAW_IMAGE=<pre-2026.7.2 ref> OPENCLAW_GATEWAY_TOKEN=<t> \
 *     npx tsx --env-file=.env.local scripts/probe-legacy-gateway.ts
 */
import { ensureAwake } from '../lib/wake';
import { createSandboxGatewayCaller } from '../lib/suspend';

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-probe-legacy';
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

async function main() {
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN required');
  console.log(`image: ${process.env.OPENCLAW_IMAGE ?? '(default)'}`);

  let awake;
  try {
    awake = await ensureAwake(SANDBOX_NAME);
  } catch (err) {
    console.log('\nensureAwake FAILED against this image (also a finding):');
    console.log(String(err).slice(0, 1200));
    return;
  }

  try {
    const v = await awake.sandbox.runCommand('openclaw', ['--version']);
    console.log('version:', (await v.stdout()).trim());

    const call = createSandboxGatewayCaller(awake.sandbox, token);
    console.log('\ncalling gateway.suspend.prepare on a pre-suspension gateway...');
    try {
      const raw = await call('gateway.suspend.prepare', { requestId: 'legacy-probe' });
      console.log('returned (no throw):', JSON.stringify(raw).slice(0, 600));
    } catch (err) {
      console.log('caller threw:');
      console.log(String(err).slice(0, 600));
    }

    // Raw CLI view too, so the exact envelope is on record.
    const rawCli = await awake.sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `openclaw gateway call gateway.suspend.prepare --url ws://127.0.0.1:3000 --token "$OPENCLAW_GATEWAY_TOKEN" --json --params '{"requestId":"legacy-probe-raw"}' --timeout 8000; echo "EXIT=$?"`,
      ],
      env: { OPENCLAW_GATEWAY_TOKEN: token },
    });
    console.log('\nraw CLI stdout:', (await rawCli.stdout()).slice(0, 800));
    console.log('raw CLI stderr:', (await rawCli.stderr()).slice(0, 400));
  } finally {
    await awake.sandbox.stop();
    console.log('\nsandbox stopped.');
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err);
  process.exit(1);
});
