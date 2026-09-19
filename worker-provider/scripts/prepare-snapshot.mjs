import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { assertNpmPolicySupport, npmPolicyArgs } from '../assets/bootstrap.mjs';
import { registryNetworkRules } from '../dist/profile.js';
import { loadInstallation } from '../test/codex-e2e/installation.mjs';
import { registryAuthorization } from '../test/e2e/npm-auth.mjs';
import { assertRetainedSnapshot, hash, ROOT, Receipt, settings, redact } from '../test/e2e/support.mjs';

const image = 'openclaw-foundation/openclaw/openclaw@sha256:30134c3d1427a06e86060257ae1a7a31e71dd5925459d84dd746d1da25a84a6d';
const base = '/tmp/openclaw-codex-e2e';
let box, receipt;
const secrets = [process.env.VERCEL_OIDC_TOKEN, process.env.VERCEL_TOKEN];
try {
  const config = settings(process.env);
  const bytes = readFileSync(process.env.OPENCLAW_CODEX_PACKAGE);
  assert.equal(hash(bytes), process.env.OPENCLAW_CODEX_PACKAGE_SHA256);
  const read = path => JSON.parse(execFileSync('tar', ['-xOf', process.env.OPENCLAW_CODEX_PACKAGE, `package/${path}`], { encoding: 'utf8' }));
  const pkg = read('package.json');
  assert.equal(pkg.version, '2026.9.2');
  assert.equal(read('dist/build-info.json').commit, '3928bad9badfcb6c7d140530435e806fb8092190');
  const archive = { bytes, sha256: hash(bytes), bundled: Object.fromEntries(pkg.bundleDependencies.map(name => [name, read(`node_modules/${name}/package.json`).version])) };
  const npm = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], { cwd: ROOT, encoding: 'utf8' }));
  assertNpmPolicySupport(npm);
  const authorization = registryAuthorization(existsSync(npm.userconfig) ? readFileSync(npm.userconfig, 'utf8') : '', npm.registry, process.env);
  secrets.push(authorization);
  const policy = { registry: npm.registry, minReleaseAgeDays: Math.max(2, npm['min-release-age'] ?? 2), exclusions: [] };
  const installation = await loadInstallation(process.env.OPENCLAW_CODEX_INSTALL_DIR, archive, policy);
  assert.equal(JSON.parse(installation.manifest).dependencies['@openclaw/slack'], '2026.9.2');
  receipt = new Receipt(config.results, secrets, ['pinned-image', 'runtime-verified', 'snapshot', 'cleanup']);
  const name = `ocw-runtime-build-${receipt.data.runId}`, tags = { owner: 'openclaw-runtime-build' };
  receipt.intent(name, tags);
  box = await Sandbox.create({ ...config.credentials, name, tags, image, persistent: false, timeout: 900_000,
    networkPolicy: { allow: { [new URL(policy.registry).hostname]: registryNetworkRules(policy.registry, authorization ? { registry: policy.registry, authorization } : undefined), '*': [] } } });
  assert.equal(box.image, image);
  receipt.check('pinned-image', { image });
  for (const [path, content] of Object.entries({ 'package.json': installation.manifest, 'package-lock.json': installation.lock, 'openclaw-poc.tgz': bytes,
    'image/finalize.mjs': readFileSync(join(ROOT, 'image/finalize.mjs')), 'image/bootstrap.mjs': readFileSync(join(ROOT, 'assets/bootstrap.mjs')) })) await box.writeFiles([{ path: `${base}/${path}`, content }]);
  const npmSupport = await box.runCommand({ cmd: 'npm', args: ['config', 'list', '--json'], timeoutMs: 15000 });
  assert.equal(npmSupport.exitCode, 0); assertNpmPolicySupport(JSON.parse(await npmSupport.stdout()));
  const installed = await box.runCommand({ cmd: 'npm', args: ['ci', '--include=optional', '--no-audit', '--no-fund', ...npmPolicyArgs(policy)], cwd: base, timeoutMs: 600_000, signal: AbortSignal.timeout(620_000) });
  receipt.log('installation', JSON.stringify({ exitCode: installed.exitCode, stdout: await installed.stdout(), stderr: await installed.stderr() }));
  assert.equal(installed.exitCode, 0, 'Pinned runtime installation failed');
  await box.update({ networkPolicy: 'deny-all' });
  const verified = await box.runCommand({ cmd: 'node', args: ['image/finalize.mjs'], cwd: base, timeoutMs: 120_000 });
  receipt.log('runtime', JSON.stringify({ exitCode: verified.exitCode, stdout: await verified.stdout(), stderr: await verified.stderr() }));
  assert.equal(verified.exitCode, 0, 'Offline runtime verification failed');
  const runtime = JSON.parse((await verified.stdout()).split('\n').find(line => line.startsWith('{')));
  assert.equal(runtime.status, 'IMAGE_RUNTIME_VERIFIED');
  receipt.check('runtime-verified', runtime);
  // Every future worker boots from this pinned ID, even after a long idle period.
  const sourceSessionId = box.currentSession().sessionId;
  const { snapshotId } = await box.snapshot({ expiration: 0 });
  assertRetainedSnapshot(await Snapshot.get({ ...config.credentials, snapshotId }), sourceSessionId);
  Object.assign(receipt.data, { snapshotId, packageSha256: archive.sha256, installation: installation.receipt });
  receipt.check('snapshot', { snapshotId });
  await box.stop();
  assert.equal((await Sandbox.get({ ...config.credentials, name, resume: false })).status, 'stopped');
  receipt.data.resources[0].cleanup = 'stopped'; receipt.check('cleanup'); receipt.finish();
  console.log('OPENCLAW_RUNTIME_SNAPSHOT_PREPARED');
} catch (error) {
  if (box) await box.stop().catch(() => {});
  try { receipt?.finish(error); } catch {}
  console.error(redact(error.stack ?? error, secrets)); process.exitCode = 1;
}
