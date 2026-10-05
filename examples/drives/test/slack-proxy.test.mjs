import assert from 'node:assert/strict';
import test from 'node:test';
import {slackProxySource,slackGatewaySource} from '../dist/slack-proxy.js';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const {startSlackProxy}=await import('data:text/javascript;base64,'+Buffer.from(slackProxySource).toString('base64'));

test('Slack proxy removes explicit SDK credentials and preserves payload and rate limits',async()=>{
 const calls=[];
 const proxy=await startSlackProxy({fetcher:async(url,init)=>{calls.push({url,init});return new Response('{"ok":true}',{status:429,headers:{'content-type':'application/json','retry-after':'7'}})}});
 try{
  const form=await fetch(proxy.url+'auth.test?token=placeholder&team_id=T1',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Bearer placeholder'},body:'token=placeholder&token=other&team_id=T1'});
  assert.equal(form.status,429);assert.equal(form.headers.get('retry-after'),'7');
  assert.equal(calls[0].url,'https://slack.com/api/auth.test?team_id=T1');assert.equal(calls[0].init.body,'team_id=T1');
  assert(!new Headers(calls[0].init.headers).has('authorization'));
  const payload={token:'placeholder',channel:'C1',text:'literal token=project-note 🌲',blocks:[{text:{text:'leave nested token text intact'}}]};
  await fetch(proxy.url+'chat.postMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const {token,...expected}=payload;assert.deepEqual(JSON.parse(calls[1].init.body),expected);
  assert.equal((await fetch(proxy.url+'../other',{method:'POST'})).status,400);
  assert.equal((await fetch(proxy.url+'auth.test',{method:'PUT'})).status,400);
  assert.equal((await fetch(proxy.url+'auth.test',{method:'POST',headers:{'content-type':'text/plain'},body:'token=x'})).status,400);
  assert.equal(calls.length,2);
 }finally{await proxy.close()}
});

test('gateway launcher forwards shutdown and keeps proxy alive through final gateway calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'slack-gateway-'));
 let child;
 try{
  await writeFile(join(dir,'slack-proxy.mjs'),slackProxySource.replace('fetcher = fetch',"fetcher = async () => new Response('{\"ok\":true}')"));
  const entry=join(dir,'fake-gateway.mjs');
  await writeFile(entry,`import {writeFileSync} from 'node:fs';
   const call=async()=>{const r=await fetch(process.env.SLACK_API_URL+'auth.test',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=placeholder'});if(!r.ok)throw Error('proxy unavailable');};
   process.on('SIGTERM',async()=>{await call();writeFileSync(${JSON.stringify(join(dir,'shutdown.txt'))},'proxy available during shutdown');process.exit(0)});
   await call();console.log('gateway-ready');setInterval(()=>{},1000);`);
  await writeFile(join(dir,'gateway.mjs'),slackGatewaySource.replace("'/app/openclaw.mjs'",JSON.stringify(entry)).replace("cwd:'/app'",'cwd:'+JSON.stringify(dir)));
  child=spawn(process.execPath,[join(dir,'gateway.mjs')],{stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');let output='';let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('launcher readiness timeout: '+errors)),5000);
   child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('gateway-ready')){clearTimeout(timer);resolve()}});
   child.once('exit',code=>{if(!output.includes('gateway-ready')){clearTimeout(timer);reject(Error('early exit '+code+': '+errors))}});
  });
  child.kill('SIGTERM');const [code]=await closed;assert.equal(code,0,errors);
  assert.equal(await readFile(join(dir,'shutdown.txt'),'utf8'),'proxy available during shutdown');
  const {url}=JSON.parse(await readFile(join(dir,'slack-proxy-url.json'),'utf8'));
  await assert.rejects(fetch(url+'auth.test'));
 }finally{if(child?.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true})}
});
