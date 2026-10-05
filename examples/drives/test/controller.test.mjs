import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Controller, validateMessage } from '../dist/controller.js';
import { handler, createHTTPServer } from '../dist/http.js';

const settings={credentials:{token:'platform-secret',projectId:'prj_test',teamId:'team_test'},gatewayKey:'model-secret',image:'official:2026.9.6',model:'openai/gpt-5.4'};
const input=validateMessage({agent:'test',requestId:'one',message:'hello'});
function fixture(failure,hooks={}) {
  const calls=[];let job;let ready=null;let lock=false;let idPatchFailed=false;
  const store={
    async begin(i){if(job)return {kind:'duplicate',job};if(lock)return {kind:'busy'};lock=true;
      job={...i,owner:'owner',fingerprint:'hash',status:'running',phase:'admitted',resources:[]};return {kind:'accepted',job,ready}},
    async patch(a,id,owner,patch,finish){calls.push(['patch',patch]);
      if(failure==='metadata'&&patch.phase==='dispatching')throw Error('metadata unavailable');
      if(failure==='drive-metadata'&&patch.drive&&!finish)throw Error('drive metadata unavailable');
      if(failure==='sandbox-id-metadata'&&!idPatchFailed&&patch.resources?.some(r=>r.sessionId)){idPatchFailed=true;throw Error('temporary metadata error');}
      job={...job,...patch};if(finish)lock=false;return job},
    async ready(a,owner,value){ready=value},async get(){return job},
  };
  const receipt={event(){if(failure==='receipt-write')throw Error('results path unwritable')},finish(){if(failure==='receipt-finish')throw Error('results path unwritable')},addSecret(){}};
  const sandbox={name:'vm',image:'official@sha256:abc',currentSession:()=>({sessionId:'sbx_test'})};
  const dependencies={receipt:()=>{if(failure==='receipt-create')throw Error('results path unwritable');return receipt},platform:{drive:async()=>{calls.push(['drive']);return {driveId:'drive_test'}},create:async()=>{calls.push(['allocate']);return sandbox}},
    initialize:async(s,a,r,services)=>{calls.push(['init']);await services.drive({name:'openclaw-test'});await services.create({name:'init',image:'vercel/sandbox/node:24'});return {}},
    attach:async(s,a,r,{services})=>{await services.create({name:'workload',image:'official'});return {sandbox,
      start:async()=>{calls.push(['start']);if(failure==='startup')throw Error('startup failed')},
      turn:async()=>{calls.push(['turn']);if(failure==='turn')throw Error('turn uncertain');return {text:'hello back',sessionId:'native-session'}},
      quiesce:async()=>{calls.push(['quiesce']);if(failure==='shutdown')throw Error('shutdown failed')},
      stop:async()=>calls.push(['stop'])}}};
  Object.assign(dependencies,hooks);
  return {controller:new Controller(settings,store,'unused',dependencies),store,calls,locked:()=>lock};
}

test('completed result is durable only after shutdown/detach, and a duplicate never executes again',async()=>{
  const f=fixture();const first=await f.controller.message(input);assert.equal(first.body.job.status,'completed');
  assert(f.calls.findIndex(c=>c[0]==='stop')<f.calls.findIndex(c=>c[0]==='patch'&&c[1].status==='completed'));
  const allocations=f.calls.filter(c=>c[0]==='allocate').length;
  const second=await f.controller.message(input);assert.equal(second.body.duplicate,true);assert.equal(second.body.job.reply,'hello back');
  assert.equal(f.calls.filter(c=>c[0]==='allocate').length,allocations);assert(!('owner'in second.body.job));
});
test('allocation intent and resource ID are recorded before agent work',async()=>{
  const f=fixture();await f.controller.message(input);
  const allocation=f.calls.findIndex(c=>c[0]==='allocate');
  assert.equal(f.calls[allocation-1][0],'patch');assert.equal(f.calls[allocation-1][1].phase,'allocating');
  assert(f.calls.some(c=>c[0]==='patch'&&c[1].resources?.some(r=>r.sessionId==='sbx_test')));
});
test('Drive intent and ID are durable before sandbox creation; metadata failure blocks Drive resolution',async()=>{
  const f=fixture();await f.controller.message(input);
  const index=f.calls.findIndex(c=>c[0]==='drive');
  assert.deepEqual(f.calls[index-1],['patch',{drive:{name:'openclaw-test'}}]);
  assert.deepEqual(f.calls[index+1],['patch',{drive:{name:'openclaw-test',id:'drive_test'}}]);
  const failed=fixture('drive-metadata');await failed.controller.message(input);
  assert(!failed.calls.some(c=>['drive','allocate'].includes(c[0])));assert.equal(failed.locked(),false);
});
test('terminal patch preserves resource IDs after a transient post-allocation metadata failure',async()=>{
  const f=fixture('sandbox-id-metadata');const r=await f.controller.message(input);
  assert.equal(r.body.job.status,'failed');assert.equal(r.body.job.resources[0].sessionId,'sbx_test');
  assert.equal(r.body.job.drive.id,'drive_test');assert(!f.calls.some(c=>c[0]==='turn'));assert.equal(f.locked(),false);
});
test('receipt creation or write failure releases admission without cloud work; final log failure preserves success',async()=>{
  for(const failure of ['receipt-create','receipt-write']){
    const f=fixture(failure);const r=await f.controller.message(input);
    assert.equal(r.body.job.status,'failed');assert.equal(f.locked(),false);
    assert(!f.calls.some(c=>['drive','allocate','turn'].includes(c[0])));
  }
  const f=fixture('receipt-finish');const r=await f.controller.message(input);
  assert.equal(r.status,200);assert.equal(r.body.job.status,'completed');assert.equal(f.locked(),false);
});
test('startup and dispatch failures remain distinguishable and are never automatically replayed',async()=>{
  for(const [failure,status] of [['startup','failed'],['turn','interrupted'],['shutdown','interrupted']]) {
    const f=fixture(failure);const result=await f.controller.message(input);
    assert.equal(result.status,503);assert.equal(result.body.job.status,status);assert(!f.calls.some(c=>c[0]==='stop'));
    const before=f.calls.length;await f.controller.message(input);assert.equal(f.calls.length,before);
    if(failure==='shutdown')assert.equal(result.body.job.reply,'hello back');
  }
});
test('metadata failure before dispatch prevents model work',async()=>{
  const f=fixture('metadata');await f.controller.message(input);assert(!f.calls.some(c=>c[0]==='turn'));
});
test('HTTP auth and malformed requests fail before admission; owner tokens are never exposed',async()=>{
  const f=fixture();const handle=handler(f.controller,'x'.repeat(32));
  assert.equal((await handle(new Request('http://localhost/messages',{method:'POST',body:'{}'}))).status,401);
  const headers={authorization:`Bearer ${'x'.repeat(32)}`,'content-type':'application/json'};
  for(const body of ['{}','no-json',JSON.stringify({...input,unexpected:true})])assert.equal((await handle(new Request('http://localhost/messages',{method:'POST',headers,body}))).status,400);
  assert.equal((await handle(new Request('http://localhost/messages',{method:'POST',headers,body:'x'.repeat(32769)}))).status,413);
  assert.equal(f.calls.length,0);
});
test('real localhost HTTP path returns a stored result after controller replacement',async()=>{
  const f=fixture();const token='t'.repeat(32);const server=createHTTPServer(f.controller,token);
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const r=await fetch(url+'/messages',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
    assert.equal(r.status,200);assert.equal((await r.json()).job.status,'completed');
    const replacement=new Controller(settings,f.store,'unused');
    const result=await handler(replacement,token)(new Request('http://localhost/requests?agent=test&requestId=one',{headers:{authorization:`Bearer ${token}`}}));
    assert.equal((await result.json()).job.reply,'hello back');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r))}
});


test('warm completion preserves running gateway and duplicate does not acknowledge or execute twice',async()=>{
 let acknowledgments=0,retained=0;
 const f=fixture(undefined,{admitted:async()=>{acknowledgments++},finished:async()=>{retained++;return 'warm'}});
 const first=await f.controller.message(input);assert.equal(first.body.job.status,'completed');assert.equal(first.body.job.phase,'warm');
 assert.equal(acknowledgments,1);assert.equal(retained,1);assert(!f.calls.some(c=>['quiesce','stop'].includes(c[0])));
 await f.controller.message(input);assert.equal(acknowledgments,1);assert.equal(retained,1);
});
test('warm retention failure fences saved state before releasing controller ownership',async()=>{
 let fenced=false;
 const f=fixture(undefined,{finished:async()=>{throw Error('scheduler failed')},failed:async()=>{fenced=true}});
 const result=await f.controller.message(input);assert.equal(result.body.job.status,'interrupted');assert.equal(result.body.job.reply,'hello back');assert(fenced);assert.equal(f.locked(),false);
});
