import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Drive,Sandbox} from '@vercel/sandbox';
import {getToken} from '@vercel/connect';
import {settingsFromEnv,WORKSPACE,REGION,DRIVE_BYTES} from '../dist/config.js';
import {RedisRest,RedisStore} from '../dist/controller-store.js';
import {initializeDrive} from '../dist/initialize.js';
import {WarmStore,WarmSlack,stopIdle,signIdle,verifyIdle} from '../dist/slack-warm.js';
import {Receipt} from '../dist/receipt.js';

const env={...process.env,...parseEnv(readFileSync(process.argv[2],'utf8'))};const settings=settingsFromEnv(env);
const policy=JSON.parse(env.OPENCLAW_SLACK_POLICY);const token=await getToken(env.SLACK_CONNECTOR,{subject:{type:'app'},scopes:['channels:read','channels:history','users:read','chat:write']},{vercelToken:settings.credentials.token});
const secret=randomBytes(32).toString('hex');const namespace='warm-test-'+randomBytes(5).toString('hex');
const agent='slack-'+randomBytes(16).toString('hex');const redis=new RedisRest(env.KV_REST_API_URL,env.KV_REST_API_TOKEN);const store=new RedisStore(redis,namespace);const warmStore=new WarmStore(store);
const receipt=new Receipt('results/slack-warm',[settings.credentials.token,settings.gatewayKey,token,secret,env.KV_REST_API_TOKEN]);const scheduled=[];
const schedule=async e=>{scheduled.push(signIdle(e,namespace,secret));receipt.event('idle-scheduled',{generation:e.generation,dueAt:e.dueAt})};
const services={drive:p=>Drive.getOrCreate(p),create:p=>Sandbox.create(p)};let handle,firstGeneration;const phases=[];
try{
 await initializeDrive(settings,agent,receipt);
 for(let cycle=0;cycle<2;cycle++){
  const admission=await store.begin({agent,requestId:'cycle-'+cycle,conversation:'probe',message:'readiness'},'warm-probe');assert.equal(admission.kind,'accepted');
  const lifecycle=new WarmSlack(settings,warmStore,policy,token,schedule,2000);lifecycle.admitted(admission.job);
  const started=Date.now();const run=await lifecycle.attach(settings,agent,receipt,{services},undefined);await run.start();
  if(cycle===0){handle=run.run.handle();await run.sandbox.writeFiles([{path:WORKSPACE+'/restart-proof.txt',content:Buffer.from('warm-drive-proof\n')}]);}
  else{assert.equal(run.run.handle().sessionId,handle.sessionId);assert.equal(run.run.handle().commandId,handle.commandId);assert.equal((await run.run.readWorkspaceFile('restart-proof.txt')).toString(),'warm-drive-proof\n');}
  await run.drainAfterTurn('readiness-'+cycle);assert.equal(await lifecycle.finished(receipt),'warm');
  const current=await warmStore.read(agent,admission.job.owner);assert.equal(current.status,'ready');
  phases.push({cycle,readyMs:Date.now()-started,sessionId:run.run.handle().sessionId,commandId:run.run.handle().commandId});
  if(cycle===0){firstGeneration=current.generation;await assert.rejects(stopIdle(settings,warmStore,policy,scheduled[0],receipt,schedule),/pending/);}
  await store.patch(agent,admission.job.requestId,admission.job.owner,{status:'completed',phase:'warm'},true);
 }
 verifyIdle(scheduled.at(-1),namespace,secret);
 await stopIdle(settings,warmStore,policy,scheduled[0],receipt,schedule);
 const live=await Sandbox.get({...settings.credentials,name:handle.name,resume:false});assert.equal(live.status,'running');
 const due=scheduled.at(-1);await delay(Math.max(0,due.dueAt-Date.now()+100));
 const before=await redis.command(['GET',warmStore.keys(agent)[1]]);assert.equal(JSON.parse(before).status,'ready');
 await stopIdle(settings,warmStore,policy,due,receipt,schedule);
 assert.equal(await redis.command(['GET',warmStore.keys(agent)[1]]),null);
 const stopped=await Sandbox.get({...settings.credentials,name:handle.name,resume:false});assert.equal(stopped.status,'stopped');
 await stopIdle(settings,warmStore,policy,due,receipt,schedule);
 const admission=await store.begin({agent,requestId:'after-idle',conversation:'probe',message:'readiness'},'warm-probe');assert.equal(admission.kind,'accepted');
 const lifecycle=new WarmSlack(settings,warmStore,policy,token,schedule,2000);lifecycle.admitted(admission.job);
 const restored=await lifecycle.attach(settings,agent,receipt,{services,image:handle.image},undefined);
 assert.notEqual(restored.sandbox.currentSession().sessionId,handle.sessionId);assert.equal(restored.run.drive.driveId,handle.driveId);
 assert.equal((await restored.run.readWorkspaceFile('restart-proof.txt')).toString(),'warm-drive-proof\n');
 await restored.start();assert(await restored.prepareIdle('final-stop'));await restored.quiesce();await restored.stop();
 await store.patch(agent,'after-idle',admission.job.owner,{status:'completed',phase:'detached'},true);
 receipt.finish('passed',{agent,namespace,phases,firstGeneration,driveId:handle.driveId,restoredSession:restored.sandbox.currentSession().sessionId,scope:'Same VM/gateway across reconnects; native drain/resume, real Redis ownership, stale idle callback, short idle shutdown and fresh VM file recovery',slackEventsSubmitted:0});console.log(JSON.stringify({status:'passed',receipt:receipt.directory}));
}catch(error){receipt.finish('failed',{agent,namespace,error:error.message,resourcesPreserved:true});console.error(JSON.stringify({status:'failed',receipt:receipt.directory,error:error.message}));process.exitCode=1}
