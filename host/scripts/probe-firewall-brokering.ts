/**
 * Does firewall credential brokering actually work for the model credential?
 *
 * Everything in the Connect-front-door design rests on this: the agent gets
 * model access while the credential never enters the VM. Three things have to
 * be true, and none of them were evidence before this script existed.
 *
 *   1. The firewall replaces the Authorization header on egress to AI Gateway.
 *   2. The VM trusts the per-sandbox CA the firewall installs when it
 *      terminates TLS. This is the one most likely to fail: OpenClaw is a Node
 *      process and Node ships its own CA bundle rather than using the system
 *      store, so it depends on NODE_EXTRA_CA_CERTS being set for us.
 *   3. The real token is absent from the VM's environment.
 *
 * Deliberately does NOT start the OpenClaw gateway. Isolating the firewall from
 * OpenClaw's own config quirks means a failure here has exactly one cause.
 *
 * Usage (from host/, any linked Vercel project for OIDC):
 *   vercel env pull                     # OIDC tokens last 12 hours
 *   npx tsx --env-file=.env.local scripts/probe-firewall-brokering.ts
 */
import { Sandbox } from '@vercel/sandbox';
import {
  AI_GATEWAY_BASE_URL,
  PLACEHOLDER_MODEL_KEY,
  buildNetworkPolicy,
  readOidcToken,
} from '../lib/model-credentials';

const IMAGE = process.env.OPENCLAW_IMAGE ?? 'openclaw-foundation/openclaw/openclaw:latest';

function step(name: string) {
  console.log(`\n=== ${name}`);
}

function verdict(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}`);
  return pass;
}

async function main() {
  const oidcToken = readOidcToken();

  step('create sandbox with strict policy + AI Gateway injection rule');
  const sandbox = await Sandbox.create({
    image: IMAGE,
    timeout: 5 * 60 * 1000,
    networkPolicy: buildNetworkPolicy(oidcToken),
  });
  console.log(`sandbox ${sandbox.name} created from ${IMAGE}`);

  const results: boolean[] = [];

  try {
    // ---------------------------------------------------------------------
    // 1. Node's fetch, which is what OpenClaw itself uses. The decisive test.
    // ---------------------------------------------------------------------
    step('Node fetch to AI Gateway with the placeholder credential');
    const nodeProbe = await sandbox.runCommand({
      cmd: 'node',
      args: [
        '-e',
        `fetch(${JSON.stringify(`${AI_GATEWAY_BASE_URL}/models`)}, {
           headers: { authorization: ${JSON.stringify(`Bearer ${PLACEHOLDER_MODEL_KEY}`)} },
         })
           .then(async (r) => {
             const body = await r.text();
             console.log('status=' + r.status);
             console.log('body-head=' + body.slice(0, 200));
           })
           .catch((e) => { console.log('error=' + (e && e.message)); process.exit(3); });`,
      ],
    });
    const nodeOut = (await nodeProbe.stdout()).trim();
    const nodeErr = (await nodeProbe.stderr()).trim();
    console.log(`exit=${nodeProbe.exitCode}\n${nodeOut}${nodeErr ? `\nstderr: ${nodeErr}` : ''}`);
    results.push(
      verdict(
        'Node reaches AI Gateway with an injected credential',
        nodeProbe.exitCode === 0 && nodeOut.includes('status=200'),
        nodeProbe.exitCode === 0
          ? 'A 200 proves both header injection and CA trust for Node.'
          : 'Non-zero exit. A certificate error here means NODE_EXTRA_CA_CERTS is not reaching Node, ' +
              'and OpenClaw will fail the same way.',
      ),
    );

    // ---------------------------------------------------------------------
    // 2. curl, to separate "the firewall is fine, Node is the problem" from
    //    "injection itself did not happen".
    // ---------------------------------------------------------------------
    step('curl cross-check (distinguishes a Node CA problem from no injection)');
    const curlProbe = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `command -v curl >/dev/null 2>&1 || { echo 'curl-absent'; exit 0; }; ` +
          `curl -sS -o /dev/null -w 'status=%{http_code}\\n' ` +
          `-H 'Authorization: Bearer ${PLACEHOLDER_MODEL_KEY}' ${AI_GATEWAY_BASE_URL}/models`,
      ],
    });
    console.log(
      `exit=${curlProbe.exitCode}\n${(await curlProbe.stdout()).trim()}\n${(await curlProbe.stderr()).trim()}`,
    );

    // ---------------------------------------------------------------------
    // 3. An un-injected domain must be denied, or the policy is not doing its
    //    job and the "credential never leaves" claim means nothing.
    // ---------------------------------------------------------------------
    step('egress to a domain outside the allowlist must be denied');
    const denied = await sandbox.runCommand({
      cmd: 'node',
      args: [
        '-e',
        `fetch('https://example.com')
           .then((r) => { console.log('reached status=' + r.status); })
           .catch((e) => { console.log('blocked=' + (e && e.message)); });`,
      ],
    });
    const deniedOut = (await denied.stdout()).trim();
    console.log(`exit=${denied.exitCode}\n${deniedOut}`);
    results.push(
      verdict(
        'off-allowlist egress is blocked',
        deniedOut.includes('blocked='),
        deniedOut.includes('blocked=')
          ? 'Deny-by-default is in force.'
          : 'example.com was reachable, so the policy is not constraining egress as intended.',
      ),
    );

    // ---------------------------------------------------------------------
    // 4. The whole point: the real token must not exist inside the VM.
    // ---------------------------------------------------------------------
    step('the real OIDC token must be absent from the VM');
    const tokenFragment = oidcToken.slice(0, 24);
    const leak = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        // Search the process environment and anything OpenClaw may have written.
        `{ env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; ` +
          `cat /root/.openclaw/*.json 2>/dev/null; } ` +
          `| grep -c -- '${tokenFragment}' || true`,
      ],
    });
    const leakCount = (await leak.stdout()).trim();
    results.push(
      verdict(
        'no OIDC token material inside the VM',
        leakCount === '0',
        `grep matches for the token's first 24 chars: ${leakCount || '(no output)'}`,
      ),
    );

    step('summary');
    const allPassed = results.every(Boolean);
    console.log(
      allPassed
        ? 'All checks passed. Firewall brokering is a sound basis for the agent turn.'
        : 'At least one check failed. Do NOT build the agent turn on this until resolved.',
    );
    process.exitCode = allPassed ? 0 : 1;
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
