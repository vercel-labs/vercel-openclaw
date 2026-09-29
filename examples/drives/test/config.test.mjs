import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromEnv, agentDriveName, sessionId, assertVersion, redact } from '../dist/config.js';
import { assertInventory, assertRecall } from '../dist/verify.js';

const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const env = overrides => ({ VERCEL_OIDC_TOKEN: token({ exp: 4000, owner_id: 'team_test', project_id: 'prj_test' }),
  AI_GATEWAY_API_KEY: 'test-key', ...overrides });

test('missing, malformed, expired and nearly expired credentials fail before cloud allocation', () => {
  assert.throws(() => settingsFromEnv({}, 0), /Missing VERCEL_OIDC_TOKEN/);
  assert.throws(() => settingsFromEnv(env({ VERCEL_OIDC_TOKEN: 'invalid' }), 0), /readable JWT/);
  assert.throws(() => settingsFromEnv(env({ VERCEL_OIDC_TOKEN: token({exp: 10}) }), 0), /less than 45/);
  assert.throws(() => settingsFromEnv(env({ VERCEL_OIDC_TOKEN: token({exp: 4000}) }), 0), /project scope/);
  assert.throws(() => settingsFromEnv(env({ AI_GATEWAY_API_KEY: '' }), 0), /Missing AI_GATEWAY/);
});
test('only the inspected release tag or official digest is accepted', () => {
  const config = settingsFromEnv(env(), 0);
  assert.equal(config.image, 'openclaw-foundation/openclaw/openclaw:2026.9.6');
  assert.throws(() => settingsFromEnv(env({OPENCLAW_IMAGE:'openclaw-foundation/openclaw/openclaw:latest'}),0), /moving tags/);
  assert.throws(() => settingsFromEnv(env({OPENCLAW_IMAGE:'other/image:2026.9.6'}),0), /official/);
});
test('agent and conversation identities are stable and reject path-like names', () => {
  assert.equal(agentDriveName('alice'), 'openclaw-alice');
  assert.throws(() => agentDriveName('../other'), /Agent name/);
  assert.equal(sessionId('main'), sessionId('main'));
  assert.notEqual(sessionId('main'), sessionId('other'));
  assert.throws(() => sessionId(''), /Conversation/);
});
test('image version verification rejects beta, wrong release and arbitrary successful output', () => {
  assertVersion('OpenClaw 2026.9.6 (eb377ac)\n');
  assertVersion('2026.9.6\n');
  for (const wrong of ['2026.9.6-beta.1','2026.9.5','gateway started']) assert.throws(() => assertVersion(wrong));
});
test('exact storage comparison rejects changed, missing and extra files', () => {
  const before = { 'workspace/MEMORY.md': { sha256: 'abc', bytes: 3 } };
  assertInventory(before, structuredClone(before));
  assert.throws(() => assertInventory({},{}), /empty/);
  assert.throws(() => assertInventory(before, {}), /exact saved/);
  assert.throws(() => assertInventory(before, { ...before, extra: {sha256:'def',bytes:3} }), /exact saved/);
  assert.throws(() => assertInventory(before, {'workspace/MEMORY.md': {sha256:'def',bytes:3}}), /exact saved/);
});
test('recall requires exact marker, not a fuzzy success claim', () => {
  assertRecall('marker\n','marker','recall');
  assert.throws(() => assertRecall('I remember it','marker','recall'));
});
test('redaction removes configured tokens and Authorization values', () => {
  assert.equal(redact('key-123 Bearer other-secret', ['key-123']), '[REDACTED] Bearer [REDACTED]');
});

test('exact state comparison includes changed, missing and added symbolic links',()=>{
  const before={skill:{symlink:'/app/shipped-skill'}};
  assertInventory(before,{skill:{symlink:'/app/shipped-skill'}});
  for(const after of [{},{skill:{symlink:'/app/other-skill'}},{...before,extra:{symlink:'/app/extra'}}]) {
    assert.throws(()=>assertInventory(before,after),/did not recover/);
  }
});
