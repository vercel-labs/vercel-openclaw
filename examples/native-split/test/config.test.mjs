import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,gatewayConfig,nodeConfig,gatewayEnvironment,workerPolicy,PROFILE} from '../src/config.mjs';
test('gateway requires worker inference and carries metadata without provider auth',()=>{
  const config=gatewayConfig('model','node-id');
  assert.equal(config.cloudWorkers.requiredProfile,PROFILE);
  assert.equal(config.cloudWorkers.profiles[PROFILE].settings.inference,'worker');
  assert.equal(config.models.providers['vercel-ai-gateway'].apiKey,undefined);assert.equal(config.models.providers['vercel-ai-gateway'].baseUrl,undefined);
  const env=gatewayEnvironment('/state','native-token');assert.equal(env.AI_GATEWAY_API_KEY,undefined);assert.equal(env.VERCEL_OIDC_TOKEN,undefined);assert.equal(env.SPLIT_REDIS_TOKEN,undefined);
});
test('real model key stays in firewall and node runs no nested container',()=>{
  const node=nodeConfig('model');assert.equal(node.models.providers['vercel-ai-gateway'].apiKey,'${WORKER_PROXY_AUTH}');assert.equal(node.nodeHost.workerRuns.isolation,'none');assert.equal(node.nodeHost.workerRuns.capacity,1);
  const policy=workerPolicy(new URL('https://gateway.example'),'real-test-key');
  assert.equal(policy.allow['ai-gateway.vercel.sh'][0].transform[0].headers.Authorization,'Bearer real-test-key');
  assert.equal(policy.allow['ai-gateway.vercel.sh'][1].response.statusCode,403);assert(!JSON.stringify(node).includes('real-test-key'));
});

test('deployment authentication is injected by the firewall, never node configuration',()=>{
  const policy=workerPolicy(new URL('https://gateway.example'),'model-secret','project-oidc');
  assert.equal(policy.allow['gateway.example'][0].transform[0].headers['x-vercel-trusted-oidc-idp-token'],'project-oidc');
  assert(!JSON.stringify(nodeConfig('model')).includes('project-oidc'));
});

test('container request identity reaches SDK credentials without a process environment token',()=>{
  const env={VERCEL_URL:'gateway.example',VERCEL_PROJECT_ID:'project-test',SPLIT_REDIS_URL:'https://redis.example',SPLIT_REDIS_TOKEN:'redis-test',SPLIT_WORKER_IMAGE:'registry.example/image@sha256:'+'a'.repeat(64),SPLIT_AGENT_ID:'proof-test',SPLIT_CONTROL_TOKEN:'x'.repeat(32),SPLIT_STORAGE_MODE:'ephemeral-proof',AI_GATEWAY_API_KEY:'model-test'};
  const token=claims=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
  const claims={owner_id:'team-test',project_id:'project-test',exp:Math.floor(Date.now()/1000)+3600};
  const oidc=token(claims);const config=settings(env,{'x-vercel-oidc-token':oidc});
  assert.deepEqual(config.credentials,{token:oidc,teamId:'team-test',projectId:'project-test'});
  assert.equal(config.deploymentToken,oidc);assert.equal(env.VERCEL_OIDC_TOKEN,undefined);
  assert.throws(()=>settings(env),/runtime identity is missing/);
  assert.throws(()=>settings(env,{'x-vercel-oidc-token':token({...claims,project_id:'wrong-project'})}),/project mismatch/);
  assert.throws(()=>settings(env,{'x-vercel-oidc-token':token({...claims,exp:1})}),/expired/);
});
