import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getVercelOidcTokenSync } from '@vercel/oidc';
import { getToken } from '@vercel/connect';
import { acknowledgeSlack } from './slack-ack.js';
import { WarmSlack, WarmStore, stopIdle, signIdle, verifyIdle, type IdleEvent, type IdleScheduler } from './slack-warm.js';
import { slackQueue } from './slack-queue.js';
import { Receipt } from './receipt.js';
import { Controller } from './controller.js';
import { RedisRest, RedisStore } from './controller-store.js';
import { settingsFromEnv } from './config.js';
import { bodyHash, parseSlackEnvelope, slackPolicy, type SlackEvent } from './slack-intake.js';
import { PermanentSlackError, verifyQueuedEvent, verifyEnvelopeBinding, verifySlackIdentity, type QueuedSlackEvent } from './slack-auth.js';
import { slackConfiguration, observerSource, SLACK_PACKAGE } from './slack-native.js';

export function slackIdentity(event: SlackEvent, appId: string) {
  return { agent: 'slack-'+bodyHash(`${event.teamId}:${appId}:${event.channelId}`).slice(0,32),
    requestId:event.eventId, conversation:`${event.channelId}:${event.threadTs}`, message:event.rawBody };
}
export async function consumeSlack(payload: QueuedSlackEvent | IdleEvent, env = process.env) {
  const namespace=env.OPENCLAW_CONTROLLER_NAMESPACE??env.VERCEL_PROJECT_ID!;
  const schedule:IdleScheduler=event=>slackQueue.send('openclaw-drives-idle',signIdle(event,namespace,env.OPENCLAW_SLACK_QUEUE_SECRET),
    {delaySeconds:Math.max(0,Math.ceil((event.dueAt-Date.now())/1000)),retentionSeconds:86400,
      idempotencyKey:`${namespace}:${event.agent}:${event.generation}:${event.dueAt}`}).then(()=>{});
  if(payload && 'kind' in payload && payload.kind==='slack-idle-v1'){
    verifyIdle(payload,namespace,env.OPENCLAW_SLACK_QUEUE_SECRET);
    const policy=slackPolicy(env.OPENCLAW_SLACK_POLICY);
    const settings=settingsFromEnv({...env,VERCEL_OIDC_TOKEN:getVercelOidcTokenSync()},Date.now(),15*60000);
    const store=new WarmStore(new RedisStore(new RedisRest(env.KV_REST_API_URL!,env.KV_REST_API_TOKEN!),namespace));
    const receipt=new Receipt('/tmp/openclaw-drives-idle',[settings.credentials.token,settings.gatewayKey]);
    try{await stopIdle(settings,store,policy,payload,receipt,schedule);receipt.finish('passed',{agent:payload.agent});}
    catch(error){receipt.finish('failed',{agent:payload.agent,error:error instanceof Error?error.message:String(error),resourcesPreserved:true});throw error;}
    return;
  }
  const queued=payload as QueuedSlackEvent;
  verifyQueuedEvent(queued,namespace,env.OPENCLAW_SLACK_QUEUE_SECRET);
  const policy=slackPolicy(env.OPENCLAW_SLACK_POLICY);
  let event: SlackEvent | null;
  try { event=parseSlackEnvelope(queued.rawBody,policy); }
  catch { throw new PermanentSlackError('Invalid queued Slack envelope.'); }
  if(!event || event.sha256!==queued.sha256 || event.eventId!==queued.eventId)throw new PermanentSlackError('Queued Slack event is no longer allowed.');
  const redis=new RedisRest(env.KV_REST_API_URL!,env.KV_REST_API_TOKEN!);
  await verifyEnvelopeBinding(redis,namespace,event);
  const settings=settingsFromEnv({...env,VERCEL_OIDC_TOKEN:getVercelOidcTokenSync()},Date.now(),15*60000);
  assert(env.SLACK_CONNECTOR,'Slack connector is required.');
  const token=await getToken(env.SLACK_CONNECTOR,{subject:{type:'app'},validityBufferMs:15*60000,scopes:['channels:read','channels:history','users:read','chat:write']},{vercelToken:settings.credentials.token});
  await verifySlackIdentity(token,policy);
  const store=new RedisStore(redis,namespace);
  const warm=new WarmSlack(settings,new WarmStore(store),policy,token,schedule);
  const controller=new Controller(settings,store,'/tmp/openclaw-drives-slack',{
    runtimeConfiguration:{config:slackConfiguration(settings.model,policy),slackPackage:SLACK_PACKAGE,observer:createHash('sha256').update(observerSource).digest('hex')},
    admitted:async(job,receipt)=>{
      warm.admitted(job);
      try{
        const ackToken=await getToken(env.SLACK_CONNECTOR!,{subject:{type:'app'},scopes:['reactions:write']},{vercelToken:settings.credentials.token});
        const result=await acknowledgeSlack(ackToken,event!);receipt.event('slack-ack',result);console.info(JSON.stringify({kind:'slack-ack',eventId:event!.eventId,...result}));
      }catch{receipt.event('slack-ack',{ok:false,error:'token_unavailable'});}
    },
    attach:(settings,agent,receipt,options)=>warm.attach(settings,agent,receipt,options,event!),
    finished:async(_run,_job,receipt)=>warm.finished(receipt),
    failed:()=>warm.failed(),
  });
  const result=await controller.message(slackIdentity(event,policy.appId));
  const body=result.body as {job?:{status:string};error?:string};
  if(result.status===202 || (result.status===409&&body.error==='busy') || (result.status===503&&!body.job)) {
    throw Error('Slack work remains pending; retry the same event.');
  }
  assert(body.job,'Slack request conflicts with saved configuration or identity.');
  console.info(JSON.stringify({kind:'slack-controller-result',eventId:event.eventId,sha256:event.sha256,status:body.job.status}));
}
