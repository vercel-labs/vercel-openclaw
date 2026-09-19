import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { npmPolicyArgs } from '../../assets/bootstrap.mjs';
import { verifyLockedDependencyAges } from '../e2e/dependency-policy.mjs';
import { hash } from '../e2e/support.mjs';

export const installationManifest = (nativeSlack = false) => ({ private: true, type: 'module', allowScripts: { 'file:./openclaw-poc.tgz': true }, dependencies: { openclaw: 'file:./openclaw-poc.tgz', '@vercel/sandbox': '3.2.1', ...(nativeSlack ? { '@openclaw/slack': '2026.9.2', '@types/express': '5.0.6' } : {}) } });

function registryLock(lock, archive) {
  assert.equal(lock.lockfileVersion, 3);
  const local = lock.packages?.['node_modules/openclaw'];
  assert.equal(local?.version, '2026.9.2');
  assert.equal(local.resolved, 'file:openclaw-poc.tgz');
  assert.equal(local.integrity, `sha512-${createHash('sha512').update(archive.bytes).digest('base64')}`);
  assert.equal(lock.packages['node_modules/@openai/codex']?.version, '0.153.4');
  assert.equal(lock.packages['node_modules/@openai/codex-linux-x64']?.version, '0.153.4-linux-x64');
  assert.equal(lock.packages['node_modules/@vercel/sandbox']?.version, '3.2.1');
  const registry = structuredClone(lock);
  delete registry.packages['node_modules/openclaw'];
  const bundled = Object.fromEntries(Object.entries(archive.bundled).map(([name, version]) => [`node_modules/openclaw/node_modules/${name}`, version]));
  for (const [path, version] of Object.entries(bundled)) {
    const entry = registry.packages[path];
    assert(entry?.inBundle === true && entry.version === version && !entry.resolved && !entry.integrity && !entry.link, 'Bundled dependency differs from the pinned archive');
    delete registry.packages[path];
  }
  const slackRoot = 'node_modules/@openclaw/slack';
  const slack = registry.packages[slackRoot];
  if (slack) {
    assert.equal(slack.version, '2026.9.2');
    assert(slack.integrity && !slack.inBundle && !slack.link, 'Slack must be a verified registry artifact');
    for (const [path, entry] of Object.entries(registry.packages)) {
      if (!entry.inBundle || !path.startsWith(`${slackRoot}/node_modules/`)) continue;
      const relative = path.slice(`${slackRoot}/node_modules/`.length);
      const rootDependency = relative.split('/node_modules/')[0];
      assert(slack.bundleDependencies?.includes(rootDependency) && !entry.link && !entry.resolved && !entry.integrity, 'Undeclared Slack bundle dependency');
      if (relative === rootDependency) assert.equal(entry.version, slack.dependencies[rootDependency]);
      // npm verifies these bytes as part of the parent tarball's published integrity and release age.
      delete registry.packages[path];
    }
  }
  assert(!Object.values(registry.packages).some(entry => entry.inBundle), 'Unapproved bundled dependency');
  return registry;
}

export async function prepareInstallation(directory, archive, policy, fetcher, nativeSlack = false) {
  assert(isAbsolute(directory ?? ''), 'Explicit absolute OPENCLAW_CODEX_INSTALL_DIR required');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'openclaw-poc.tgz'), archive.bytes, { mode: 0o600 });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(installationManifest(nativeSlack)), { mode: 0o600 });
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=0', '--fetch-timeout=15000', ...npmPolicyArgs(policy)], { cwd: directory, timeout: 180_000, killSignal: 'SIGKILL', stdio: 'pipe' });
  const lock = readFileSync(join(directory, 'package-lock.json'));
  const evidence = await verifyLockedDependencyAges(registryLock(JSON.parse(lock), archive), policy, fetcher);
  writeFileSync(join(directory, 'dependency-evidence.json'), JSON.stringify(evidence), { mode: 0o600 });
  writeFileSync(join(directory, 'installation.json'), JSON.stringify({ packageSha256: archive.sha256, lockSha256: hash(lock), evidenceSha256: hash(JSON.stringify(evidence)), policy, checkedAt: evidence.checkedAt }), { mode: 0o600 });
  return loadInstallation(directory, archive, policy);
}

export async function loadInstallation(directory, archive, policy) {
  assert(isAbsolute(directory ?? ''), 'Run prepare-install and set OPENCLAW_CODEX_INSTALL_DIR');
  assert.equal(hash(readFileSync(join(directory, 'openclaw-poc.tgz'))), archive.sha256, 'Prepared archive differs');
  const manifest = readFileSync(join(directory, 'package.json'));
  const lock = readFileSync(join(directory, 'package-lock.json'));
  const receipt = JSON.parse(readFileSync(join(directory, 'installation.json')));
  const nativeSlack = JSON.parse(manifest).dependencies?.['@openclaw/slack'] === '2026.9.2';
  assert.deepEqual(JSON.parse(manifest), installationManifest(nativeSlack));
  if (nativeSlack) assert.equal(JSON.parse(lock).packages['node_modules/@openclaw/slack']?.version, '2026.9.2');
  assert.equal(receipt.packageSha256, archive.sha256);
  assert.equal(receipt.lockSha256, hash(lock));
  assert.equal(receipt.evidenceSha256, hash(readFileSync(join(directory, 'dependency-evidence.json'))));
  assert.deepEqual(receipt.policy, policy);
  const evidence = JSON.parse(readFileSync(join(directory, 'dependency-evidence.json')));
  assert.equal(receipt.checkedAt, evidence.checkedAt);
  const checkedAt = Date.parse(evidence.checkedAt);
  assert(Number.isFinite(checkedAt) && checkedAt <= Date.now(), 'Invalid dependency evidence time');
  const replay = await verifyLockedDependencyAges(registryLock(JSON.parse(lock), archive), policy, async url => {
    const source = evidence.sources.find(source => source.url === String(url));
    assert(source && hash(source.raw) === source.sha256, 'Missing or changed dependency metadata evidence');
    return new Response(source.raw);
  }, checkedAt);
  assert.deepEqual(replay, evidence, 'Dependency evidence differs');
  return { manifest, lock, receipt };
}
