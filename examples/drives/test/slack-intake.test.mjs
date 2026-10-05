import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHash, parseSlackEnvelope, slackIntake, slackPolicy, SLACK_BODY_LIMIT } from '../dist/slack-intake.js';
const policy = { teamId:'T123', appId:'A123', channelId:'C123', userId:'U123', botUserId:'U456' };
const body = () => ({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:'Ev123',event:{type:'app_mention',channel:'C123',user:'U123',ts:'123.456',thread_ts:'123.000',text:'<@U456>  hello\n世界\n  tail',blocks:[{type:'rich_text',elements:[]}],files:[{id:'F123',name:'sample.txt'}]},authorizations:[{user_id:'U456'}]});
const request = raw => new Request('https://example.test/api/slack',{method:'POST',headers:{'content-type':'application/json'},body:raw});
test('original Slack envelope bytes, whitespace, metadata and Unicode reach durable enqueue',async()=>{
  const raw=JSON.stringify(body(),null,2)+'\n';let verified,queued;
  const handler=slackIntake({policy:()=>policy,verify:async(_,s)=>{verified=s},enqueue:async e=>{queued=e}});
  assert.equal((await handler(request(raw))).status,200);assert.equal(verified,raw);assert.equal(queued.rawBody,raw);assert.equal(queued.sha256,bodyHash(raw));assert.equal(queued.threadTs,'123.000');
});
test('intake does not acknowledge until queue admission resolves; failed admission remains retryable',async()=>{
  let admit;const gate=new Promise(resolve=>{admit=resolve});let done=false;
  const handler=slackIntake({policy:()=>policy,verify:async()=>{},enqueue:async()=>gate});
  const pending=handler(request(JSON.stringify(body()))).then(r=>{done=true;return r});await new Promise(r=>setImmediate(r));assert.equal(done,false);admit();assert.equal((await pending).status,200);
  const failed=slackIntake({policy:()=>policy,verify:async()=>{},enqueue:async()=>{throw Error('offline')}});assert.equal((await failed(request(JSON.stringify(body())))).status,503);
});
test('unauthenticated, disallowed, malformed and oversized inputs cannot enqueue',async()=>{
  let calls=0;const deps={policy:()=>policy,verify:async()=>{},enqueue:async()=>{calls++}};
  assert.equal((await slackIntake({...deps,verify:async()=>{throw Error('bad')}})(request(JSON.stringify(body())))).status,401);
  for(const change of [b=>b.team_id='T999',b=>b.api_app_id='A999',b=>b.event.user='U999',b=>b.event.channel='C999',b=>b.event.bot_id='B123',b=>b.event.subtype='message_changed',b=>b.event.text='no mention']){
    const b=body();change(b);assert.equal((await slackIntake(deps)(request(JSON.stringify(b)))).status,200);
  }
  assert.equal((await slackIntake(deps)(request('{'))).status,400);
  const b=body();b.event.text='x'.repeat(40001);assert.equal((await slackIntake(deps)(request(JSON.stringify(b)))).status,400);
  assert.equal((await slackIntake(deps)(request('x'.repeat(SLACK_BODY_LIMIT+1)))).status,413);assert.equal(calls,0);
});
test('configuration fails closed and root messages retain their timestamp as thread',()=>{
  assert.throws(()=>slackPolicy(undefined));assert.deepEqual(slackPolicy(JSON.stringify(policy)),policy);
  const b=body();delete b.event.thread_ts;assert.equal(parseSlackEnvelope(JSON.stringify(b),policy).threadTs,b.event.ts);
});

test('retry after failed queue send retains the same event key and body; changed payload conflicts', async()=>{
  const { enqueueSlack } = await import('../dist/slack-queue.js');const hashes=new Map();const attempts=[];
  const redis={command:async args=>{const [, , , key, hash]=args;if(hashes.has(key)&&hashes.get(key)!==hash)return 0;hashes.set(key,hash);return 1}};
  const enqueue=enqueueSlack(redis,'test',async(event,key)=>{attempts.push({event,key});if(attempts.length===1)throw Error('queue unavailable')});
  const event=parseSlackEnvelope(JSON.stringify(body()),policy);
  await assert.rejects(enqueue(event));await enqueue(event);assert.deepEqual(attempts[0],attempts[1]);
  const changed=body();changed.event.text+='/changed';await assert.rejects(enqueue(parseSlackEnvelope(JSON.stringify(changed),policy)),/another body/);assert.equal(attempts.length,2);
});
