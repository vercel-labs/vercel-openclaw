import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { assertNpmPolicySupport, npmPolicyArgs, requiredCodexPackages, resolveCodexNativeExecutable, seedWorkerConfig, takeCredentials, verifyDownload, verifyPrebuiltRuntime, verifyWorkerConfig } from '../assets/bootstrap.mjs';

const workerConfig = () => ({ plugins: { entries: { codex: { enabled: true } } }, meta: { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: '2026.9.2' } });

test('inline bootstrap executes the same entrypoint and redacts rejected enrollment input', () => {
  const source = readFileSync(new URL('../assets/bootstrap.mjs', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `${source}\nawait runBootstrapCli();`], {
    env: { ...process.env, OC_WORKER_BOOTSTRAP: '{"token":"synthetic-secret"}', OC_WORKER_ENROLLMENT: '{}' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Worker bootstrap failed at descriptor; credentials redacted.\n');
});

test('prepared worker configuration is exact, credential-free and limited to the verified bundled plugin', () => {
  const descriptor = { enabledPluginIds: ['codex'], openclawVersion: '2026.9.2' };
  assert.deepEqual(verifyWorkerConfig(descriptor, workerConfig()), workerConfig());
  for (const config of [{ ...workerConfig(), gateway: { auth: { token: 'secret' } } }, { ...workerConfig(), deviceId: 'reused' }, { plugins: { entries: { codex: { enabled: false } } } }]) {
    assert.throws(() => verifyWorkerConfig(descriptor, config), /configuration/);
  }
  assert.throws(() => verifyWorkerConfig({ ...descriptor, enabledPluginIds: ['another'] }, workerConfig()));
  assert.throws(() => verifyWorkerConfig({ ...descriptor, openclawVersion: 'other' }, workerConfig()));
});

test('prepared configuration only seeds fresh enrollment and never replaces existing worker state', () => {
  const state = mkdtempSync(join(tmpdir(), 'ocw-config-'));
  const path = join(state, 'openclaw.json');
  assert.equal(seedWorkerConfig(state, 'connect', workerConfig()), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), workerConfig());
  writeFileSync(path, '{"preserve":true}');
  assert.equal(seedWorkerConfig(state, 'connect', workerConfig()), false);
  assert.equal(readFileSync(path, 'utf8'), '{"preserve":true}');
  assert.equal(seedWorkerConfig(mkdtempSync(join(tmpdir(), 'ocw-config-')), 'resume', workerConfig()), false);
});

test('prebuilt runtime binds enrollment to exact baked artifact and running build', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ocw-image-'));
  const archive = Buffer.from('synthetic native node artifact');
  const descriptor = { sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length, openclawVersion: '2026.9.2', enabledPluginIds: ['codex'] };
  mkdirSync(join(runtime, 'node_modules/openclaw/dist'), { recursive: true });
  writeFileSync(join(runtime, 'node_modules/openclaw/node-runtime.tgz'), archive);
  writeFileSync(join(runtime, 'worker-image.json'), JSON.stringify({ ...descriptor, buildId: 'build-test' }));
  const buildPath = join(runtime, 'node_modules/openclaw/dist/build-info.json');
  writeFileSync(buildPath, JSON.stringify({ buildId: 'build-test', version: descriptor.openclawVersion }));
  assert.doesNotThrow(() => verifyPrebuiltRuntime(descriptor, runtime));
  for (const patch of [{ sha256: '0'.repeat(64) }, { bytes: 1 }, { openclawVersion: 'other' }, { enabledPluginIds: ['unknown'] }]) {
    assert.throws(() => verifyPrebuiltRuntime({ ...descriptor, ...patch }, runtime), /image/i);
  }
  writeFileSync(join(runtime, 'node_modules/openclaw/node-runtime.tgz'), 'changed archive');
  assert.throws(() => verifyPrebuiltRuntime(descriptor, runtime), /image/i);
  writeFileSync(join(runtime, 'node_modules/openclaw/node-runtime.tgz'), archive);
  writeFileSync(buildPath, JSON.stringify({ buildId: 'different-build', version: descriptor.openclawVersion }));
  assert.throws(() => verifyPrebuiltRuntime(descriptor, runtime), /image/i);
});

test('native verification resolves from the shipped bundled plugin, not an absent separately installed plugin', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ocw-bundled-codex-'));
  const write = (path: string, content: unknown) => {
    const target = join(runtime, 'node_modules', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(content));
    return target;
  };
  write('openclaw/dist/extensions/codex/package.json', { name: '@openclaw/codex', dependencies: { '@openai/codex': '0.153.4' } });
  write('@openai/codex/package.json', { name: '@openai/codex', version: '0.153.4' });
  write('@openai/codex-linux-x64/package.json', { name: '@openai/codex', version: '0.153.4-linux-x64' });
  assert.throws(() => resolveCodexNativeExecutable(runtime), /missing/);
  const binary = write('@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex', 'synthetic executable');
  assert.equal(resolveCodexNativeExecutable(runtime), realpathSync(binary));
  write('@openai/codex-linux-x64/package.json', { version: 'unverified' });
  assert.throws(() => resolveCodexNativeExecutable(runtime), /pin differs/);
});

test('Codex workers require the exact Linux native dependency instead of accepting an omitted optional binary', () => {
  assert.deepEqual(requiredCodexPackages({ enabledPluginIds: [], openclawVersion: '2026.9.2' }), []);
  assert.deepEqual(requiredCodexPackages({ enabledPluginIds: ['codex'], openclawVersion: '2026.9.2' }), [
    '@openai/codex@0.153.4', '@openai/codex-linux-x64@npm:@openai/codex@0.153.4-linux-x64',
  ]);
  assert.throws(() => requiredCodexPackages({ enabledPluginIds: ['codex'], openclawVersion: 'unverified' }));
});

test('bootstrap rejects npm versions that silently ignore age policy options', () => {
  assert.throws(() => assertNpmPolicySupport({}), /support/);
  assert.throws(() => assertNpmPolicySupport({ 'min-release-age': null }), /support/);
  assertNpmPolicySupport({ 'min-release-age': null, 'min-release-age-exclude': [] });
});

test('bootstrap carries the explicit registry and dependency age policy without wildcard exemptions', () => {
  const policy = { registry: 'https://registry.example.org/npm/', minReleaseAgeDays: 2, exclusions: ['openclaw'] };
  assert.deepEqual(npmPolicyArgs(policy), ['--registry=https://registry.example.org/npm/', '--min-release-age=2', '--min-release-age-exclude=openclaw']);
  for (const patch of [{ minReleaseAgeDays: 0 }, { exclusions: ['*'] }, { registry: 'https://secret@registry.example.org/' }]) assert.throws(() => npmPolicyArgs({ ...policy, ...patch }));
});

test('bootstrap removes both temporary credentials before creating any child environment', () => {
  const env = { PATH: '/usr/bin', OC_WORKER_BOOTSTRAP: '{"token":"download-secret"}', OC_WORKER_ENROLLMENT: '{"setupCode":"join-secret"}' };
  const extracted = takeCredentials(env);
  assert.equal(extracted.bootstrap.token, 'download-secret');
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

for (const scenario of ['valid', 'wrong hash', 'oversize', 'truncated', 'redirect']) {
  test(`artifact verification: ${scenario}`, async () => {
    const bytes = Buffer.from('trusted archive');
    const path = join(mkdtempSync(join(tmpdir(), 'ocw-artifact-')), 'artifact');
    const artifact = { url: 'https://gateway.example.org/archive', token: 'download-secret', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (scenario === 'wrong hash') artifact.sha256 = '0'.repeat(64);
    if (scenario === 'oversize') artifact.bytes--;
    if (scenario === 'truncated') artifact.bytes++;
    const fetcher: typeof fetch = async (url, options = {}) => {
      assert.equal(url, artifact.url);
      assert.equal(options.redirect, 'error');
      assert.equal((options.headers as Record<string, string>).authorization, 'Bearer download-secret');
      return new Response(bytes, { status: scenario === 'redirect' ? 302 : 200 });
    };
    const result = verifyDownload(artifact, path, fetcher);
    if (scenario === 'valid') { await result; assert.deepEqual(readFileSync(path), bytes); }
    else await assert.rejects(result, /download|integrity/);
  });
}
