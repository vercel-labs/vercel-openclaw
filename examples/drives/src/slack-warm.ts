import assert from 'node:assert/strict';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Job} from './controller-store.js';
import {RedisStore} from './controller-store.js';
import type {Settings} from './config.js';
import type {Platform,RuntimeHandle} from './runtime.js';
import {Receipt} from './receipt.js';
import type {SlackEvent,SlackPolicy} from './slack-intake.js';
import {SlackRun} from './slack-native.js';
import {PermanentSlackError} from './slack-auth.js';

export const IDLE_MS=60*60_000;
export const RESERVE_MS=10*60_000;
export const MAX_SESSION_MS=24*60*60_000;
export interface WarmState { generation:string; status:'ready'|'busy'|'pending'|'failed'|'stopping'; handle:RuntimeHandle; idleAt:number; lastActivityAt:number }
export interface IdleEvent { kind:'slack-idle-v1'; agent:string; generation:string; dueAt:number; signature:string }
export type IdleScheduler=(event:Omit<IdleEvent,'signature'>)=>Promise<void>;
const NOW="local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)\n";
const READ="if redis.call('GET',KEYS[1])~=ARGV[1] then return false end return redis.call('GET',KEYS[2]) or 'null'";
const SAVE="if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2]);return 1";
const CLEAR="if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('DEL',KEYS[2]);return 1";
const CLAIM_IDLE=NOW+`
local raw=redis.call('GET',KEYS[2]);if not raw then return 'stale' end
local warm=cjson.decode(raw)
if warm.generation~=ARGV[1] then return 'stale' end
if warm.status=='failed' then return 'failed' end
if warm.idleAt>now then return 'early' end
if not redis.call('SET',KEYS[1],ARGV[2],'NX','PX',1800000) then return 'busy' end
return raw
`;
const RELEASE="if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";

export class WarmStore {
  constructor(readonly store:RedisStore){}
  keys(agent:string):[string,string]{return [this.store.keys(agent)[1],this.store.keys(agent)[2]+':warm-v1'];}
  async read(agent:string,owner:string):Promise<WarmState|null>{
    const raw=await this.store.redis.command(['EVAL',READ,2,...this.keys(agent),owner]);
    assert(typeof raw==='string','Warm lifecycle ownership lost.');return JSON.parse(raw);
  }
  async save(agent:string,owner:string,state:WarmState){
    assert.equal(await this.store.redis.command(['EVAL',SAVE,2,...this.keys(agent),owner,JSON.stringify(state)]),1,'Warm lifecycle ownership lost.');
  }
  async clear(agent:string,owner:string){assert.equal(await this.store.redis.command(['EVAL',CLEAR,2,...this.keys(agent),owner]),1,'Warm lifecycle ownership lost.');}
  async claimIdle(event:IdleEvent,owner:string):Promise<WarmState|'stale'|'failed'|'early'|'busy'>{
    const raw=await this.store.redis.command(['EVAL',CLAIM_IDLE,2,...this.keys(event.agent),event.generation,owner]);
    assert(typeof raw==='string');return raw.startsWith('{')?JSON.parse(raw):raw as 'stale'|'failed'|'early'|'busy';
  }
  async release(agent:string,owner:string){await this.store.redis.command(['EVAL',RELEASE,1,this.keys(agent)[0],owner]);}
}
function idleSignature(event:Omit<IdleEvent,'signature'>,namespace:string,secret:string|undefined){
  assert(secret&&secret.length>=32,'Idle queue signing key is not configured.');
  return createHmac('sha256',secret).update(JSON.stringify([event.kind,namespace,event.agent,event.generation,event.dueAt])).digest();
}
export function signIdle(event:Omit<IdleEvent,'signature'>,namespace:string,secret:string|undefined):IdleEvent{
  return {...event,signature:idleSignature(event,namespace,secret).toString('hex')};
}
export function verifyIdle(event:IdleEvent,namespace:string,secret:string|undefined){
  if(!event||event.kind!=='slack-idle-v1'||!/^slack-[a-f0-9]{32}$/.test(event.agent)||
    !/^[a-f0-9-]{36}$/.test(event.generation)||!Number.isSafeInteger(event.dueAt)||event.dueAt<=0||
    typeof event.signature!=='string'||!/^[a-f0-9]{64}$/.test(event.signature)||
    !timingSafeEqual(idleSignature(event,namespace,secret),Buffer.from(event.signature,'hex')))
    throw new PermanentSlackError('Invalid idle callback.');
}
export function idleDeadline(now:number,createdAt:number,idleMs=IDLE_MS){
  assert(Number.isSafeInteger(idleMs)&&idleMs>0&&idleMs<=IDLE_MS,'Invalid idle interval.');
  return Math.min(now+idleMs,createdAt+MAX_SESSION_MS-RESERVE_MS);
}
export async function extendForIdle(run:SlackRun,idleAt:number){
  const session=run.sandbox.currentSession();
  const target=Math.min(idleAt+RESERVE_MS,session.createdAt.getTime()+MAX_SESSION_MS);
  const current=session.createdAt.getTime()+session.timeout;
  if(target>current)await run.sandbox.extendTimeout(Math.ceil(target-current),{signal:AbortSignal.timeout(30000)});
}

export class WarmSlack {
  private job?:Job;
  private state?:WarmState;
  private run?:SlackRun;
  constructor(private settings:Settings,private store:WarmStore,private policy:SlackPolicy,private token:string,
    private schedule:IdleScheduler,private idleMs=IDLE_MS){}
  admitted(job:Job){this.job=job;}
  async attach(settings:Settings,agent:string,receipt:Receipt,options:{services:Platform;image?:string},event:SlackEvent){
    assert(this.job);const saved=await this.store.read(agent,this.job.owner);
    if(saved){
      assert(saved.status==='ready','Previous warm operation is uncertain. Inspect the preserved VM before recovery.');
      this.state={...saved,status:'busy'};await this.store.save(agent,this.job.owner,this.state);
      this.run=await SlackRun.reconnect(settings,agent,receipt,this.policy,saved.handle,{services:options.services,slackToken:this.token,event});
      const due=idleDeadline(Date.now(),saved.handle.createdAt,this.idleMs);
      if(saved.handle.createdAt+MAX_SESSION_MS-RESERVE_MS<=Date.now()+RESERVE_MS){
        assert(await this.run.prepareIdle('rollover-'+saved.generation),'Cannot roll over an active gateway.');
        await this.run.quiesce();await this.run.stop();await this.store.clear(agent,this.job.owner);this.state=undefined;this.run=undefined;
      }else{
        await extendForIdle(this.run,due);return this.run;
      }
    }
    this.run=await SlackRun.attach(settings,agent,receipt,this.policy,this.token,{...options,event,timeoutMs:this.idleMs+RESERVE_MS});
    return this.run;
  }
  async finished(receipt:Receipt):Promise<'warm'|'detached'>{
    assert(this.job&&this.run);
    await this.run.resumeAfterTurn();
    const now=Date.now();const handle=this.run.run.handle();
    const state:WarmState={generation:randomUUID(),status:'ready',handle,lastActivityAt:now,idleAt:idleDeadline(now,handle.createdAt,this.idleMs)};
    await extendForIdle(this.run,state.idleAt);
    this.state={...state,status:'pending'};await this.store.save(this.job.agent,this.job.owner,this.state);
    try{await this.schedule({kind:'slack-idle-v1',agent:this.job.agent,generation:state.generation,dueAt:state.idleAt});}
    catch(error){
      receipt.event('idle-scheduling-failed');
      assert(await this.run.prepareIdle('schedule-failed-'+state.generation),'Idle scheduling failed and native gateway is busy.');
      await this.run.quiesce();await this.run.stop();await this.store.clear(this.job.agent,this.job.owner);this.state=undefined;
      receipt.event('warm-fallback-stopped');return 'detached';
    }
    this.state=state;await this.store.save(this.job.agent,this.job.owner,state);
    receipt.event('gateway-retained',{...handle,idleAt:state.idleAt,idleTimeoutMs:this.idleMs});return 'warm';
  }
  async failed(){
    if(this.job&&this.state){this.state={...this.state,status:'failed'};await this.store.save(this.job.agent,this.job.owner,this.state);}
  }
}

export async function stopIdle(settings:Settings,store:WarmStore,policy:SlackPolicy,event:IdleEvent,receipt:Receipt,schedule:IdleScheduler){
  const owner=randomUUID();const state=await store.claimIdle(event,owner);
  if(state==='stale'||state==='failed'){receipt.event('idle-skipped',{reason:state,agent:event.agent});return;}
  if(state==='early'||state==='busy')throw Error('Idle check remains pending.');
  try{
    assert(state.status==='ready'||state.status==='pending'||state.status==='stopping','Warm operation outcome is uncertain; preserve it.');
    // Persist the stop intent so a callback retry may finish detachment after gateway exit.
    await store.save(event.agent,owner,{...state,status:'stopping'});
    let run:SlackRun;
    try{run=await SlackRun.reconnect(settings,event.agent,receipt,policy,state.handle,{allowQuiesced:state.status==='stopping'});}
    catch(error){
      const {Sandbox,Drive}=await import('@vercel/sandbox');
      const box=await Sandbox.get({...settings.credentials,name:state.handle.name,resume:false});
      const {REGION,DRIVE_BYTES,agentDriveName}=await import('./config.js');
      const drive=await Drive.getOrCreate({...settings.credentials,name:agentDriveName(event.agent),region:REGION,maxSize:DRIVE_BYTES});
      if(box.status==='stopped'&&box.currentSession().sessionId===state.handle.sessionId&&drive.driveId===state.handle.driveId&&!drive.currentSessionId&&!drive.currentSandboxName){
        await store.clear(event.agent,owner);receipt.event('idle-already-stopped',{sessionId:state.handle.sessionId});return;
      }
      throw error;
    }
    if(run.run.stage==='quiesced'){await run.stop();await store.clear(event.agent,owner);receipt.event('idle-stop-recovered',{...state.handle});return;}
    if(!await run.prepareIdle('idle-'+state.generation)){
      const next={...state,status:state.status==='ready'?'ready' as const:'pending' as const,lastActivityAt:Date.now(),idleAt:idleDeadline(Date.now(),state.handle.createdAt)};
      await extendForIdle(run,next.idleAt);
      await store.save(event.agent,owner,next);await schedule({kind:'slack-idle-v1',agent:event.agent,generation:state.generation,dueAt:next.idleAt});return;
    }
    await run.quiesce();await run.stop();await store.clear(event.agent,owner);
    receipt.event('idle-stopped',{agent:event.agent,...state.handle});
  }finally{await store.release(event.agent,owner);}
}
