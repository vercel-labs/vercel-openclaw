/**
 * Can OpenClaw's own Slack channel handle a payload we forward, with a
 * signature we generate, and no real Slack credential in the VM?
 *
 * This is the design Patrick Erichsen argued for on 2026-08-14: "We need the
 * full Slack payload imo, otherwise users can't configure things like allow/deny
 * lists, approvals, etc - would be pretty bricked. But I don't think that needs
 * to imply that the credentials live inside the VM?"
 *
 * If it holds, the host stops being a Slack bot and becomes a power switch:
 * OpenClaw owns sessions, identity, allow/deny, approvals and presentation, and
 * roughly a thousand lines of Slack-specific code on our side goes away.
 *
 * Four questions, none of them currently evidence:
 *
 *   1. Can the Slack channel be configured non-interactively (`openclaw config
 *      set`) with mode=http and a webhook path?
 *   2. Does the gateway then serve that path at all?
 *   3. Does it accept a request signed with a secret WE generated, rather than
 *      Slack's own? That is what makes re-signing viable, since Vercel Connect
 *      has already consumed Slack's signature by the time we see the event.
 *   4. Does a bad signature get rejected? A channel that accepts anything would
 *      make the gateway's public port an open door.
 *
 * A real reply cannot succeed here: there is no genuine Slack workspace token,
 * so posting back will fail at Slack. Accepting the event is the thing under
 * test, not the reply.
 *
 * Usage (from host/):
 *   vercel env pull
 *   OPENCLAW_GATEWAY_TOKEN=<token> \
 *     npx tsx --env-file=.env.local scripts/probe-slack-channel-passthrough.ts
 */
import { createHmac, randomBytes } from 'node:crypto';
import { PLACEHOLDER_MODEL_KEY, readOidcToken } from '../lib/model-credentials';
import { GATEWAY_PORT, ensureAwake } from '../lib/wake';

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-probe-passthrough';
const WEBHOOK_PATH = '/slack/events';

function step(name: string) {
  console.log(`\n=== ${name}`);
}

/** A minimal but realistic Slack Events API app_mention envelope. */
function slackEventBody(): string {
  return JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${randomBytes(6).toString('hex')}`,
    team_id: 'T0PROBE',
    api_app_id: 'A0PROBE',
    event: {
      type: 'app_mention',
      user: 'U0PROBE',
      channel: 'C0PROBE',
      ts: `${Math.floor(Date.now() / 1000)}.000100`,
      text: '<@U0BOT> reply with exactly: passthrough works',
    },
  });
}

/** Slack's v0 scheme, which is what OpenClaw verifies with `signingSecret`. */
function signSlack(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
}

async function main() {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error('OPENCLAW_GATEWAY_TOKEN required');
  readOidcToken();

  // Generated per deployment, known only to the host and the gateway. It is not
  // Slack's secret and never leaves our two components.
  const signingSecret = `probe-${randomBytes(24).toString('hex')}`;

  step('wake the sandbox (create/resume + policy + gateway)');
  const { sandbox } = await ensureAwake(SANDBOX_NAME);

  const results: Array<[string, boolean, string]> = [];

  try {
    step('configure OpenClaw Slack channel for HTTP with our generated secret');
    const config: Array<[string, string]> = [
      ['channels.slack.mode', 'http'],
      ['channels.slack.signingSecret', signingSecret],
      ['channels.slack.webhookPath', WEBHOOK_PATH],
      // Placeholder. In production the firewall injects the real Connect-minted
      // token on egress to slack.com, exactly as it already does for AI Gateway.
      ['channels.slack.botToken', `xoxb-${PLACEHOLDER_MODEL_KEY}`],
    ];
    for (const [key, value] of config) {
      const r = await sandbox.runCommand({ cmd: 'openclaw', args: ['config', 'set', key, value] });
      const err = (await r.stderr()).trim();
      console.log(`${key} -> exit=${r.exitCode}${err ? ` stderr: ${err.slice(0, 300)}` : ''}`);
      if (r.exitCode !== 0) results.push([`config ${key}`, false, err.slice(0, 200)]);
    }
    results.push([
      'slack channel configurable non-interactively',
      !results.some(([label]) => label.startsWith('config ')),
      'all `openclaw config set` calls returned 0',
    ]);

    step('restart the gateway so it picks the channel up');
    await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', 'pkill -f "openclaw gateway run" || true'],
    });
    await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `nohup openclaw gateway run --auth token --port ${GATEWAY_PORT} ` +
          `>> /tmp/openclaw-gateway.log 2>&1 & sleep 12; echo restarted`,
      ],
      env: { OPENCLAW_GATEWAY_TOKEN: gatewayToken },
    });

    step('does the gateway serve the webhook path, and accept OUR signature?');
    const body = slackEventBody();
    const ts = String(Math.floor(Date.now() / 1000));
    const good = await post(sandbox, WEBHOOK_PATH, body, ts, signSlack(signingSecret, ts, body));
    console.log(`valid signature -> status=${good.status}\n${good.output.slice(0, 600)}`);
    results.push([
      'accepts a payload signed with the host-generated secret',
      good.status >= 200 && good.status < 300,
      `HTTP ${good.status}. A 404 means the path is not served; a 401 means the signature was rejected.`,
    ]);

    step('does a BAD signature get rejected?');
    const bad = await post(sandbox, WEBHOOK_PATH, body, ts, 'v0=deadbeef');
    console.log(`bad signature -> status=${bad.status}\n${bad.output.slice(0, 300)}`);
    results.push([
      'rejects a forged signature',
      bad.status === 401 || bad.status === 403,
      `HTTP ${bad.status}. Anything 2xx here means the gateway port is an open door.`,
    ]);

    step('gateway log tail');
    const log = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', 'tail -30 /tmp/openclaw-gateway.log 2>/dev/null || echo "(no log)"'],
    });
    console.log((await log.stdout()).trim().slice(-2500));

    step('summary');
    let allPassed = true;
    for (const [label, ok, detail] of results) {
      if (!ok) allPassed = false;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}`);
    }
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    step('stop sandbox');
    await sandbox.stop();
    console.log('stopped');
  }
}

/** POSTs to the gateway from inside the VM, so nothing needs a public port. */
async function post(
  sandbox: Awaited<ReturnType<typeof ensureAwake>>['sandbox'],
  path: string,
  body: string,
  timestamp: string,
  signature: string,
): Promise<{ status: number; output: string }> {
  const result = await sandbox.runCommand({
    cmd: 'node',
    args: [
      '-e',
      `fetch('http://127.0.0.1:${GATEWAY_PORT}${path}', {
         method: 'POST',
         headers: {
           'content-type': 'application/json',
           'x-slack-request-timestamp': ${JSON.stringify(timestamp)},
           'x-slack-signature': ${JSON.stringify(signature)},
         },
         body: ${JSON.stringify(body)},
       })
         .then(async (r) => { console.log('status=' + r.status); console.log((await r.text()).slice(0, 500)); })
         .catch((e) => { console.log('status=0'); console.log('error=' + (e && e.message)); });`,
    ],
  });
  const output = (await result.stdout()).trim();
  const match = output.match(/status=(\d+)/);
  return { status: match ? Number(match[1]) : 0, output };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
