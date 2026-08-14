/**
 * Does an OpenClaw agent turn run in a sandbox with the model credential
 * brokered at the firewall, and what does it hand back?
 *
 * scripts/probe-firewall-brokering.ts already proved the plumbing in isolation
 * (injection, CA trust, deny-by-default, no token in the VM). This exercises the
 * production path on top of it: lib/wake.ts to boot and configure, then
 * lib/agent.ts to run a real turn.
 *
 * Four open questions it is meant to answer with evidence:
 *
 *   1. Does a fresh gateway configure non-interactively, or do we hit the
 *      bootstrap failure in docs/suspension-spec.md question 4?
 *   2. Do the `openclaw config set` keys actually land?
 *   3. Which model id reaches AI Gateway? OpenClaw addresses models as
 *      `<provider>/<model>` and AI Gateway expects its own `<vendor>/<model>`,
 *      so a turn either resolves or fails with the gateway's own error.
 *   4. Does `--json` carry OpenClaw's message presentation layer, or text only?
 *
 * Usage (from host/):
 *   vercel env pull                     # OIDC tokens last 12 hours
 *   OPENCLAW_GATEWAY_TOKEN=<token> \
 *     npx tsx --env-file=.env.local scripts/probe-agent-turn.ts
 */
import { runAgentTurn, slackSessionKey } from '../lib/agent';
import { modelConfigEntries, readOidcToken, resolveModel } from '../lib/model-credentials';
import { ensureAwake } from '../lib/wake';

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-probe-turn';
const PROMPT = process.env.OPENCLAW_PROBE_PROMPT ?? 'Reply with exactly: bridge works';

function step(name: string) {
  console.log(`\n=== ${name}`);
}

async function main() {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error('OPENCLAW_GATEWAY_TOKEN required');
  const oidcToken = readOidcToken();

  step('ensureAwake (create/resume + policy + provider config + gateway + health)');
  const t0 = Date.now();
  const awake = await ensureAwake(SANDBOX_NAME);
  console.log(`awake in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const { sandbox } = awake;

  try {
    step('environment facts (records where OpenClaw keeps config)');
    const facts = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', 'echo "whoami=$(whoami)"; echo "home=$HOME"; ls -a "$HOME/.openclaw" 2>&1 | head -20'],
    });
    console.log((await facts.stdout()).trim());

    step('did the provider config keys apply?');
    for (const [key] of modelConfigEntries()) {
      const got = await sandbox.runCommand({ cmd: 'openclaw', args: ['config', 'get', key] });
      const value = (await got.stdout()).trim();
      const stderr = (await got.stderr()).trim();
      console.log(
        `${key} -> exit=${got.exitCode} ${value || (stderr ? `stderr: ${stderr.slice(0, 200)}` : '(empty)')}`,
      );
    }

    step(`run a real turn (model ${resolveModel()})`);
    const sessionKey = slackSessionKey('CPROBE', '1712345678.000100');
    console.log(`session key: ${sessionKey}\nprompt: ${PROMPT}`);
    const turnStart = Date.now();
    let turnFailed: unknown;
    let turnSucceeded = false;
    try {
      const turn = await runAgentTurn({
        sandbox,
        message: PROMPT,
        sessionKey,
        gatewayToken,
      });
      turnSucceeded = true;
      console.log(`turn completed in ${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
      // runAgentTurn returns only after positively identifying the managed
      // gateway envelope; embedded fallback throws instead.
      console.log('ran on the managed gateway: YES');
      console.log(`\nreply:\n${turn.reply}`);
      console.log(
        `\nraw payload keys: ${
          turn.raw && typeof turn.raw === 'object'
            ? Object.keys(turn.raw as Record<string, unknown>).join(', ')
            : '(not an object)'
        }`,
      );
      console.log(`\nfull raw payload:\n${JSON.stringify(turn.raw, null, 2)?.slice(0, 3000)}`);
    } catch (err) {
      turnFailed = err;
      console.log(`turn FAILED after ${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
      console.log(String(err).slice(0, 3000));
    }

    step('gateway log tail (context for a failed turn)');
    const log = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', 'tail -40 /tmp/openclaw-gateway.log 2>/dev/null || echo "(no log)"'],
    });
    console.log((await log.stdout()).trim().slice(-2000));

    step('the brokered token must still be absent from the VM after a real turn');
    const fragment = oidcToken.slice(0, 24);
    const leak = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `{ env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; ` +
          `grep -rh -- '${fragment}' "$HOME/.openclaw" 2>/dev/null; } | grep -c -- '${fragment}' || true`,
      ],
    });
    const leakCount = (await leak.stdout()).trim();
    console.log(`token fragment matches inside the VM: ${leakCount} (expected 0)`);

    step('summary');
    console.log(`turn succeeded: ${turnSucceeded ? 'YES' : 'NO'}`);
    console.log(`ran on the managed gateway: ${turnSucceeded ? 'YES' : 'NO'}`);
    console.log(`credential contained: ${leakCount === '0' ? 'YES' : 'NO'}`);
    // runAgentTurn rejects embedded fallback before returning, so a successful
    // call positively proves the managed gateway path.
    process.exitCode = !turnFailed && turnSucceeded && leakCount === '0' ? 0 : 1;
  } finally {
    step('stop sandbox');
    await sandbox.stop();
    console.log('stopped');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
