/**
 * Proves the thinking-glimmer mechanism against real Slack, with no deployment.
 *
 * The glimmer is Slack-side only: it never touches the sandbox, OpenClaw, the
 * agent turn, or Connect's trigger forwarding. So the two things unit tests
 * cannot prove are isolated here:
 *
 *   1. chat.postMessage returns a `ts` we can actually edit later.
 *   2. chat.update succeeds with the scopes mintSlackToken already requests
 *      (`chat:write`), i.e. no new Connect scope and no reinstall.
 *
 * Uses the real lib/slack.ts helpers, so a pass is evidence about the shipped
 * code path rather than about this script.
 *
 * Run from host/:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/probe-slack-glimmer.mts <channelId>
 */
import { getToken } from '@vercel/connect';
import { THINKING_TEXT, postSlackReply, updateSlackMessage } from '../lib/slack';

const channelId = process.argv[2];
if (!channelId) throw new Error('usage: probe-slack-glimmer.mts <channelId>');

const connector = process.env.SLACK_CONNECTOR;
if (!connector) throw new Error('SLACK_CONNECTOR not set (e.g. slack/openclaw)');
const vercelToken = process.env.VERCEL_OIDC_TOKEN;
if (!vercelToken) throw new Error('VERCEL_OIDC_TOKEN not set; run `vercel env pull`');

// Same call the route makes, same scopes. If chat.update needed anything extra
// this is where it would fail.
console.log('1. minting a Slack token through Connect ...');
const token = await getToken(
  connector,
  { subject: { type: 'app' }, scopes: ['chat:write', 'reactions:write'] },
  { vercelToken },
);
console.log('   minted, length', String(token).length);

// Stand-in for the user's mention, so the placeholder threads under something
// the way it does in a real turn.
console.log('2. posting a parent message to stand in for the mention ...');
const parentRes = await fetch('https://slack.com/api/chat.postMessage', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({
    channel: channelId,
    text: 'glimmer probe (scripts/probe-slack-glimmer.mts), ignore',
  }),
});
const parent = (await parentRes.json()) as { ok?: boolean; error?: string; ts?: string };
if (!parent.ok || !parent.ts) throw new Error(`parent post failed: ${parent.error ?? 'no ts'}`);
console.log('   parent ts', parent.ts);

console.log('3. posting the placeholder via postSlackReply ...');
const placeholder = await postSlackReply({
  token,
  channelId,
  threadTs: parent.ts,
  text: THINKING_TEXT,
});
console.log('   returned ts:', placeholder.ts ?? '(none, would fall back to a fresh post)');
if (!placeholder.ts) throw new Error('postSlackReply returned no ts; the glimmer cannot edit');

console.log('4. holding 3s so the placeholder is visibly the glimmer ...');
await new Promise((r) => setTimeout(r, 3_000));

console.log('5. editing it into the answer via updateSlackMessage (chat.update) ...');
await updateSlackMessage({
  token,
  channelId,
  ts: placeholder.ts,
  text: 'glimmer probe passed: this message was posted as _Thinking…_ and edited in place.',
});
console.log('   edited.');

console.log('\nPASS: ts captured and chat.update accepted with chat:write only.');
console.log(`Check the thread under ${parent.ts} in ${channelId}.`);
