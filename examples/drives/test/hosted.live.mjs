import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Receipt } from '../dist/receipt.js';

assert(process.argv.length === 4, 'Usage: node test/hosted.live.mjs <deployment-url> <ignored-env-file>');
loadEnvFile(process.argv[3]);
const token=process.env.OPENCLAW_CONTROL_TOKEN;
assert(token && token.length >= 32, 'A control token is required');
const endpoint=new URL(process.argv[2]);
assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash, 'Use an HTTPS deployment origin');
const url=endpoint.origin;
const receipt=new Receipt('results/hosted',[token]);
const agent=`deployed-${randomBytes(6).toString('hex')}`;
const history=`history-${randomBytes(8).toString('hex')}`,memory=`memory-${randomBytes(8).toString('hex')}`;
const timings=[],jobs=[];
let sequence=0;
async function call(path,body,auth=true){
  const id=++sequence;const args=['curl',path,'--deployment',url,'--','--silent','--show-error','--max-time','780','--write-out','\n%{http_code} %{time_total}'];
  if(body!==undefined){const file=resolve(receipt.directory,`input-${id}.json`);writeFileSync(file,JSON.stringify(body),{mode:0o600});args.push('--request','POST','--header','Content-Type: application/json','--data-binary',`@${file}`);}
  if(auth)args.push('--config','-');
  const started=performance.now();
  const result=await new Promise((res,rej)=>{
    const child=spawn('vercel',args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('error',rej);child.on('close',code=>res({code,stdout,stderr}));
    child.stdin.end(auth?`header = "Authorization: Bearer ${token}"\n`:'');
  });
  receipt.event('transport',{id,path,exitCode:result.code,stderr:result.stderr,elapsedMs:performance.now()-started});
  assert.equal(result.code,0,'Hosted request transport failed');
  const split=result.stdout.trimEnd().lastIndexOf('\n');const [status,seconds]=result.stdout.slice(split+1).trim().split(' ');
  const r={status:Number(status),seconds:Number(seconds),body:JSON.parse(result.stdout.slice(0,split))};
  receipt.event('response',{id,path,...r});return r;
}
async function complete(input){
  const r=await call('/api/messages',input);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.job.status,'completed');
  const t=r.body.job.phaseTimes;assert(t,'Phase timestamps are required');
  const order=['admitted','starting','dispatching','reply-recorded','gateway-quiesced','detached'];
  for(let i=0;i<order.length;i++){assert(Number.isFinite(t[order[i]]));if(i)assert(t[order[i]]>=t[order[i-1]]);}
  jobs.push(r.body.job);timings.push({requestId:input.requestId,httpSeconds:r.seconds,admissionToDetachedSeconds:(r.body.job.updatedAt-r.body.job.createdAt)/1000,
    derivedPhaseSeconds:{prepare:(t.starting-t.admitted)/1000,startup:(t.dispatching-t.starting)/1000,model:(t['reply-recorded']-t.dispatching)/1000,shutdownAndDetach:(t.detached-t['reply-recorded'])/1000}});
  console.log(JSON.stringify({request:input.requestId,status:'completed',httpSeconds:r.seconds}));return r.body.job;
}
try{
  receipt.event('start',{url,agent,node:process.version});
  assert.equal((await call('/api/requests',undefined,false)).status,401);
  assert.equal((await call('/api/messages',{})).status,400);
  assert.equal((await call('/api/messages',{agent,requestId:'too-large',message:'x'.repeat(16001)})).status,400);
  const first={agent,requestId:'write',conversation:'main',message:`Remember this conversation-only marker: ${history}. Do not put it in a file. Use the write tool to create /data/openclaw/workspace/MEMORY.md containing exactly:\n# Memory\nThe acceptance marker is ${memory}.\nReply WRITTEN after the write succeeds.`};
  const pending=complete(first);pending.catch(()=>{});
  let running;
  for(let i=0;i<60;i++){
    const r=await call(`/api/requests?agent=${agent}&requestId=write`);
    if(r.body.job?.status==='running'){running=r.body.job;break;}
    if(r.body.job?.status==='completed')break;
    await delay(1000);
  }
  assert(running,'Initial request completed before concurrency checks');
  assert.equal((await call('/api/messages',first)).status,202);
  assert.equal((await call('/api/messages',{...first,requestId:'competing'})).status,409);
  const written=await pending;
  const duplicate=await call('/api/messages',first);assert.equal(duplicate.body.duplicate,true);assert.deepEqual(duplicate.body.job,written);
  const recalled=await complete({agent,requestId:'recall',conversation:'main',message:'What was the conversation-only marker? Reply with just the marker without tools.'});
  assert(recalled.reply.includes(history));assert.equal(recalled.nativeSessionId,written.nativeSessionId);
  const fresh=await complete({agent,requestId:'fresh',conversation:'separate',message:'What is the acceptance marker in your workspace memory? Reply with just the marker without tools.'});
  assert(fresh.reply.includes(memory));assert.notEqual(fresh.nativeSessionId,written.nativeSessionId);
  const ids=jobs.flatMap(j=>j.resources.filter(r=>r.kind==='workload').map(r=>r.sessionId));assert.equal(new Set(ids).size,3);
  assert(jobs.every(j=>j.drive.id===written.drive.id));
  receipt.finish('passed',{url,agent,jobs,timings,sessionIds:ids,scope:'Deployed HTTP controller, three fresh cloud workloads; no Slack traffic or speed comparison'});
  console.log(JSON.stringify({status:'passed',receipt:receipt.directory,timings}));
}catch(error){receipt.finish('failed',{url,agent,jobs,timings,error:error.message,resourcesPreserved:true});console.error(JSON.stringify({status:'failed',receipt:receipt.directory,error:error.message}));process.exitCode=1;}
