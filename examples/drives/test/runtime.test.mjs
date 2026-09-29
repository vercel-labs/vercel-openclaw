import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRun, SHUTDOWN_WAIT_MS } from '../dist/runtime.js';
import { MOUNT } from '../dist/config.js';

const image = 'openclaw-foundation/openclaw/openclaw@sha256:' + 'a'.repeat(64);
const settings = { credentials: {token:'token',projectId:'prj_test',teamId:'team_test'},
  gatewayKey:'gateway-key',image:'openclaw-foundation/openclaw/openclaw:2026.9.6',model:'openai/gpt-5.4' };
const report = () => ({events:[],addSecret(){},event(kind,data){this.events.push({kind,...data})}});
function fixture(options = {}) {
  const calls = [];
  const drive = {name:'openclaw-test',driveId:'drive-test',...options.drive};
  const finished = (stdout='', exitCode=0) => ({cmdId:'cmd-test',exitCode,stdout:async()=>stdout,stderr:async()=>''});
  const gateway = {cmdId:'gateway-test', kill:async(signal)=>calls.push(['kill',signal]),
    wait:async()=>{if(options.stopError)throw new Error('grace timeout');return finished('',options.gatewayExit ?? 0)},
    async *logs(){yield {stream:'stdout',data:'shutdown completed cleanly in 1ms'};if(options.logError)throw new Error('stream interrupted')},
    stdout:async()=> 'shutdown completed cleanly in 1ms',stderr:async()=>''};
  let turnResolve;
  const runCommand = async params => {
    calls.push(['command',params]);
    assert.notEqual(params.cmd,'sudo','Official image has no sudo');
    assert(!params.sudo,'Official image has no sudo');
    assert.equal(params.env?.AI_GATEWAY_API_KEY,undefined,'Do not trigger branded provider auto-install');
    assert.equal(params.env?.OPENCLAW_DRIVES_MODEL_KEY,'sandbox-brokered');
    if(params.args[1]?.includes('userInfo')) return finished(JSON.stringify(options.user ?? {username:'node',uid:1000,gid:1000}));
    if(params.detached)return gateway;
    if(params.args.includes('--version'))return finished('OpenClaw 2026.9.6');
    if(params.args.includes('agent')) {
      if(options.holdTurn)return new Promise(r=>{turnResolve=r});
      return finished(options.agentOutput ?? JSON.stringify({runId:'run',status:'ok',result:{payloads:[{text:'reply'}],meta:{agentMeta:{sessionId:'session',provider:'gateway',model:'openai/gpt-5.4'}}}}));
    }
    if(params.args[1]?.includes('fetch('))return finished('healthy',options.healthExit ?? 0);
    return finished('{}');
  };
  const sandbox = {name:'sandbox-test',image,persistent:false,region:'iad1',mounts:{[MOUNT]:{drive:drive.name}},
    currentSession:()=>({sessionId:'sbx_test'}),asUser:()=>{throw new Error('Official image has no sudo')},runCommand,readFileToBuffer:async()=>Buffer.from('file'),
    stop:async()=>{calls.push(['stop']);return {}},...options.sandbox};
  let gets=0;
  const services = {drive:async()=>{gets++;return gets>1 && options.staysAttached ? {...drive,currentSessionId:'sbx_test'}:drive},
    create:async(params)=>{calls.push(['create',params]);return sandbox}};
  return {calls,services,report:report(),sandbox,resolveTurn:()=>turnResolve?.(finished('{}'))};
}
async function attach(f) {return AgentRun.attach(settings,'test',f.report,{services:f.services,detachAttempts:1})}

test('busy drive fails before creating a VM and never stops another writer',async()=>{
  const f=fixture({drive:{currentSessionId:'other'}});
  await assert.rejects(attach(f),/already has a writer/);
  assert.equal(f.calls.length,0);
});
test('new VM disables snapshot persistence and only brokers Gateway credentials',async()=>{
  const f=fixture();await attach(f);
  const opts=f.calls.find(x=>x[0]==='create')[1];
  assert.equal(opts.persistent,false);assert.equal(opts.source,undefined);
  assert.deepEqual(Object.keys(opts.networkPolicy.allow),['ai-gateway.vercel.sh']);
  assert.equal(opts.env,undefined);assert.equal(opts.ports,undefined);
  assert.equal(opts.mounts[MOUNT].driveId,'drive-test');
});
test('invalid platform mount or image metadata fails with resource IDs already recorded',async()=>{
  for (const sandbox of [{mounts:{}},{image:'moving:latest'},{persistent:true}]) {
    const f=fixture({sandbox});await assert.rejects(attach(f));
    assert(f.report.events.some(e=>e.kind==='sandbox-created'&&e.sessionId==='sbx_test'));
    assert(!f.calls.some(x=>x[0]==='stop'));
  }
});
test('health failure preserves VM and blocks clean shutdown',async()=>{
  const f=fixture({healthExit:1});const run=await attach(f);
  await assert.rejects(run.start(),/gateway-health failed/);assert.equal(run.stage,'failed');
  await assert.rejects(run.quiesce(),/Cannot claim clean/);
  assert(!f.calls.some(x=>x[0]==='stop'));
});
test('gateway failure or grace timeout never triggers stop',async()=>{
  for(const options of [{gatewayExit:1},{stopError:true}]) {
    const f=fixture(options);const run=await attach(f);await run.start();
    await assert.rejects(run.quiesce());assert.equal(run.stage,'failed');
    assert(!f.calls.some(x=>x[0]==='stop'));
  }
});
test('clean handoff waits for gateway exit then Drive detachment',async()=>{
  const f=fixture();const run=await attach(f);await run.start();
  await run.quiesce();assert.equal(run.stage,'quiesced');
  await run.stop();assert.equal(run.stage,'stopped');
  assert(f.calls.findIndex(x=>x[0]==='kill')<f.calls.findIndex(x=>x[0]==='stop'));
});
test('stale attachment after stop is a failed handoff',async()=>{
  const f=fixture({staysAttached:true});const run=await attach(f);await run.start();await run.quiesce();
  await assert.rejects(run.stop(),/did not detach/);assert.equal(run.stage,'failed');
});
test('active turn rejects another turn and shutdown',async()=>{
  const f=fixture({holdTurn:true});const run=await attach(f);await run.start();
  const pending=run.turn('session','hello').catch(()=>{});
  await assert.rejects(run.turn('session','second'),/one turn/);
  await assert.rejects(run.quiesce(),/Cannot claim clean/);
  f.resolveTurn();await pending;
});

test('shutdown wait covers the pinned 315s drain plus 10s cleanup budget',()=>{assert(SHUTDOWN_WAIT_MS >= 325000);assert(SHUTDOWN_WAIT_MS <= 350000)});

test('unexpected image user fails before initialization or gateway startup',async()=>{
 const f=fixture({user:{username:'root',uid:0,gid:0}});const run=await attach(f);
 await assert.rejects(run.start(),/must run as node/);
 assert(!f.calls.some(x=>x[0]==='command'&&x[1].detached));
});

test('interrupted gateway logs retain partial evidence but cannot prove clean shutdown',async()=>{
 const f=fixture({logError:true});const run=await attach(f);await run.start();
 await assert.rejects(run.quiesce(),/Missing explicit clean/);
 assert(f.report.events.some(e=>e.kind==='gateway-output'&&e.complete===false&&e.stdout.includes('shutdown completed')));
 assert(!f.calls.some(x=>x[0]==='stop'));
});
