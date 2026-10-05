import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeSlack } from '../src/slack-ack.ts';

const token = 'xoxb-test-secret-do-not-report';
const event = { channelId: 'C1', messageTs: '1727000000.000002', threadTs: '1727000000.000001' };
const reply = (body, init) => async () => Response.json(body, init);

test('adds eyes to the exact triggering message using bearer auth and JSON', async () => {
  let calls = 0;
  const result = await acknowledgeSlack(token, event, { fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'https://slack.com/api/reactions.add');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    });
    assert.deepEqual(JSON.parse(init.body), {
      channel: event.channelId, timestamp: event.messageTs, name: 'eyes',
    });
    assert.equal(init.body.includes(token), false);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return Response.json({ ok: true });
  } });
  assert.deepEqual(result, { ok: true, alreadyReacted: false });
  assert.equal(calls, 1);
});

test('already_reacted is idempotent success', async () => {
  assert.deepEqual(await acknowledgeSlack(token, event, {
    fetcher: reply({ ok: false, error: 'already_reacted' }),
  }), { ok: true, alreadyReacted: true });
});

test('requires channel, exact message timestamp and token without making a request', async () => {
  let calls = 0;
  const options = { fetcher: async () => { calls++; throw Error('must not fetch'); } };
  for (const invalid of [null, {}, { messageTs: event.messageTs },
    { channelId: ' ' , messageTs: event.messageTs }, { channelId: 'C1', threadTs: event.threadTs },
    { channelId: 'C1', messageTs: 123 }, { channelId: 'C1', messageTs: 'bad' }]) {
    assert.deepEqual(await acknowledgeSlack(token, invalid, options), { ok: false, error: 'invalid_event' });
  }
  for (const absent of ['', ' ', undefined]) {
    assert.deepEqual(await acknowledgeSlack(absent, event, options), { ok: false, error: 'missing_token' });
  }
  assert.equal(calls, 0);
});

test('scope, authentication and rate-limit failures are reportable without retries', async () => {
  for (const [body, status, error] of [
    [{ ok: false, error: 'missing_scope', needed: token }, 200, 'missing_scope'],
    [{ ok: false, error: 'invalid_auth' }, 200, 'invalid_auth'],
    [{ ok: false, error: 'ratelimited' }, 200, 'ratelimited'],
    [{ ok: true }, 429, 'ratelimited'],
    [{ ok: true }, 503, 'http_error'],
    [{ ok: false, error: 'already_reacted' }, 500, 'http_error'],
  ]) {
    let calls = 0;
    const result = await acknowledgeSlack(token, event, { fetcher: async () => {
      calls++;
      return Response.json(body, { status, headers: { 'retry-after': '60' } });
    } });
    assert.deepEqual(result, { ok: false, error });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('transport exceptions and arbitrary response text cannot expose tokens or log them', async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args));
  }
  for (const [fetcher, error] of [
    [async () => { throw Error(`Bearer ${token}`); }, 'transport_error'],
    [() => { throw { token }; }, 'transport_error'],
    [reply({ ok: false, error: token, response_metadata: { token } }), 'slack_error'],
    [reply({ ok: false, error: { token } }), 'slack_error'],
    [async () => new Response(token), 'invalid_response'],
    [async () => new Response(token, { status: 429 }), 'ratelimited'],
    [async () => new Response(token, { status: 502 }), 'http_error'],
  ]) {
    const result = await acknowledgeSlack(token, event, { fetcher });
    assert.deepEqual(result, { ok: false, error });
    assert.equal(JSON.stringify(result).includes(token), false);
  }
  assert.deepEqual(logs, []);
});

test('malformed Slack success bodies fail safely', async () => {
  for (const body of [null, [], {}, 'ok', { ok: 'true' }, { error: 'already_reacted' }]) {
    assert.deepEqual(await acknowledgeSlack(token, event, { fetcher: reply(body) }),
      { ok: false, error: 'invalid_response' });
  }
});

test('deadline aborts a fetch that ignores cancellation and returns control', { timeout: 5_000 }, async () => {
  let signal;
  const result = await acknowledgeSlack(token, event, { fetcher: async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  assert.deepEqual(result, { ok: false, error: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('deadline also bounds stalled response parsing', { timeout: 5_000 }, async () => {
  let signal;
  const result = await acknowledgeSlack(token, event, { fetcher: async (_url, init) => {
    signal = init.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  assert.deepEqual(result, { ok: false, error: 'timeout' });
  assert.equal(signal.aborted, true);
});
