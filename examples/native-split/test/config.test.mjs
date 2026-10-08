import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayConfig,nodeConfig,gatewayEnvironment,workerPolicy,PROFILE} from '../src/config.mjs';
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
