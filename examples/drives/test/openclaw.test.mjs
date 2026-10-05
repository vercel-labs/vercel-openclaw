import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuration, agentArgs, parseAgentReply, assertCleanShutdown, assertNativeMemory, bootstrapScript, inventoryScript } from '../dist/openclaw.js';
import { WORKSPACE, PREPARED_MARKER, PREPARED_CONTENT } from '../dist/config.js';
const envelope = () => ({runId:'run',status:'ok',result:{payloads:[{text:'final'}],meta:{agentMeta:{sessionId:'session',provider:'gateway',model:'openai/gpt-5.4',agentHarnessId:'openclaw'}}}});

test('native config limits tools and background work without disabling memory loading',()=>{
  const c=configuration('openai/gpt-5.4');
  assert.deepEqual(c.tools.allow,['read','write']);assert.deepEqual(c.tools.deny,['apply_patch']);
  assert.equal(c.tools.fs.workspaceOnly,true);assert.equal(c.cron.enabled,false);assert.equal(c.tools.toolSearch,false);
  assert.equal(c.agents.defaults.models['gateway/openai/gpt-5.4'].agentRuntime.id,'openclaw');
  assert(!JSON.stringify(c).includes('sandbox-brokered'));
  assert(!('plugins' in c));
  assert.equal(c.models.providers.gateway.api, 'openai-completions');
  assert.equal(c.models.providers.gateway.baseUrl, 'https://ai-gateway.vercel.sh/v1');
  assert.equal(c.models.providers.gateway.apiKey, '${OPENCLAW_DRIVES_MODEL_KEY}');
});
test('turn invocation uses an explicit Gateway session key and never local or delivery modes',()=>{
  const args=agentArgs('conversation','message');
  assert(args.includes('--session-key'));assert(args.includes('agent:main:drive-conversation'));
  assert(!args.includes('--local'));assert(!args.includes('--deliver'));
});
test('Gateway envelope verifies ownership, completion, model and errors',()=>{
  assert.equal(parseAgentReply(JSON.stringify(envelope()),'openai/gpt-5.4').text,'final');
  for(const mutate of [
    e=>delete e.runId,e=>e.status='in_flight',e=>e.result.meta.aborted=true,
    e=>e.result.meta.error={message:'error'},e=>e.result.payloads[0].isError=true,
    e=>e.result.meta.agentMeta.model='other',e=>e.result.meta.agentMeta.provider='other',
    e=>e.result.meta.agentMeta.agentHarnessId='codex',e=>delete e.result.meta.agentMeta.sessionId,
  ]){const e=envelope();mutate(e);assert.throws(()=>parseAgentReply(JSON.stringify(e),'openai/gpt-5.4'));}
  assert.throws(()=>parseAgentReply(JSON.stringify(envelope().result),'openai/gpt-5.4'));
});
test('reasoning and commentary never count as final output',()=>{
  const e=envelope();e.result.payloads=[{text:'thought',isReasoning:true},{text:'working',isCommentary:true},{text:'final'}];
  assert.equal(parseAgentReply(JSON.stringify(e),'openai/gpt-5.4').text,'final');
});
test('exit zero without clean-shutdown evidence is rejected',()=>{
  assertCleanShutdown(0,'shutdown completed cleanly in 42ms');
  assertCleanShutdown(0,'2026-09-29T00:36:16.129+00:00 [shutdown] completed cleanly in 199ms');
  for(const [exit,logs] of [[1,'shutdown completed cleanly in 42ms'],[0,''],
    [0,'shutdown deadline reached; abandoning unfinished cleanup'],
    [0,'[shutdown] completed cleanly in 42ms\n[shutdown] completed in 50ms with warnings: sqlite'],
    [0,'shutdown completed cleanly in 42ms\nshutdown completed in 50ms with warnings: sqlite']]) {
    assert.throws(()=>assertCleanShutdown(exit,logs));
  }
});
test('memory injection must come from the actual run, with positive verified content',()=>{
  const good={harness:'openclaw',toolSummary:{calls:0,tools:[]},promptReport:{source:'run',injectedWorkspaceFiles:[{path:`${WORKSPACE}/MEMORY.md`,missing:false,injectedChars:20}]}};
  assertNativeMemory(good);
  assert.throws(()=>assertNativeMemory({...good,toolSummary:{calls:1,tools:['read']}}), /zero tool calls/);
  assertNativeMemory({...good,toolSummary:null});
  assert.throws(()=>assertNativeMemory({...good,harness:null,toolSummary:null}), /native harness/);
  for(const report of [null,{...good.promptReport,source:'estimate'},
    {...good.promptReport,injectedWorkspaceFiles:[{path:`${WORKSPACE}/MEMORY.md`,missing:false,injectedChars:null,injectionStatus:'native_unverified'}]}]) {
    assert.throws(()=>assertNativeMemory({...good,promptReport:report}));
  }
});
test('bootstrap refuses unowned content without modifying it',()=>{
  const root=mkdtempSync(join(tmpdir(),'openclaw-bootstrap-'));
  writeFileSync(join(root,PREPARED_MARKER),PREPARED_CONTENT);
  const file=join(root,'user-file');writeFileSync(file,'keep this');
  assert.throws(()=>execFileSync(process.execPath,['-e',bootstrapScript,root,'{}','2026.9.6'],{stdio:'pipe'}),/Unrecognized nonempty Drive/);
  assert.equal(readFileSync(file,'utf8'),'keep this');
});

test('owned state is reused without rewriting config; a changed config fails closed',()=>{
  const root=mkdtempSync(join(tmpdir(),'openclaw-owned-'));
  writeFileSync(join(root,PREPARED_MARKER),PREPARED_CONTENT);
  const config=JSON.stringify(configuration('openai/gpt-5.4'));
  const file=join(root,'openclaw.json');writeFileSync(file,config);
  writeFileSync(join(root,'.vercel-drives-example.json'),JSON.stringify({format:1,version:'2026.9.6',configSha256:createHash('sha256').update(config).digest('hex')}));
  const before=statSync(file,{bigint:true}).mtimeNs;
  assert.match(execFileSync(process.execPath,['-e',bootstrapScript,root,config,'2026.9.6'],{encoding:'utf8'}),/existing-state-preserved/);
  assert.equal(statSync(file,{bigint:true}).mtimeNs,before);
  writeFileSync(file,'changed');
  assert.throws(()=>execFileSync(process.execPath,['-e',bootstrapScript,root,config,'2026.9.6'],{stdio:'pipe'}),/Saved configuration changed/);
  assert.equal(readFileSync(file,'utf8'),'changed');
});


test('state inventory records native skill link targets without following them',()=>{
  const root=mkdtempSync(join(tmpdir(),'openclaw-inventory-'));
  writeFileSync(join(root,'memory.txt'),'saved');
  symlinkSync('/app/nonexistent-image-skill',join(root,'skill'));
  const inventory=JSON.parse(execFileSync(process.execPath,['-e',inventoryScript,root],{encoding:'utf8'}));
  assert.deepEqual(inventory.skill,{symlink:'/app/nonexistent-image-skill'});
  assert.deepEqual(inventory['memory.txt'],{sha256:createHash('sha256').update('saved').digest('hex'),bytes:5});
  assert.deepEqual(Object.keys(inventory).sort(),['memory.txt','skill']);
});
