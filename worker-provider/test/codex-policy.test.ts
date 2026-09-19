import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, codexGatewayConfig, codexToolExclusions, exactLaunchApproval, fetchNativeCatalog } from './codex-e2e/policy.mjs';
import { readFileSync } from 'node:fs';

test('Codex VM paths do not assume the image has the legacy Sandbox directory', () => {
  assert.equal(BASE, '/tmp/openclaw-codex-e2e');
  for (const file of ['task.mjs', 'runtime-proof.mjs']) {
    const source = readFileSync(new URL(`./codex-e2e/${file}`, import.meta.url), 'utf8');
    assert(source.includes(`${BASE}/gateway-only-canary`));
    assert(source.includes(`${BASE}/state/openclaw.json`));
  }
  const source = readFileSync(new URL('./codex-e2e/run.mjs', import.meta.url), 'utf8');
  assert(source.includes("['mkdir', '-p', BASE], { cwd: '/tmp' }"));
});

test('native catalog bootstrap preserves complete upstream bytes and checks the reviewer', async () => {
  const bytes = JSON.stringify({ models: [
    { slug: 'vendor/test-model', auto_review_model_override: 'vendor/reviewer', instructions: 'preserve', capabilities: { synthetic: true } },
    { slug: 'vendor/reviewer', hidden: true },
  ] }, null, 2) + '\n';
  const catalog = await fetchNativeCatalog('fixture-key', 'vendor/test-model', async (url, init) => {
    assert.equal(url, 'https://ai-gateway.vercel.sh/codex/v1/models');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fixture-key');
    return new Response(bytes);
  });
  assert.equal(catalog.bytes.toString(), bytes);
  assert(catalog.path.endsWith(`${catalog.sha256}.json`));
  await assert.rejects(fetchNativeCatalog('fixture-key', 'vendor/test-model', async () => new Response(JSON.stringify({ models: [
    { slug: 'vendor/test-model', auto_review_model_override: 'vendor/missing' },
  ] }))), /Reviewer/);
  await assert.rejects(fetchNativeCatalog('fixture-key', 'vendor/unknown', async () => new Response(bytes)), /absent/);
});

const expected = { sessionKey: 'agent:main:synthetic', sessionId: 'session', runId: 'run', environmentId: 'environment', nodeId: 'node', cwd: '/worker/project', ownerEpoch: 2, placementGeneration: 3 };
function pending() {
  return [{ id: 'approval', approvalKind: 'plugin', expiresAtMs: Date.now() + 10_000, request: {
    pluginId: 'codex', severity: 'critical', sessionKey: expected.sessionKey, runId: expected.runId, allowedDecisions: ['allow-once', 'allow-always'],
    placementGrant: { ...expected, pluginId: 'codex', agentId: 'main', command: 'codex.exec-server.stdio.v1', approvalScope: 'codex.exec-server', pairingGeneration: 'pairing' },
  } }];
}
test('test approval is one-shot and bound to the exact active placement and run', () => {
  assert.deepEqual(exactLaunchApproval(pending(), expected), { id: 'approval', decision: 'allow-once' });
  assert.equal(exactLaunchApproval(pending(), { ...expected, runId: 'different' }), undefined);
  for (const key of ['sessionId', 'environmentId', 'nodeId', 'cwd', 'ownerEpoch', 'placementGeneration']) {
    assert.throws(() => exactLaunchApproval(pending(), { ...expected, [key]: 'different' }));
  }
  const arbitrary = pending();
  arbitrary[0].request.placementGrant.command = 'system.run';
  assert.throws(() => exactLaunchApproval(arbitrary, expected), /command/);
  assert.throws(() => exactLaunchApproval([...pending(), ...pending()], expected), /Ambiguous/);
});

test('Codex test configuration retains native execution and the mandatory Vercel route', () => {
  const cfg = codexGatewayConfig({ origin: 'https://gateway.example', projectId: 'prj_fixture', teamId: 'team_fixture', model: 'vendor/test-model', catalogPath: '/catalog/fixture.json', npmRegistry: 'https://registry.npmjs.org', excludedTools: ['custom_tool', 'gateway', 'gateway'] });
  assert.equal(cfg.tools.exec.mode, 'auto');
  assert(!('allow' in cfg.tools));
  assert.equal(cfg.agents.defaults.model.primary, 'vercel-ai-gateway/vendor/test-model');
  assert.deepEqual(cfg.gateway.nodes.commands.allow, ['codex.exec-server.stdio.v1']);
  assert.equal(cfg.plugins.entries.codex.config.sessionCatalog.enabled, false);
  assert.deepEqual(cfg.plugins.entries.codex.config.codexDynamicToolsExclude, ['custom_tool', 'exec', 'gateway', 'openclaw', 'process']);
  for (const names of [[], ['session_status', 'custom_tool', 'gateway', 'gateway']]) {
    const excluded = codexToolExclusions(names);
    assert(['exec', 'process', 'gateway', 'openclaw'].every(name => excluded.includes(name)));
    assert(!excluded.includes('session_status'));
    assert.equal(excluded.length, new Set(excluded).size);
    assert(names.filter(name => name !== 'session_status').every(name => excluded.includes(name)));
  }
  assert(!JSON.stringify(cfg).includes('fixture-key'));
});
