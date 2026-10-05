import test from 'node:test';
import assert from 'node:assert/strict';
import {signQueuedEvent,verifyQueuedEvent,verifyEnvelopeBinding,verifySlackIdentity,PermanentSlackError,slackRetry} from '../dist/slack-auth.js';
import {bodyHash} from '../dist/slack-intake.js';
const secret='a'.repeat(64), namespace='prj_test';
const event={rawBody:'{"event":"original"}',sha256:bodyHash('{"event":"original"}'),teamId:'T1',eventId:'Ev1',channelId:'C1',userId:'U1',messageTs:'1.1',threadTs:'1.1'};
test('only an unchanged server-signed queue envelope passes authentication',()=>{
  const signed=signQueuedEvent(event,namespace,secret);verifyQueuedEvent(signed,namespace,secret);
  for(const changed of [{...signed,signature:'0'.repeat(64)},{...signed,rawBody:'changed'},{...signed,eventId:'Ev2'},{...signed,rawBody:'changed',sha256:bodyHash('changed')}])assert.throws(()=>verifyQueuedEvent(changed,namespace,secret),PermanentSlackError);
  assert.throws(()=>verifyQueuedEvent(signed,'prj_other',secret),PermanentSlackError);assert.throws(()=>verifyQueuedEvent(signed,namespace,'b'.repeat(64)),PermanentSlackError);
});
test('durable ingress binding must exist and match before processing',async()=>{
  await verifyEnvelopeBinding({command:async()=>event.sha256},namespace,event);
  for(const stored of [null,'other'])await assert.rejects(verifyEnvelopeBinding({command:async()=>stored},namespace,event),PermanentSlackError);
});
test('Slack token identity must match both workspace and bot before admission',async()=>{
  const policy={teamId:'T1',botUserId:'U2'};
  await verifySlackIdentity('test-token',policy,async()=>Response.json({ok:true,team_id:'T1',user_id:'U2'}));
  for(const data of [{team_id:'T2',user_id:'U2'},{team_id:'T1',user_id:'U3'}])await assert.rejects(verifySlackIdentity('test-token',policy,async()=>Response.json({ok:true,...data})),PermanentSlackError);
});
test('permanent invalid payloads are discarded; temporary failures stay retryable',()=>{
  assert.deepEqual(slackRetry(new PermanentSlackError('policy changed')),{acknowledge:true});assert.deepEqual(slackRetry(new Error('busy')),{afterSeconds:15});
});
test('unsigned callbacks are rejected before requesting platform credentials or services',async()=>{
  const {consumeSlack}=await import('../dist/slack-worker.js');
  await assert.rejects(consumeSlack({...event,signature:''},{VERCEL_PROJECT_ID:namespace,OPENCLAW_SLACK_QUEUE_SECRET:secret}),PermanentSlackError);
});
