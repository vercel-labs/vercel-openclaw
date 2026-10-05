import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDelivery, slackConfiguration, observerSource } from '../dist/slack-native.js';
import { bodyHash } from '../dist/slack-intake.js';
import { slackIdentity } from '../dist/slack-worker.js';
const received={type:'received',eventId:'Ev1',sessionKey:'native-key'};
const ended={type:'agent-end',eventId:'Ev1',sessionKey:'native-key',sessionId:'native-session',runId:'native-run',success:true};
const sent={type:'sent',eventId:'Ev1',sessionKey:'native-key',messageId:'123.456',success:true,content:'reply'};
test('agent completion alone or delivery alone cannot establish success',()=>{
  assert.equal(inspectDelivery([received,ended],'Ev1'),null);assert.equal(inspectDelivery([received,sent],'Ev1'),null);
  const result=inspectDelivery([received,ended,sent],'Ev1');assert.equal(result.sessionId,'native-session');assert.deepEqual(result.messageIds,['123.456']);
});
test('partial delivery followed by failure, failed agent and duplicate intake fail closed',()=>{
  for(const records of [[received,ended,sent,{...sent,success:false}],[received,{...ended,success:false},sent],[received,received,ended,sent],[received,ended,ended,sent],[received,ended,{...sent,messageId:undefined}]])assert.throws(()=>inspectDelivery(records,'Ev1'));
});
test('actual native session correlates hooks; unrelated sessions cannot satisfy completion',()=>{
  assert.equal(inspectDelivery([received,{...ended,sessionKey:'other'},sent],'Ev1'),null);
  assert.equal(inspectDelivery([received,ended,{...sent,eventId:'Ev2'}],'Ev1'),null);
  assert.equal(inspectDelivery([received,ended,{...sent,sessionKey:'other'}],'Ev1'),null);
});
test('Slack Drive identity separates apps and channels while threads share state',()=>{
  const event={teamId:'T1',channelId:'C1',eventId:'Ev1',threadTs:'1.1',rawBody:'body'};
  const a=slackIdentity(event,'A1'),b=slackIdentity({...event,threadTs:'2.2'},'A1');assert.equal(a.agent,b.agent);assert.notEqual(a.conversation,b.conversation);
  assert.notEqual(a.agent,slackIdentity(event,'A2').agent);assert.notEqual(a.agent,slackIdentity({...event,channelId:'C2'},'A1').agent);assert.equal(a.message,event.rawBody);
});
test('native configuration stores credential references and restricts user/channel/commands',()=>{
  const config=slackConfiguration('openai/gpt-5.4',{teamId:'T1',appId:'A1',channelId:'C1',userId:'U1',botUserId:'U2'});
  assert.equal(config.channels.slack.botToken,'${SLACK_BOT_TOKEN}');assert.equal(config.channels.slack.signingSecret,'${SLACK_SIGNING_SECRET}');assert.equal(config.channels.slack.dmPolicy,'disabled');assert.deepEqual(Object.keys(config.channels.slack.channels),['C1']);assert.equal(config.commands.text,false);
  assert.equal(config.plugins.entries['drives-slack-observer'].hooks.allowConversationAccess,true);assert.equal(bodyHash(observerSource).length,64);
});

test('installation temporarily allows only the registry in addition to the runtime hosts',async()=>{
  const {runtimeNetworkPolicy}=await import('../dist/runtime.js');
  const runtime=runtimeNetworkPolicy('model-secret','slack-secret');const installing=runtimeNetworkPolicy('model-secret','slack-secret',true);
  assert.deepEqual(Object.keys(runtime.allow),['ai-gateway.vercel.sh','slack.com']);assert.deepEqual(Object.keys(installing.allow),['ai-gateway.vercel.sh','slack.com','registry.npmjs.org']);
  assert.deepEqual(runtime.allow['slack.com'].at(-1),{response:{statusCode:403}});assert.deepEqual(installing.allow['slack.com'],runtime.allow['slack.com']);
});

test('installation config preparation preserves an existing official config',async()=>{
  const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const {prepareInstallConfig}=await import('../dist/slack-native.js');
  const directory=await mkdtemp(join(tmpdir(),'slack-install-'));const path=join(directory,'config.json');
  try{
    assert.equal(spawnSync(process.execPath,['-e',prepareInstallConfig,path]).status,0);
    const existing='{"plugins":{"entries":{"slack":{"enabled":true}}}}';await writeFile(path,existing);
    assert.equal(spawnSync(process.execPath,['-e',prepareInstallConfig,path]).status,0);
    assert.equal(await readFile(path,'utf8'),existing);
  }finally{await rm(directory,{recursive:true,force:true});}
});

const pinnedInstall={plugin:{id:'slack',version:'2026.9.6'},install:{source:'npm',version:'2026.9.6',spec:'@openclaw/slack@2026.9.6'}};
function installFixture({installed=false,prepareFails=false,installFails=false}={}){
 const policies=[],commands=[];let installedNow=installed;
 const sandbox={
  update:async({networkPolicy})=>policies.push(networkPolicy),
  runCommand:async command=>{
   commands.push(command);const args=command.args;
   let exitCode=0,output='';
   if(args[0]==='-e'&&prepareFails)exitCode=1;
   if(args.includes('inspect'))output=JSON.stringify(installedNow?[pinnedInstall]:[]);
   if(args.includes('install')){exitCode=installFails?1:0;if(!installFails)installedNow=true;}
   return {exitCode,cmdId:'fake',stdout:async()=>output,stderr:async()=>''};
  },
 };
 return {run:{sandbox,env:{OPENCLAW_STATE_DIR:'/data/openclaw',SLACK_BOT_TOKEN:'placeholder',SLACK_SIGNING_SECRET:'ephemeral'}},policies,commands};
}
test('preparation failure never widens registry egress',async()=>{
 const {ensureSlackPlugin}=await import('../dist/slack-native.js');const f=installFixture({prepareFails:true});
 await assert.rejects(ensureSlackPlugin(f.run,{gatewayKey:'key'},'slack',{event(){}}),/preparation failed/);
 assert.equal(f.policies.length,0);
});
test('failed official installation restores runtime firewall policy',async()=>{
 const {ensureSlackPlugin}=await import('../dist/slack-native.js');const f=installFixture({installFails:true});
 await assert.rejects(ensureSlackPlugin(f.run,{gatewayKey:'key'},'slack',{event(){}}),/installation failed/);
 assert('registry.npmjs.org' in f.policies[0].allow);assert(!('registry.npmjs.org' in f.policies.at(-1).allow));
});
test('official install record supports restart without an application marker',async()=>{
 const {ensureSlackPlugin}=await import('../dist/slack-native.js');const f=installFixture({installed:true});
 await ensureSlackPlugin(f.run,{gatewayKey:'key'},'slack',{event(){}});
 assert.equal(f.policies.length,0);assert(!f.commands.some(c=>c.args.includes('install')));
 assert(f.commands.every(c=>!('SLACK_BOT_TOKEN' in c.env)&&!('SLACK_SIGNING_SECRET' in c.env)));
});
test('absent plugin installs once and verifies the official record',async()=>{
 const {ensureSlackPlugin}=await import('../dist/slack-native.js');const f=installFixture();
 await ensureSlackPlugin(f.run,{gatewayKey:'key'},'slack',{event(){}});
 assert.equal(f.commands.filter(c=>c.args.includes('install')).length,1);
 assert.equal(f.commands.filter(c=>c.args.includes('inspect')).length,2);
 assert(!('registry.npmjs.org' in f.policies.at(-1).allow));
});
test('unrecorded or mismatched plugin state is preserved for inspection',async()=>{
 const {installedSlack}=await import('../dist/slack-native.js');
 assert.equal(installedSlack([]),false);assert.equal(installedSlack([pinnedInstall]),true);
 assert.throws(()=>installedSlack([{plugin:pinnedInstall.plugin}]));
 assert.throws(()=>installedSlack([{...pinnedInstall,install:{...pinnedInstall.install,version:'other'}}]));
});


test('drain keeps suspension identity when status response omits it',async()=>{
 const {SlackRun}=await import('../dist/slack-native.js');
 const calls=[];const receiver={rpc:async(method,params)=>{
  calls.push({method,params});
  if(method==='gateway.suspend.prepare')return {status:'draining',suspensionId:'drain-one'};
  if(method==='gateway.suspend.status')return {status:'ready',expiresAtMs:Date.now()+120000};
  return {ok:true};
 }};
 const result=await SlackRun.prototype.drainAfterTurn.call(receiver,'request');assert.equal(result.suspensionId,'drain-one');
 await SlackRun.prototype.resumeAfterTurn.call(receiver);
 assert.deepEqual(calls.at(-1),{method:'gateway.suspend.resume',params:{suspensionId:'drain-one'}});
});
