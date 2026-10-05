import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox, Drive } from '@vercel/sandbox';
import { settingsFromEnv, agentDriveName, STATE, WORKSPACE, REGION, DRIVE_BYTES, sessionId } from '../dist/config.js';
import { RedisRest, RedisStore } from '../dist/controller-store.js';
import { AgentRun } from '../dist/runtime.js';
import { Receipt, digest } from '../dist/receipt.js';
import { assertNativeMemory } from '../dist/openclaw.js';

const envFile=process.argv[2];
const controllerOnly=process.argv[3]==='--controller-only';
assert(process.argv.length<=4&&(process.argv[3]===undefined||controllerOnly),'Unexpected live-test arguments');
if(envFile)loadEnvFile(envFile);
const settings=settingsFromEnv(process.env);
const namespace=`live-${randomUUID()}`, agent=`http-${randomBytes(6).toString('hex')}`;
const controlToken=randomBytes(32).toString('hex');
const receipt=new Receipt('results/controller-live',[settings.credentials.token,settings.gatewayKey,process.env.KV_REST_API_TOKEN,controlToken]);
const store=new RedisStore(new RedisRest(process.env.KV_REST_API_URL,process.env.KV_REST_API_TOKEN),namespace);
const history=`history-${randomBytes(8).toString('hex')}`, memory=`memory-${randomBytes(8).toString('hex')}`;
const memoryBytes=`# Memory\nThe acceptance marker is ${memory}.\n`, fileBytes=`saved-${randomBytes(8).toString('hex')}\n`;
let child,url,checks=0;
const jobs=[];
function passed(name,details={}){checks++;receipt.event('check',{name,...details});console.log(JSON.stringify({check:name,...details}));}
async function start(){
  child=spawn(process.execPath,['--','dist/server.js',...(envFile?['--env-file',resolve(envFile)]:[]),'--results',resolve(receipt.directory,'requests')],{
    env:{...process.env,OPENCLAW_CONTROL_TOKEN:controlToken,OPENCLAW_CONTROLLER_NAMESPACE:namespace,OPENCLAW_CONTROLLER_PORT:'0'},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',b=>receipt.event('server-stderr',{text:String(b)}));
  url=await new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(Error('Controller failed to listen')),15_000);let output='';
    child.once('exit',code=>{clearTimeout(timer);rej(Error(`Controller exited ${code}`))});
    child.stdout.on('data',b=>{output+=b;const line=output.split('\n').find(l=>l.includes('"listening"'));if(line){clearTimeout(timer);res(JSON.parse(line).url)}});
  });
}
async function stop(signal='SIGTERM'){
  if(!child || child.exitCode!==null || child.signalCode!==null)return;
  const ended=once(child,'exit');child.kill(signal);
  await Promise.race([ended,delay(15_000).then(()=>{throw Error('Controller did not exit')})]);
}
async function request(path,body,authorized=true){
  const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...(authorized?{authorization:`Bearer ${controlToken}`} : {}),'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12*60_000)});
  return {status:r.status,body:await r.json()};
}
async function poll(id,predicate){
  let phase;
  for(let i=0;i<180;i++){
    const job=await store.get(agent,id);
    if(job?.phase!==phase){phase=job?.phase;console.log(JSON.stringify({request:id,phase}));}
    if(job&&predicate(job))return job;
    if(job&&job.status!=='running')throw Error(`Request ${id} ended early: ${job.status}`);
    await delay(1000);
  }
  throw Error(`Request ${id} did not reach expected phase`);
}
async function complete(input){
  const r=await request('/messages',input);receipt.event('http-result',{...r});
  assert.equal(r.status,200);assert.equal(r.body.job.status,'completed');jobs.push(r.body.job);return r.body.job;
}
async function detached(){
  for(let i=0;i<60;i++){
    const drive=await Drive.getOrCreate({...settings.credentials,name:agentDriveName(agent),region:REGION,maxSize:DRIVE_BYTES,signal:AbortSignal.timeout(10_000)});
    if(!drive.currentSessionId&&!drive.currentSandboxName)return;
    await delay(1000);
  }
  throw Error('Test Drive did not detach');
}
try {
  receipt.event('test-start',{agent,namespace,node:process.version});
  await start();
  const first={agent,requestId:'write',conversation:'main',message:[
    `Remember this conversation-only marker: ${history}. Do not write it to a file.`,
    `Use the write tool to create ${WORKSPACE}/MEMORY.md with exactly:`,memoryBytes,
    `Use the write tool to create ${WORKSPACE}/restart-proof.txt with exactly:`,fileBytes,
    'Reply WRITTEN after both tools succeed.',
  ].join('\n')};
  assert.equal((await request('/messages',first,false)).status,401);
  assert.equal((await request('/messages',{})).status,400);
  assert.equal(await store.get(agent,'write'),null);
  passed('http-invalid-requests-not-admitted');
  const pending=complete(first);pending.catch(()=>{});
  await poll('write',j=>j.resources.some(r=>r.kind==='workload'&&r.sessionId));
  assert.equal((await request('/messages',first)).status,202);
  assert.equal((await request('/messages',{...first,requestId:'competing'})).status,409);
  assert.equal((await request('/messages',{...first,message:'changed'})).status,409);
  passed('http-running-duplicate-busy-and-conflict');
  const written=await pending;
  assert.equal(written.drive.name,agentDriveName(agent));assert(written.drive.id);
  const duplicate=await request('/messages',first);
  assert.equal(duplicate.body.duplicate,true);assert.deepEqual(duplicate.body.job,written);
  passed('http-completed-duplicate-same-result');
  await stop();await start();
  assert.equal((await request(`/requests?agent=${agent}&requestId=write`)).body.job.reply,written.reply);
  const recall=await complete({agent,requestId:'recall',conversation:'main',message:'What was the conversation-only marker? Reply with just that marker, without tools.'});
  assert(recall.reply.includes(history));assert.equal(recall.nativeSessionId,written.nativeSessionId);
  passed('new-controller-and-new-vm-recall-conversation');
  const fresh=await complete({agent,requestId:'memory',conversation:'fresh',message:'What is the acceptance marker in your workspace memory? Reply with just the marker without using tools.'});
  assert(fresh.reply.includes(memory));assert.notEqual(fresh.nativeSessionId,written.nativeSessionId);
  const ids=jobs.flatMap(j=>j.resources.filter(r=>r.kind==='workload').map(r=>r.sessionId));
  assert.equal(new Set(ids).size,3);
  assert(jobs.every(j=>j.drive.id===written.drive.id));
  passed('three-fresh-workload-vms',{sessionIds:ids});
  const image=written.resources.find(r=>r.kind==='workload').image;
  const crashedInput={agent,requestId:'controller-loss',conversation:'main',message:'Reply with HELLO.'};
  const lost=request('/messages',crashedInput).catch(()=>({connectionLost:true}));
  const running=await poll('controller-loss',j=>j.phase==='starting'&&j.resources.some(r=>r.kind==='workload'&&r.sessionId));
  await stop('SIGKILL');await lost;
  assert.equal((await store.get(agent,'controller-loss')).phase,'starting','Fault must land before dispatch');
  receipt.event('controller-killed',{job:running,injectionPhase:running.phase});
  const resource=running.resources.find(r=>r.kind==='workload');
  const box=await Sandbox.get({...settings.credentials,name:resource.name,signal:AbortSignal.timeout(30_000)});
  await box.stop({signal:AbortSignal.timeout(120_000)});await detached();
  assert.equal(await store.redis.command(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],1) end return 0",1,store.keys(agent)[1],running.owner]),1);
  await delay(30);await start();
  const interrupted=await request('/messages',crashedInput);
  assert.equal(interrupted.body.duplicate,true);assert.equal(interrupted.body.job.status,'interrupted');
  assert.deepEqual(interrupted.body.job.resources,running.resources);
  passed('controller-process-loss-before-dispatch-no-replay',{sessionId:resource.sessionId});
  await stop();
  if(!controllerOnly){
  const a=await AgentRun.attach(settings,agent,receipt,{image});
  const config=await a.sandbox.readFileToBuffer({path:`${STATE}/openclaw.json`});assert(config);
  assert(config.toString().includes('${OPENCLAW_DRIVES_MODEL_KEY}'));
  assert.equal((await a.readWorkspaceFile('MEMORY.md')).toString(),memoryBytes);
  assert.equal((await a.readWorkspaceFile('restart-proof.txt')).toString(),fileBytes);
  await assert.rejects(AgentRun.attach(settings,agent,receipt,{image}),/already has a writer/);
  passed('drive-writer-guard-and-exact-workspace-files');
  await a.start();
  assert(a.gateway,'Test requires the running gateway command');
  const injection=await a.sandbox.runCommand({cmd:'node',args:['-e',`
    const fs=require('node:fs'),assert=require('node:assert/strict');
    const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{
      try{return fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='openclaw-gatewa';}catch{return false;}
    });
    assert.equal(pids.length,1,'Require exactly one synthetic OpenClaw gateway');
    console.log(JSON.stringify({targetPid:Number(pids[0]),signal:'SIGKILL'}));
    process.kill(Number(pids[0]),'SIGKILL');
  `],timeoutMs:10_000,signal:AbortSignal.timeout(15_000)});
  receipt.event('gateway-crash-injection',{commandId:injection.cmdId,exitCode:injection.exitCode,stdout:await injection.stdout()});
  assert.equal(injection.exitCode,0);
  const killed=await a.gateway.wait({signal:AbortSignal.timeout(30_000)});
  assert.notEqual(killed.exitCode,0);await a.diagnostics();
  receipt.event('gateway-sigkill',{sessionId:a.sandbox.currentSession().sessionId,commandId:killed.cmdId,exitCode:killed.exitCode,injectionPhase:'idle-after-health'});
  await a.sandbox.stop({signal:AbortSignal.timeout(120_000)});await detached();
  const recoveryAfter=Date.now()+305_000;
  receipt.event('native-lease-cooldown',{recoveryAfter,reason:'Pinned gateway owner lease TTL is five minutes; wait after confirmed VM stop'});
  while(Date.now()<recoveryAfter){
    console.log(JSON.stringify({phase:'native-lease-cooldown',remainingSeconds:Math.ceil((recoveryAfter-Date.now())/1000)}));
    await delay(Math.min(30_000,recoveryAfter-Date.now()));
  }
  const b=await AgentRun.attach(settings,agent,receipt,{image});
  assert.deepEqual(await b.sandbox.readFileToBuffer({path:`${STATE}/openclaw.json`}),config);
  assert.equal((await b.readWorkspaceFile('MEMORY.md')).toString(),memoryBytes);
  assert.equal((await b.readWorkspaceFile('restart-proof.txt')).toString(),fileBytes);
  await b.start();
  const recovered=await b.turn(sessionId('main'),'What was the conversation-only marker? Reply with just that marker, without tools.');
  assert(recovered.text.includes(history));assert.equal(recovered.sessionId,written.nativeSessionId);
  const memoryReply=await b.turn(sessionId('after-crash'),'What is the acceptance marker in your workspace memory? Reply with just the marker without tools.');
  assert(memoryReply.text.includes(memory));assertNativeMemory(memoryReply);
  await b.quiesce();await b.stop();
  passed('gateway-sigkill-then-supported-stop-recovery',{configSHA256:digest(config),crashedSession:a.sandbox.currentSession().sessionId,recoveredSession:b.sandbox.currentSession().sessionId});
  }
  receipt.finish('passed',{checks,agent,namespace,jobs,controllerOnly,limitations:['Controller killed before model dispatch',controllerOnly?'Native crash checks excluded in this mode':'Gateway killed while idle, followed by supported Sandbox.stop and five-minute cooldown','No VM power-loss test','Hosted deployment not tested']});
  console.log(JSON.stringify({status:'passed',checks,receipt:receipt.directory}));
} catch(error) {
  receipt.finish('failed',{checks,agent,namespace,jobs,error:error.message,resourcesPreserved:true});
  console.error(JSON.stringify({status:'failed',checks,receipt:receipt.directory,error:error.message}));
  process.exitCode=1;
} finally {await stop().catch(()=>{});}
