import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Job } from './controller-store.js';
import { STATE, VERSION, type Settings } from './config.js';
import { configuration } from './openclaw.js';
import { AgentRun, runtimeNetworkPolicy, type Platform, type RuntimeHandle } from './runtime.js';
import { slackProxySource, slackGatewaySource } from './slack-proxy.js';
import { Receipt } from './receipt.js';
import { type SlackEvent, type SlackPolicy } from './slack-intake.js';

export const SLACK_PACKAGE = `@openclaw/slack@${VERSION}`;
const OBSERVER = '/tmp/openclaw-drives-observer';
export const observerSource = String.raw`
import fs from 'node:fs';
const root='/tmp/openclaw-drives-observer';
export default {id:'drives-slack-observer',register(api){
  const record=(type,data)=>fs.appendFileSync(root+'/events.jsonl',JSON.stringify({type,at:Date.now(),...data})+'\n',{mode:0o600});
  const active=()=>{try{return JSON.parse(fs.readFileSync(root+'/active.json','utf8'))}catch{return null}};
  api.on('message_received',(event,ctx)=>{
    const a=active();if(!a||ctx.channelId!=='slack'||event.messageId!==a.messageTs)return;
    record('received',{eventId:a.eventId,messageId:event.messageId,sessionKey:event.sessionKey??ctx.sessionKey,senderId:event.senderId});
  });
  api.on('agent_end',(event,ctx)=>{
    const a=active();if(!a||!ctx.sessionKey)return;
    record('agent-end',{eventId:a.eventId,sessionKey:ctx.sessionKey,sessionId:ctx.sessionId,runId:event.runId??ctx.runId,success:event.success,error:event.error});
  });
  api.on('message_sent',(event,ctx)=>{
    const a=active();if(!a||ctx.channelId!=='slack')return;
    record('sent',{eventId:a.eventId,sessionKey:event.sessionKey??ctx.sessionKey,success:event.success,messageId:event.messageId,content:event.content,error:event.error});
  });
  record('observer-ready',{});
}};
`;
export function slackConfiguration(model: string, policy: SlackPolicy) {
  return { ...configuration(model),
    commands: { native: false, nativeSkills: false, text: false, bash: false, config: false, mcp: false, plugins: false, debug: false, restart: false },
    messages: { visibleReplies: 'automatic', groupChat: { visibleReplies: 'automatic' }, ackReaction: '', statusReactions: { enabled: false } },
    channels: { slack: {
      enabled: true, mode: 'http', botToken: '${SLACK_BOT_TOKEN}', signingSecret: '${SLACK_SIGNING_SECRET}', webhookPath: '/slack/events',
      dmPolicy: 'disabled', groupPolicy: 'allowlist', allowFrom: [policy.userId], requireMention: true, configWrites: false,
      commands: { native: false, nativeSkills: false }, slashCommand: { enabled: false }, joinIntro: false,
      streaming: { mode: 'off' }, replyToMode: 'all', reactionNotifications: 'off', thread: { historyScope: 'thread', inheritParent: false },
      channels: { [policy.channelId]: { requireMention: true, users: [policy.userId] } },
    } },
    plugins: { allow: ['slack','drives-slack-observer'], load: { paths: [OBSERVER] }, entries: {
      slack: { enabled: true }, 'drives-slack-observer': { enabled: true, hooks: { allowConversationAccess: true } },
    } },
  };
}
export interface Observation { type: string; eventId?: string; sessionKey?: string; sessionId?: string; runId?: string; success?: boolean; messageId?: string; content?: string; error?: string }
export function inspectDelivery(records: Observation[], eventId: string) {
  const received = records.filter(r => r.type === 'received' && r.eventId === eventId);
  assert(received.length <= 1, 'More than one native intake was observed.');
  const sessionKey = received[0]?.sessionKey;
  if (!sessionKey) return null;
  const matched = records.filter(r => r.eventId === eventId && r.sessionKey === sessionKey);
  const ends = matched.filter(r => r.type === 'agent-end');
  const sent = matched.filter(r => r.type === 'sent');
  assert(!ends.some(r => !r.success) && !sent.some(r => !r.success), 'Native agent or Slack delivery failed.');
  assert(ends.length <= 1, 'Multiple agent runs were observed for one admitted event.');
  if (!ends.length || !sent.length) return null;
  const ended = ends[0]!;
  assert(ended.sessionId && ended.runId, 'Native agent identity is missing.');
  assert(sent.every(r => r.messageId && r.content), 'Text delivery receipt is incomplete.');
  return { text: sent.map(r => r.content!).join('\n'), sessionId: ended.sessionId, runId: ended.runId,
    sessionKey, messageIds: sent.map(r => r.messageId!) };
}
export const prepareInstallConfig = String.raw`
const fs=require('fs'),path=require('path');const p=process.argv[1];
fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});
try{fs.writeFileSync(p,'{}',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error;}
const stat=fs.lstatSync(p);if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o022))throw Error('Unsafe existing installation config.');
const config=JSON.parse(fs.readFileSync(p,'utf8'));if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid installation config.');
`;
export function installedSlack(reports: any): boolean {
  assert(Array.isArray(reports),'Invalid official plugin inspection.');
  const matches=reports.filter(r=>r.plugin?.id==='slack');
  assert(matches.length<=1,'Ambiguous Slack installation.');
  if(!matches.length)return false;
  const {plugin,install}=matches[0];
  assert(plugin.version===VERSION && install?.source==='npm' && install.version===VERSION &&
    [SLACK_PACKAGE,`npm:${SLACK_PACKAGE}`].includes(install.spec),'Slack install record differs from the pinned package. Inspect before recovery.');
  return true;
}
export async function ensureSlackPlugin(run: Pick<AgentRun,'sandbox'|'env'>, settings: Settings, slackToken: string, receipt: Receipt) {
  const installConfig=`${STATE}/.plugin-install/openclaw.json`;
  const {SLACK_BOT_TOKEN:_bot,SLACK_SIGNING_SECRET:_signing,...baseEnv}=run.env;
  const env={...baseEnv,OPENCLAW_CONFIG_PATH:installConfig};
  const prepare=await run.sandbox.runCommand({cmd:'node',args:['-e',prepareInstallConfig,installConfig],env,signal:AbortSignal.timeout(15000)});
  assert.equal(prepare.exitCode,0,'Installation config preparation failed.');
  const inspect=async()=>{
    const command=await run.sandbox.runCommand({cmd:'node',args:['/app/openclaw.mjs','plugins','inspect','--all','--json'],env,cwd:'/app',signal:AbortSignal.timeout(30000)});
    const stdout=await command.stdout();
    assert.equal(command.exitCode,0,'Official plugin inspection failed.');
    const reports=JSON.parse(stdout);
    assert(Array.isArray(reports),'Invalid official plugin inspection.');
    receipt.event('slack-plugin-inspect',{commandId:command.cmdId,exitCode:command.exitCode,slack:reports.filter(r=>r.plugin?.id==='slack').map(r=>({version:r.plugin.version,install:r.install}))});
    return installedSlack(reports);
  };
  if(await inspect())return;
  try {
    await run.sandbox.update({networkPolicy:runtimeNetworkPolicy(settings.gatewayKey,slackToken,true)},{signal:AbortSignal.timeout(30000)});
    const install=await run.sandbox.runCommand({cmd:'node',args:['/app/openclaw.mjs','plugins','install',`npm:${SLACK_PACKAGE}`,'--pin'],env,cwd:'/app',signal:AbortSignal.timeout(150000)});
    receipt.event('slack-plugin-install',{commandId:install.cmdId,exitCode:install.exitCode,stdout:await install.stdout(),stderr:await install.stderr()});
    assert.equal(install.exitCode,0,'Official Slack plugin installation failed. Inspect preserved state before retrying.');
  } finally {
    await run.sandbox.update({networkPolicy:runtimeNetworkPolicy(settings.gatewayKey,slackToken)},{signal:AbortSignal.timeout(30000)});
  }
  assert(await inspect(),'Official Slack installation was not recorded.');
}
export class SlackRun {
  private suspensionId?: string;
  private constructor(readonly run: AgentRun, private event: SlackEvent | undefined, private readonly receipt: Receipt, private readonly policy: SlackPolicy) {}
  get sandbox() { return this.run.sandbox; }
  static async attach(settings: Settings, agent: string, receipt: Receipt, policy: SlackPolicy, slackToken: string,
    options: { services?: Platform; image?: string; event?: SlackEvent; timeoutMs?: number } = {}) {
    const config = slackConfiguration(settings.model, policy);
    const run = await AgentRun.attach(settings, agent, receipt, { services: options.services, image: options.image, timeoutMs:options.timeoutMs,
      extension: { config, environment: { SLACK_BOT_TOKEN: 'xoxb-sandbox-brokered', SLACK_SIGNING_SECRET: randomBytes(32).toString('hex') },
        slackToken, gatewayEntrypoint: OBSERVER+'/gateway.mjs', prepare: async run => {
          await ensureSlackPlugin(run,settings,slackToken,receipt);
          await run.sandbox.writeFiles([
            {path:OBSERVER+'/slack-proxy.mjs',content:Buffer.from(slackProxySource)},
            {path:OBSERVER+'/gateway.mjs',content:Buffer.from(slackGatewaySource)},
            {path:OBSERVER+'/package.json',content:Buffer.from(JSON.stringify({name:'drives-slack-observer',version:'1.0.0',type:'module',openclaw:{extensions:['./index.js']}}))},
            {path:OBSERVER+'/openclaw.plugin.json',content:Buffer.from(JSON.stringify({id:'drives-slack-observer',activation:{onStartup:true},configSchema:{type:'object',properties:{},additionalProperties:false}}))},
            {path:OBSERVER+'/index.js',content:Buffer.from(observerSource)},
          ]);
        },
      },
    });
    return new SlackRun(run,options.event,receipt,policy);
  }
  static async reconnect(settings: Settings, agent: string, receipt: Receipt, policy: SlackPolicy, handle: RuntimeHandle,
    options: {services?: Platform; slackToken?: string; event?: SlackEvent; allowQuiesced?: boolean} = {}) {
    const run=await AgentRun.reconnect(settings,agent,receipt,handle,options);
    return new SlackRun(run,options.event,receipt,policy);
  }
  async drainAfterTurn(requestId: string, deadline=Date.now()+60000) {
    let suspension=await this.rpc('gateway.suspend.prepare',{requestId,drain:true,terminalPolicy:'preserve'});
    const suspensionId=suspension.suspensionId;assert(typeof suspensionId==='string','Native drain identity is missing.');
    while(suspension.status==='draining'&&Date.now()<deadline){await delay(500);suspension={...await this.rpc('gateway.suspend.status',{suspensionId}),suspensionId};}
    assert(suspension.status==='ready'&&suspension.expiresAtMs>Date.now()+15000,'Native reply drain was not confirmed.');
    this.suspensionId=suspension.suspensionId;return suspension;
  }
  async resumeAfterTurn() {
    assert(this.suspensionId,'Completed turn has no drain fence.');
    const result=await this.rpc('gateway.suspend.resume',{suspensionId:this.suspensionId});
    assert(result.ok,'Native gateway did not resume.');this.suspensionId=undefined;
  }
  async prepareIdle(requestId: string): Promise<boolean> {
    const work=await this.rpc('gateway.restart.preflight');
    assert(typeof work.safe==='boolean','Native activity state is unknown.');
    if(!work.safe)return false;
    const suspension=await this.rpc('gateway.suspend.prepare',{requestId,drain:true,terminalPolicy:'preserve'});
    if(suspension.status==='ready' && suspension.expiresAtMs>Date.now()+15000)return true;
    if(suspension.suspensionId){const resumed=await this.rpc('gateway.suspend.resume',{suspensionId:suspension.suspensionId});assert(resumed.ok);}
    return false;
  }
  async rpc(method: string, params: object = {}): Promise<any> {
    const command = await this.sandbox.runCommand({cmd:'node',args:['/app/openclaw.mjs','gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout','15000'],env:this.run.env,cwd:'/app',signal:AbortSignal.timeout(30000)});
    const stdout=await command.stdout();this.receipt.event('slack-rpc',{method,commandId:command.cmdId,exitCode:command.exitCode,stdout,stderr:await command.stderr()});
    assert.equal(command.exitCode,0,`Native RPC ${method} failed.`);return JSON.parse(stdout);
  }
  async start() {
    if(this.run.stage==='attached') await this.run.start();
    else assert.equal(this.run.stage,'ready');
    const auth = await this.sandbox.runCommand({cmd:'node',args:['-e',String.raw`
      const fs=require('fs');const {url}=JSON.parse(fs.readFileSync('/tmp/openclaw-drives-observer/slack-proxy-url.json','utf8'));
      (async()=>{
        const r=await fetch(url+'auth.test',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:process.env.SLACK_BOT_TOKEN}),signal:AbortSignal.timeout(15000)});
        const d=await r.json();console.log(JSON.stringify({ok:d.ok,error:d.error,teamId:d.team_id,userId:d.user_id}));if(!d.ok)process.exitCode=1;
      })().catch(()=>{process.exitCode=1});
    `],env:this.run.env,signal:AbortSignal.timeout(20000)});
    const proof=JSON.parse(await auth.stdout());
    this.receipt.event('slack-broker-auth',{commandId:auth.cmdId,exitCode:auth.exitCode,...proof});
    assert.equal(auth.exitCode,0,'Slack body-token authorization failed.');
    assert.equal(proof.teamId,this.policy.teamId,'Slack workspace identity differs.');
    assert.equal(proof.userId,this.policy.botUserId,'Slack bot identity differs.');
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      const status=await this.rpc('channels.status',{probe:false});const account=status.channelAccounts?.slack?.find((a:any)=>a.accountId==='default');
      assert(!account?.lastError, 'Slack channel failed during startup.');
      if(account?.configured && account.running && account.connected){
        const records=await this.observations();assert(records.some(r=>r.type==='observer-ready'),'Native observer did not register.');return;
      }
      await delay(1000);
    }
    throw Error('Slack channel did not become ready.');
  }
  async observations(): Promise<Observation[]> {
    const bytes=await this.sandbox.readFileToBuffer({path:OBSERVER+'/events.jsonl'},{signal:AbortSignal.timeout(10000)});
    return bytes ? bytes.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
  }
  async turn(): Promise<{text:string;sessionId:string;delivery:NonNullable<Job['delivery']>}> {
    assert(this.event,'No admitted Slack event.');assert.equal(this.run.stage,'ready');this.run.stage='turn';
    try {
      const event=this.event;
      await this.sandbox.writeFiles([{path:OBSERVER+'/active.json',content:Buffer.from(JSON.stringify({eventId:event.eventId,messageTs:event.messageTs}))},{path:OBSERVER+'/body.json',content:Buffer.from(event.rawBody)}]);
      const delivered=await this.sandbox.runCommand({cmd:'node',args:['-e',String.raw`
        const fs=require('fs'),crypto=require('crypto');const raw=fs.readFileSync('/tmp/openclaw-drives-observer/body.json');
        const timestamp=String(Math.floor(Date.now()/1000));const signature='v0='+crypto.createHmac('sha256',process.env.SLACK_SIGNING_SECRET).update('v0:'+timestamp+':').update(raw).digest('hex');
        fetch('http://127.0.0.1:18789/slack/events',{method:'POST',headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':signature},body:raw,signal:AbortSignal.timeout(15000)}).then(async r=>{console.log(JSON.stringify({status:r.status,sha256:crypto.createHash('sha256').update(raw).digest('hex')}));if(r.status!==200)process.exitCode=1}).catch(()=>{process.exitCode=1});
      `],env:this.run.env,signal:AbortSignal.timeout(20000)});
      assert.equal(delivered.exitCode,0,'Native Slack intake rejected the event.');const proof=JSON.parse(await delivered.stdout());assert.equal(proof.sha256,event.sha256);this.receipt.event('native-slack-intake',{eventId:event.eventId,...proof});
      const deadline=Date.now()+180000;let reply;
      while(Date.now()<deadline){reply=inspectDelivery(await this.observations(),event.eventId);if(reply)break;await delay(1000);}
      assert(reply,'Native Slack delivery was not confirmed.');
      const suspension=await this.drainAfterTurn(event.eventId,deadline);
      reply=inspectDelivery(await this.observations(),event.eventId);assert(reply);
      this.receipt.event('native-slack-delivered',{eventId:event.eventId,sha256:event.sha256,...reply,suspension});
      this.suspensionId=suspension.suspensionId;
      this.run.stage='ready';return { ...reply, delivery: { provider:'slack', eventId:event.eventId, sha256:event.sha256, sessionKey:reply.sessionKey, runId:reply.runId, messageIds:reply.messageIds } };
    }catch(error){this.run.stage='failed';this.receipt.event('native-slack-failure',{observations:await this.observations().catch(()=>[])});throw error;}
  }
  quiesce(){return this.run.quiesce();}
  stop(){return this.run.stop();}
}
