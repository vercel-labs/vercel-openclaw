import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function nativeSlackInput(rawBody, { channels, users, teamId }) {
  assert(typeof rawBody === 'string' && Buffer.byteLength(rawBody) <= 1024 * 1024, 'Invalid native Slack body');
  const body = JSON.parse(rawBody), event = body.event;
  assert(body.type === 'event_callback' && body.team_id === teamId && /^[A-Za-z0-9_-]{1,160}$/.test(body.event_id), 'Invalid Slack envelope');
  assert(event?.type === 'app_mention' && !event.bot_id && !event.bot_profile && !event.subtype, 'Only human channel mentions are enabled in this PoC');
  assert(channels.includes(event.channel) && users.includes(event.user), 'Slack sender or channel is not admitted');
  assert(/^[CG][A-Z0-9]+$/.test(event.channel) && /^[UW][A-Z0-9]+$/.test(event.user), 'Invalid Slack identity');
  const thread = event.thread_ts ?? event.ts;
  assert(/^\d+\.\d+$/.test(thread) && /^\d+\.\d+$/.test(event.ts) && typeof event.text === 'string' && event.text.trim(), 'Invalid Slack message');
  return { rawBody, eventId: body.event_id, message: event.text, messageId: event.ts, senderId: event.user, sessionKey: `agent:main:slack:channel:${event.channel.toLowerCase()}:thread:${thread}` };
}

export function nativeSlackConfig({ channels, users }) {
  assert(channels.length && users.length, 'Explicit native Slack allowlists required');
  return {
    commands: { native: false, nativeSkills: false, text: false, bash: false, config: false, mcp: false, plugins: false, debug: false, restart: false },
    messages: { visibleReplies: 'automatic', groupChat: { visibleReplies: 'automatic' }, ackReaction: 'eyes', ackReactionScope: 'all', statusReactions: { enabled: false } },
    channels: { slack: {
      enabled: true, mode: 'http', botToken: '${SLACK_BOT_TOKEN}', signingSecret: '${SLACK_SIGNING_SECRET}', webhookPath: '/slack/events',
      dmPolicy: 'disabled', groupPolicy: 'allowlist', allowFrom: users, requireMention: true, configWrites: false,
      commands: { native: false, nativeSkills: false }, slashCommand: { enabled: false }, joinIntro: false,
      streaming: { mode: 'off' }, replyToMode: 'all', reactionNotifications: 'off', thread: { historyScope: 'thread', inheritParent: false },
      channels: Object.fromEntries(channels.map(id => [id, { allow: true, requireMention: true, users }])),
    } },
  };
}

export function signSlackBody(rawBody, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}` };
}

export async function waitForNativeSlack(rpc, { timeoutMs = 30_000, pause = () => new Promise(resolve => setTimeout(resolve, 200)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await rpc('channels.status', { probe: false });
    const account = status.channelAccounts?.slack?.find(item => item.accountId === 'default');
    assert(!account?.lastError, `Native Slack channel failed: ${account?.lastError}`);
    if (account?.configured && account.running && account.connected) return account;
    await pause();
  }
  throw new Error('Native Slack channel readiness deadline exceeded');
}

export function nativeSlackController({ input, path, secret, rpc, observe, fetcher = fetch, timeoutMs = 35_000, signal }) {
  const check = () => signal?.throwIfAborted();
  const revoke = () => {
    if (!existsSync(path)) return;
    const admission = JSON.parse(readFileSync(path, 'utf8'));
    if (admission.eventId === input.eventId) writeFileSync(path, JSON.stringify({ ...admission, expiresAt: 0 }), { mode: 0o600 });
  };
  const events = () => existsSync(`${path}.events`) ? readFileSync(`${path}.events`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.eventId === input.eventId) : [];
  const wait = async evaluate => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      check();
      const result = await evaluate();
      check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Native Slack admission or delivery deadline exceeded');
  };
  return {
    closeNativeTurn: revoke,
    async startNativeTurn(operator, expected) {
      check();
      const live = (await rpc('sessions.describe', { key: input.sessionKey })).session;
      check();
      assert.equal(live?.sessionId, expected.sessionId, 'Native Slack session changed before intake');
      writeFileSync(path, JSON.stringify({ ...input, rawBody: undefined, message: undefined, expiresAt: Date.now() + 180_000 }), { mode: 0o600 });
      const response = await fetcher('http://127.0.0.1:18789/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', ...signSlackBody(input.rawBody, secret) }, body: input.rawBody, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
      check();
      assert.equal(response.status, 200, 'Native Slack HTTP intake rejected the event');
      observe('native-intake');
      return wait(async () => {
        const turn = await operator.adoptNativeTurn(expected);
        if (turn) assert(events().some(e => e.type === 'admitted'), 'Native turn bypassed host admission');
        return turn;
      });
    },
    async awaitNativeDelivery() {
      await wait(() => {
        const records = events();
        assert(!records.some(e => e.type === 'delivery-failed'), 'Native Slack delivery failed');
        return records.find(e => e.type === 'delivered' && e.messageId);
      });
    },
  };
}
