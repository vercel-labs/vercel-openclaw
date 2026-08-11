/**
 * Post-run safety check: confirm the probe sandboxes are not left running.
 * Stops any that are. Usage from host/:
 *   npx tsx --env-file=.env.local scripts/verify-stopped.ts [name ...]
 */
import { Sandbox } from '@vercel/sandbox';

const NAMES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['openclaw-e2e-review', 'sdk-probe-review-1786479651937'];

async function main() {
  for (const name of NAMES) {
    try {
      const s = await Sandbox.get({ name, resume: false });
      console.log(`${name.padEnd(34)} status=${s.status}`);
      if (s.status === 'running') {
        await s.stop();
        console.log(`  -> was running; STOPPED now`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${name.padEnd(34)} (not retrievable) ${msg.slice(0, 60)}`);
    }
  }
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
