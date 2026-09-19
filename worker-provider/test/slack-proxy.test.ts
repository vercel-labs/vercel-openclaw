import assert from 'node:assert/strict';
import test from 'node:test';
import { startSlackProxy } from '../runtime/slack-proxy.mjs';

test('Slack relay removes SDK body/query credentials and leaves content intact for firewall auth', async () => {
  const calls: {url:string;init:RequestInit}[]=[];
  const proxy=await startSlackProxy({fetcher:async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});}});
  try {
    let response=await fetch(`${proxy.url}auth.test?token=placeholder`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Bearer placeholder'},body:'token=placeholder&team_id=T1'});
    assert.equal(response.status,200);
    assert.equal(calls[0].url,'https://slack.com/api/auth.test');
    assert.equal(calls[0].init.body,'team_id=T1');
    assert(!new Headers(calls[0].init.headers).has('authorization'));
    response=await fetch(`${proxy.url}chat.postMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'placeholder',channel:'C1',text:'token=project-note'})});
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(String(calls[1].init.body)),{channel:'C1',text:'token=project-note'});
    assert.equal((await fetch(`${proxy.url}../other`,{method:'POST'})).status,400);
    assert.equal((await fetch(`${proxy.url}auth.test`,{method:'PUT'})).status,400);
    assert.equal(calls.length,2);
  } finally {await proxy.close();}
});
