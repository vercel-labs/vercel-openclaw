import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedHandler } from '../dist/hosted.js';
import { settingsFromEnv } from '../dist/config.js';

const control='c'.repeat(32);
test('hosted credential budget accepts a valid reused Function token and rejects too-short lifetimes',()=>{
  const now=Date.now();
  const env=minutes=>({AI_GATEWAY_API_KEY:'synthetic',VERCEL_OIDC_TOKEN:`x.${Buffer.from(JSON.stringify({project_id:'prj_test',owner_id:'team_test',exp:Math.floor(now/1000)+minutes*60})).toString('base64url')}.x`});
  assert.doesNotThrow(()=>settingsFromEnv(env(30),now,15*60_000));
  assert.throws(()=>settingsFromEnv(env(10),now,15*60_000),/15 minutes/);
  assert.throws(()=>settingsFromEnv(env(30),now),/45 minutes/);
});
test('hosted auth rejects callers before reading platform credentials or constructing a controller',async()=>{
  let calls=0;
  const handle=hostedHandler({env:{OPENCLAW_CONTROL_TOKEN:control},token:()=>{calls++;throw Error('must not run')}});
  assert.equal((await handle(new Request('https://test/api/messages'))).status,401);assert.equal(calls,0);
});
test('hosted adapter reads fresh invocation credentials and preserves the full accepted message body',async()=>{
  const seen=[];let invocation=0;
  const handle=hostedHandler({env:{OPENCLAW_CONTROL_TOKEN:control,VERCEL_OIDC_TOKEN:'stale'},token:()=>`fresh-${++invocation}`,
    factory:async env=>async req=>{seen.push({token:env.VERCEL_OIDC_TOKEN,path:new URL(req.url).pathname,body:await req.text()});return Response.json({ok:true})}});
  const body=JSON.stringify({agent:'test',requestId:'one',message:'start\n'+('payload 🦞\n'.repeat(1000))+'end'});
  for(const route of ['messages','requests'])await handle(new Request(`https://test/api/${route}`,{method:'POST',headers:{authorization:`Bearer ${control}`},body}));
  assert.deepEqual(seen.map(s=>s.token),['fresh-1','fresh-2']);assert.deepEqual(seen.map(s=>s.path),['/messages','/requests']);
  assert(seen.every(s=>s.body===body));
});
test('hosted configuration and token failures return generic errors without leaking credentials',async()=>{
  const request=new Request('https://test/api/messages',{headers:{authorization:`Bearer ${control}`}});
  assert.equal((await hostedHandler({env:{}})(request)).status,503);
  const r=await hostedHandler({env:{OPENCLAW_CONTROL_TOKEN:control},token:()=>{throw Error('private-token')}})(request);
  assert.equal(r.status,503);assert(!(await r.text()).includes('private-token'));
});
