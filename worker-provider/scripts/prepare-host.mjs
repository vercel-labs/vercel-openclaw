import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { assertNpmPolicySupport, npmPolicyArgs } from '../assets/bootstrap.mjs';
import { registryNetworkRules } from '../dist/profile.js';
import { loadInstallation } from '../test/codex-e2e/installation.mjs';
import { BASE, fetchNativeCatalog } from '../test/codex-e2e/policy.mjs';
import { registryAuthorization } from '../test/e2e/npm-auth.mjs';
import { assertRetainedSnapshot, hash, ROOT, Receipt, settings, redact } from '../test/e2e/support.mjs';

const secrets = [process.env.AI_GATEWAY_API_KEY, process.env.VERCEL_OIDC_TOKEN];
let box, receipt;
try {
  const config = settings(process.env, 'model');
  const bytes = readFileSync(process.env.OPENCLAW_CODEX_PACKAGE);
  assert.equal(hash(bytes), process.env.OPENCLAW_CODEX_PACKAGE_SHA256);
  const read = path => execFileSync('tar', ['-xOf', process.env.OPENCLAW_CODEX_PACKAGE, `package/${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const packageJson = JSON.parse(read('package.json'));
  const build = JSON.parse(read('dist/build-info.json'));
  assert.equal(build.commit, '3928bad9badfcb6c7d140530435e806fb8092190');
  assert.equal(packageJson.version, '2026.9.2');
  const archive = { bytes, sha256: hash(bytes), bundled: Object.fromEntries(packageJson.bundleDependencies.map(name => [name, JSON.parse(read(`node_modules/${name}/package.json`)).version])) };
  const npmConfig = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], { cwd: ROOT, encoding: 'utf8' }));
  assertNpmPolicySupport(npmConfig);
  const authorization = registryAuthorization(existsSync(npmConfig.userconfig) ? readFileSync(npmConfig.userconfig, 'utf8') : '', npmConfig.registry, process.env);
  secrets.push(authorization);
  const policy = { registry: npmConfig.registry, minReleaseAgeDays: Math.max(2, npmConfig['min-release-age'] ?? 2), exclusions: [] };
  const installation = await loadInstallation(process.env.OPENCLAW_CODEX_INSTALL_DIR, archive, policy);
  const workerSnapshot = process.env.OPENCLAW_CODEX_SNAPSHOT;
  if (workerSnapshot) {
    assert(/^snap_[A-Za-z0-9]+$/.test(workerSnapshot));
    const snapshot = await Snapshot.get({ ...config.credentials, snapshotId: workerSnapshot });
    assert(snapshot.status === 'created' && snapshot.expiresAt === undefined, 'Prepare a non-expiring worker snapshot before creating VM1');
  }
  const nativeSlack = process.env.OPENCLAW_NATIVE_SLACK_CONFIG ? JSON.parse(process.env.OPENCLAW_NATIVE_SLACK_CONFIG) : undefined;
  const sessionTimeoutMs = Number(process.env.OPENCLAW_CODEX_SESSION_TIMEOUT_MS ?? 45 * 60_000);
  assert(Number.isSafeInteger(sessionTimeoutMs) && sessionTimeoutMs >= 45 * 60_000 && sessionTimeoutMs <= 24 * 60 * 60_000, 'Session timeout must fit the selected plan: 45 minutes on Hobby, up to 24 hours on Pro');
  if (nativeSlack) assert(workerSnapshot && nativeSlack.channels?.length && nativeSlack.users?.length && nativeSlack.teamId, 'Native Slack requires prebuilt runtime and explicit test scope');
  const catalog = await fetchNativeCatalog(config.modelKey, config.model);
  const payload = { 'openclaw-poc.tgz': archive.bytes, 'package.json': installation.manifest, 'package-lock.json': installation.lock, [catalog.path.slice(BASE.length + 1)]: catalog.bytes };
  for (const dir of ['runtime', 'test/e2e', 'test/codex-e2e']) for (const name of readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.mjs'))) payload[`${dir}/${name}`] = readFileSync(join(ROOT, dir, name));
  for (const path of ['package.json', 'package-lock.json', 'openclaw.plugin.json', 'assets/bootstrap.mjs', ...['index', 'provider', 'profile', 'journal', 'host-admission'].map(name => `dist/${name}.js`)]) payload[`provider/${path}`] = readFileSync(join(ROOT, path));
  const descriptor = { config: { projectId: config.projectId, teamId: config.teamId, model: config.model, catalogPath: catalog.path, npmRegistry: policy.registry, npmAge: policy.minReleaseAgeDays, sessionTimeoutMs, ...(workerSnapshot ? { workerSnapshot } : {}), ...(nativeSlack ? { nativeSlack } : {}) }, files: Object.fromEntries(Object.entries(payload).map(([path, content]) => [path, hash(content)])) };
  let manifest = Buffer.from(JSON.stringify(descriptor));
  let runtimeDigest = hash(manifest);
  payload['runtime-manifest.json'] = manifest;
  receipt = new Receipt(config.results, secrets, ['installed', 'stopped']);
  const name = `ocw-connect-${receipt.data.runId}`;
  const tags = { owner: 'openclaw-connect-codex-v1', runtime: runtimeDigest };
  receipt.intent(name, tags);
  box = await Sandbox.create({ ...config.credentials, name, tags, persistent: true, snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0, deleteEvicted: true }, ...(workerSnapshot ? { source: { type: 'snapshot', snapshotId: workerSnapshot } } : { image: 'vercel/sandbox/node:26' }), timeout: sessionTimeoutMs, ports: [3000], networkPolicy: workerSnapshot ? 'deny-all' : { allow: { [new URL(policy.registry).hostname]: registryNetworkRules(policy.registry, authorization ? { registry: policy.registry, authorization } : undefined), '*': [] } } });
  for (const [path, content] of Object.entries(payload)) await box.writeFiles([{ path: `${BASE}/${path}`, content }]);
  process.stdout.write(workerSnapshot ? 'STEP verify prebuilt runtime without network access\n' : 'STEP install pinned OpenClaw/Codex runtime\n');
  const installed = await box.runCommand(workerSnapshot
    ? { cmd: 'node', args: ['--input-type=module', '-e', 'import{readFileSync}from"node:fs";import{verifyPrebuiltRuntime}from"./image/bootstrap.mjs";verifyPrebuiltRuntime(JSON.parse(readFileSync("worker-image.json")),process.cwd());console.log("NO_RUNTIME_INSTALL_VERIFIED")'], cwd: BASE, timeoutMs: 15000 }
    : { cmd: 'npm', args: ['ci', '--ignore-scripts=false', '--include=optional', '--no-audit', '--no-fund', ...npmPolicyArgs(policy)], cwd: BASE, timeoutMs: 480_000, signal: AbortSignal.timeout(500_000) });
  receipt.log('install', JSON.stringify({ exitCode: installed.exitCode, stdout: await installed.stdout(), stderr: await installed.stderr() }));
  assert.equal(installed.exitCode, 0, 'Pinned runtime install failed');
  receipt.check('installed');
  await box.update({ networkPolicy: 'deny-all' });
  if (nativeSlack) {
    await box.update({ networkPolicy: { allow: { [new URL(policy.registry).hostname]: registryNetworkRules(policy.registry, authorization ? { registry: policy.registry, authorization } : undefined), '*': [] } } });
    try {
      const installedSlack = await box.runCommand({ cmd: 'node', args: ['runtime/install-slack.mjs'], cwd: BASE, timeoutMs: 260_000, signal: AbortSignal.timeout(270_000) });
      receipt.log('slack-install', JSON.stringify({ exitCode: installedSlack.exitCode, stdout: await installedSlack.stdout(), stderr: await installedSlack.stderr() }));
      assert.equal(installedSlack.exitCode, 0, 'Official native Slack registration failed');
    } finally { await box.update({ networkPolicy: 'deny-all' }); }
  }
  if (workerSnapshot) {
    const gatewayToken = randomBytes(32).toString('hex'); secrets.push(gatewayToken);
    const prepared = await box.runCommand({ cmd: 'node', args: ['runtime/turn.mjs', '--prepare'], cwd: BASE, timeoutMs: 90000, signal: AbortSignal.timeout(100000), env: { OPENCLAW_GATEWAY_TOKEN: gatewayToken, VERCEL_OIDC_TOKEN: config.token, OPENCLAW_HOST_INPUT: JSON.stringify({ runtimeDigest, origin: box.domain(3000) }) } });
    receipt.log('catalog-prepare', JSON.stringify({ exitCode: prepared.exitCode, stdout: await prepared.stdout(), stderr: await prepared.stderr() }));
    assert.equal(prepared.exitCode, 0, 'Guardrail catalog preparation failed');
    const line = (await prepared.stdout()).split('\n').find(line => line.startsWith('OPENCLAW_HOST_PREPARED='));
    descriptor.config.excludedTools = JSON.parse(line.slice('OPENCLAW_HOST_PREPARED='.length)).excludedTools;
    manifest = Buffer.from(JSON.stringify(descriptor)); runtimeDigest = hash(manifest);
    await box.writeFiles([{ path: `${BASE}/runtime-manifest.json`, content: manifest }]);
    await box.update({ tags: { ...tags, runtime: runtimeDigest } });
  }
  const sourceSessionId = box.currentSession().sessionId;
  await box.stop();
  const stopped = await Sandbox.get({ ...config.credentials, name, resume: false });
  assert.equal(stopped.status, 'stopped');
  assert(stopped.currentSnapshotId, 'VM1 snapshot is missing');
  assertRetainedSnapshot(await Snapshot.get({ ...config.credentials, snapshotId: stopped.currentSnapshotId }), sourceSessionId);
  receipt.data.resources[0].cleanup = 'stopped';
  receipt.check('stopped');
  Object.assign(receipt.data, { name, runtimeDigest, installation: installation.receipt, packageSha256: archive.sha256, workerSnapshot, nativeSlack: Boolean(nativeSlack) });
  receipt.finish();
  process.stdout.write('CODEX_HOST_PREPARED (stopped persistent VM1; no model turn or Slack message)\n');
} catch (error) {
  if (box) await box.stop().catch(() => {});
  process.stderr.write(redact(error.stack ?? error, secrets) + '\n');
  try { receipt?.finish(error); } catch { /* Failed evidence remains on disk. */ }
  process.exitCode = 1;
}
