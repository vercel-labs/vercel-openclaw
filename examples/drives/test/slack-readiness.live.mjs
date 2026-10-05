import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {getToken} from '@vercel/connect';
import {settingsFromEnv} from '../dist/config.js';
import {initializeDrive} from '../dist/initialize.js';
import {Receipt} from '../dist/receipt.js';
import {verifySlackIdentity} from '../dist/slack-auth.js';
import {SlackRun} from '../dist/slack-native.js';

assert(process.argv.length===3,'Usage: node test/slack-readiness.live.mjs <ignored-env-file>');
const env={...process.env,...parseEnv(readFileSync(process.argv[2],'utf8'))};
const settings=settingsFromEnv(env);
const policy=JSON.parse(env.OPENCLAW_SLACK_POLICY);
const token=await getToken(env.SLACK_CONNECTOR,{subject:{type:'app'},scopes:['channels:read','channels:history','users:read','chat:write']},{vercelToken:settings.credentials.token});
await verifySlackIdentity(token,policy);
const receipt=new Receipt('results/slack-readiness',[settings.credentials.token,settings.gatewayKey,token]);
const agent='slack-readiness-'+randomBytes(5).toString('hex');
try{
 receipt.event('start',{agent,policy});await initializeDrive(settings,agent,receipt);
 const sessions=[];let image,driveId;
 for(let cycle=0;cycle<2;cycle++){
  const started=Date.now();
  const run=await SlackRun.attach(settings,agent,receipt,policy,token,{image});
  if(cycle===0){image=run.sandbox.image;driveId=run.run.drive.driveId;}
  else {
   assert.equal(run.run.drive.driveId,driveId);
   assert.notEqual(run.sandbox.currentSession().sessionId,sessions[0].sessionId);
  }
  await run.start();const readyMs=Date.now()-started;
  const status=await run.rpc('channels.status',{probe:false});assert(status.channelAccounts.slack.some(a=>a.accountId==='default'&&a.connected));
  const drain=await run.rpc('gateway.suspend.prepare',{requestId:'readiness-'+cycle,drain:true,terminalPolicy:'preserve'});assert.equal(drain.status,'ready');
  await run.quiesce();await run.stop();
  sessions.push({sessionId:run.sandbox.currentSession().sessionId,readyMs,totalMs:Date.now()-started});
  receipt.event('readiness-cycle',{cycle,driveId,...sessions.at(-1)});
 }
 const events=readFileSync(receipt.directory+'/events.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(events.filter(e=>e.kind==='slack-plugin-install').length,1,'Second VM must reuse the installed plugin.');
 assert.equal(events.filter(e=>e.kind==='slack-broker-auth'&&e.ok).length,2,'Both VMs must pass explicit body-token authorization.');
 receipt.finish('passed',{agent,sessions,driveId,bodyTokenAuthChecks:2,pluginInstallations:1,slackEventsSubmitted:0,scope:'Two fresh VMs, cached official plugin, native readiness with body-token authentication, drain handshake and clean shutdown only'});console.log(JSON.stringify({status:'passed',receipt:receipt.directory}));
}catch(error){receipt.finish('failed',{agent,error:error.message,resourcesPreserved:true});console.error(JSON.stringify({status:'failed',receipt:receipt.directory,error:error.message}));process.exitCode=1;}
