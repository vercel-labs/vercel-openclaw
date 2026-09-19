import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installationManifest, loadInstallation } from './codex-e2e/installation.mjs';
import { verifyLockedDependencyAges } from './e2e/dependency-policy.mjs';
import { hash } from './e2e/support.mjs';

async function fixture(nativeSlack = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-install-test-'));
  const bytes = Buffer.from('synthetic pinned archive');
  const archive = { bytes, sha256: hash(bytes), bundled: { '@openclaw/ai': '2026.9.2' } };
  const policy = { registry: 'https://registry.example.org/', minReleaseAgeDays: 2, exclusions: [] };
  const packages = Object.fromEntries([
    ['@openai/codex', '0.153.4'], ['@openai/codex-linux-x64', '0.153.4-linux-x64'], ['@vercel/sandbox', '3.2.1'],
    ...(nativeSlack ? [['@openclaw/slack', '2026.9.2']] : []),
  ].map(([name, version]) => [`node_modules/${name}`, { version, integrity: `sha512-${name}`, resolved: `${policy.registry}${name}/archive.tgz` }]));
  const evidence = await verifyLockedDependencyAges({ packages }, policy, async url => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const entry = packages[`node_modules/${name}`];
    return new Response(JSON.stringify({ name, versions: { [entry.version]: { dist: { integrity: entry.integrity } } }, time: { [entry.version]: '2026-01-01T00:00:00Z' } }));
  }, Date.parse('2026-09-09T00:00:00Z'));
  const lock = { lockfileVersion: 3, packages: {
    '': installationManifest(nativeSlack), ...packages,
    'node_modules/openclaw': { version: '2026.9.2', resolved: 'file:openclaw-poc.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
    'node_modules/openclaw/node_modules/@openclaw/ai': { version: '2026.9.2', inBundle: true },
  } };
  if (nativeSlack) {
    Object.assign(lock.packages['node_modules/@openclaw/slack'], { bundleDependencies: ['@slack/bolt'], dependencies: { '@slack/bolt': '5.0.0' } });
    lock.packages['node_modules/@openclaw/slack/node_modules/@slack/bolt'] = { version: '5.0.0', inBundle: true };
  }
  const receipt = { packageSha256: archive.sha256, lockSha256: hash(JSON.stringify(lock)), evidenceSha256: hash(JSON.stringify(evidence)), policy, checkedAt: evidence.checkedAt };
  for (const [name, value] of Object.entries({ 'package.json': installationManifest(nativeSlack), 'package-lock.json': lock, 'dependency-evidence.json': evidence, 'installation.json': receipt })) writeFileSync(join(directory, name), JSON.stringify(value));
  writeFileSync(join(directory, 'openclaw-poc.tgz'), bytes);
  return { directory, archive, policy, lock, receipt };
}

test('official Slack bundles are covered by the pinned parent artifact but undeclared bundles fail closed', async () => {
  const f = await fixture(true);
  try {
    await loadInstallation(f.directory, f.archive, f.policy);
    f.lock.packages['node_modules/@openclaw/slack/node_modules/not-declared'] = { version: '1.0.0', inBundle: true };
    writeFileSync(join(f.directory, 'package-lock.json'), JSON.stringify(f.lock));
    f.receipt.lockSha256 = hash(JSON.stringify(f.lock));
    writeFileSync(join(f.directory, 'installation.json'), JSON.stringify(f.receipt));
    await assert.rejects(loadInstallation(f.directory, f.archive, f.policy), /Undeclared/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('frozen installation accepts the archive-owned bundle and rejects changed preparation inputs', async () => {
  const f = await fixture();
  try {
    await loadInstallation(f.directory, f.archive, f.policy);
    const original = readFileSync(join(f.directory, 'openclaw-poc.tgz'));
    writeFileSync(join(f.directory, 'openclaw-poc.tgz'), 'substituted archive');
    await assert.rejects(async () => loadInstallation(f.directory, f.archive, f.policy), /archive/i);
    writeFileSync(join(f.directory, 'openclaw-poc.tgz'), original);
    f.lock.packages['node_modules/unapproved-bundle'] = { version: '1.0.0', inBundle: true };
    writeFileSync(join(f.directory, 'package-lock.json'), JSON.stringify(f.lock));
    f.receipt.lockSha256 = hash(JSON.stringify(f.lock));
    writeFileSync(join(f.directory, 'installation.json'), JSON.stringify(f.receipt));
    await assert.rejects(async () => loadInstallation(f.directory, f.archive, f.policy), /bundl/i);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('frozen installation replays age evidence instead of trusting a matching evidence hash', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.directory, 'dependency-evidence.json'), JSON.stringify({ checkedAt: f.receipt.checkedAt, checks: [], sources: [] }));
    f.receipt.evidenceSha256 = hash(readFileSync(join(f.directory, 'dependency-evidence.json')));
    writeFileSync(join(f.directory, 'installation.json'), JSON.stringify(f.receipt));
    await assert.rejects(async () => loadInstallation(f.directory, f.archive, f.policy), /evidence|metadata/i);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
