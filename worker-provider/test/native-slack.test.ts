import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSlackConfig, nativeSlackInput, signSlackBody, waitForNativeSlack, nativeSlackController } from '../runtime/native-slack.mjs';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const body = {type:'event_callback',event_id:'Ev1',team_id:'T1',event:{type:'app_mention',channel:'C123',user:'U123',ts:'1234.123456',text:'<@U999> hello',blocks:[{type:'section'}]}};
test('native intake retains full Slack body and selects the documented mention thread', () => {
  const input = nativeSlackInput(JSON.stringify(body), {channels:['C123'],users:['U123'],teamId:'T1'});
  assert.equal(input.sessionKey,'agent:main:slack:channel:c123:thread:1234.123456');
  assert.deepEqual(JSON.parse(input.rawBody),body);
  assert.throws(()=>nativeSlackInput(JSON.stringify(body),{channels:['C456'],users:['U123'],teamId:'T1'}));
  assert.throws(()=>nativeSlackInput(JSON.stringify({...body,event:{...body.event,subtype:'message_changed'}}),{channels:['C123'],users:['U123'],teamId:'T1'}));
  assert.throws(()=>nativeSlackInput(JSON.stringify({...body,team_id:'wrong'}),{channels:['C123'],users:['U123'],teamId:'T1'}));
});
test('native channel keeps credentials brokered and administrative commands disabled',()=>{
  const cfg = nativeSlackConfig({base:'/runtime',channels:['C123'],users:['U123']});
  assert.equal(cfg.channels.slack.mode,'http');
  assert.equal(cfg.channels.slack.dmPolicy,'disabled');
  assert.equal(cfg.channels.slack.groupPolicy,'allowlist');
  assert.equal(cfg.channels.slack.channels.C123.requireMention,true);
  assert.equal(cfg.commands.text,false);
  assert.equal(cfg.commands.config,false);
  assert.equal(cfg.commands.restart,false);
  assert.equal(cfg.messages.visibleReplies,'automatic');
});
test('trusted local delivery signs the preserved body with a separate per-run secret',()=>{
  const raw=JSON.stringify(body), timestamp='1789000000';
  assert.deepEqual(signSlackBody(raw,'synthetic',timestamp),{'x-slack-request-timestamp':timestamp,'x-slack-signature':`v0=${createHmac('sha256','synthetic').update(`v0:${timestamp}:${raw}`).digest('hex')}`});
});
test('native Slack readiness rejects a failed channel before allocating a worker', async () => {
  await assert.rejects(waitForNativeSlack(async () => ({channelAccounts:{slack:[{accountId:'default',configured:true,running:false,lastError:'Channel ingress queue is unavailable'}]}})), /Channel ingress queue is unavailable/);
});
test('native Slack readiness waits for the configured account and HTTP listener', async () => {
  let calls=0;
  const account={accountId:'default',configured:true,running:true,connected:true};
  assert.equal(await waitForNativeSlack(async (method, args) => {
    assert.equal(method,'channels.status');assert.equal(args.probe,false);
    return {channelAccounts:{slack:[++calls===1?{...account,running:false}:account]}};
  }, {pause:async()=>{},timeoutMs:1000}), account);
  assert.equal(calls,2);
  await assert.rejects(waitForNativeSlack(async()=>({}),{timeoutMs:1,pause:async()=>{}}), /Slack channel readiness deadline/);
});

test('native intake stops at each expired stage and revokes only the current admission', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const stage of ['describe', 'fetch', 'adopt']) {
    const controller = new AbortController();
    const path = join(root, stage);
    const calls: string[] = [];
    const input = nativeSlackInput(JSON.stringify(body), { channels: ['C123'], users: ['U123'], teamId: 'T1' });
    const abort = (at: string) => { calls.push(at); if (at === stage) controller.abort(new Error('execution deadline')); };
    const native = nativeSlackController({ input, path, secret: 'synthetic', signal: controller.signal, observe: () => {},
      rpc: async () => { abort('describe'); return { session: { sessionId: 'session' } }; },
      fetcher: async (_url: string, options: any) => { abort('fetch'); assert.equal(options.signal.aborted, stage === 'fetch'); return { status: 200 }; },
    });
    await assert.rejects(native.startNativeTurn({ adoptNativeTurn: async () => { abort('adopt'); return undefined; } }, { sessionId: 'session' }), /execution deadline/);
    native.closeNativeTurn();
    assert.deepEqual(calls, ['describe', 'fetch', 'adopt'].slice(0, ['describe', 'fetch', 'adopt'].indexOf(stage) + 1));
    if (stage === 'describe') assert.equal(existsSync(path), false);
    else assert.equal(JSON.parse(readFileSync(path, 'utf8')).expiresAt, 0);
    writeFileSync(path, JSON.stringify({ eventId: 'newer', expiresAt: 999 }));
    native.closeNativeTurn();
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).expiresAt, 999);
    await assert.rejects(native.awaitNativeDelivery(), /execution deadline/);
  }
});

test('an unexpired native turn still admits, adopts and observes delivery before revocation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-complete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'admission');
  const input = nativeSlackInput(JSON.stringify(body), { channels: ['C123'], users: ['U123'], teamId: 'T1' });
  const native = nativeSlackController({ input, path, secret: 'synthetic', signal: new AbortController().signal, observe: () => {},
    rpc: async () => ({ session: { sessionId: 'session' } }),
    fetcher: async () => {
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).eventId, input.eventId);
      writeFileSync(`${path}.events`, [{ eventId: input.eventId, type: 'admitted' }, { eventId: input.eventId, type: 'delivered', messageId: 'reply' }].map(e => JSON.stringify(e)).join('\n'));
      return { status: 200 };
    },
  });
  assert.deepEqual(await native.startNativeTurn({ adoptNativeTurn: async () => ({ runId: 'run' }) }, { sessionId: 'session' }), { runId: 'run' });
  await native.awaitNativeDelivery();
  assert(JSON.parse(readFileSync(path, 'utf8')).expiresAt > Date.now());
  native.closeNativeTurn();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).expiresAt, 0);
});
