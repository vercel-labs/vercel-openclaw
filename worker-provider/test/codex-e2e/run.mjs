import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { Sandbox } from '@vercel/sandbox';
import { assertNpmPolicySupport, npmPolicyArgs } from '../../assets/bootstrap.mjs';
import { parseProfile } from '../../dist/profile.js';
import { authenticatedRegistryFetch, registryAuthorization } from '../e2e/npm-auth.mjs';
import { loadInstallation, prepareInstallation } from './installation.mjs';
import { hash, OWNER, Receipt, redact, ROOT, settings, stopOwned, VM_TIMEOUT } from '../e2e/support.mjs';
import { BASE, codexGatewayConfig, fetchNativeCatalog, REQUIRED, SMOKE_REQUIRED } from './policy.mjs';
import { assertCodexReceipt } from './receipt.mjs';

const command = process.argv[2];
assert(['offline', 'prepare-install', 'preflight', 'live', 'smoke', 'verify-receipt', 'verify-smoke'].includes(command), 'Use offline, prepare-install, preflight, live, smoke, verify-receipt, or verify-smoke');
const suite = ['smoke', 'verify-smoke'].includes(command) ? 'basic' : 'full';
const env = { ...process.env };
const secrets = [env.AI_GATEWAY_API_KEY, env.VERCEL_OIDC_TOKEN];
try {
if (env.OPENCLAW_E2E_OIDC_FILE) {
  const scoped = parseEnv(readFileSync(env.OPENCLAW_E2E_OIDC_FILE, 'utf8'));
  assert(scoped.VERCEL_OIDC_TOKEN, 'Selected project file has no OIDC token');
  env.VERCEL_OIDC_TOKEN = scoped.VERCEL_OIDC_TOKEN;
  secrets.push(scoped.VERCEL_OIDC_TOKEN);
}
} catch { throw new Error('Could not load the selected project credential file'); }

function testArtifacts() {
  const files = [
    'package.json', 'package-lock.json', 'openclaw.plugin.json',
    ...['index', 'provider', 'profile', 'journal'].map(name => `dist/${name}.js`),
    'assets/bootstrap.mjs',
    ...['e2e', 'codex-e2e'].flatMap(dir => readdirSync(join(ROOT, 'test', dir)).filter(name => name.endsWith('.mjs')).map(name => `test/${dir}/${name}`)),
  ];
  assert(existsSync(join(ROOT, 'test/codex-e2e/vm-run.mjs')), 'Missing VM test driver');
  return Object.fromEntries(files.map(name => [name, hash(readFileSync(join(ROOT, name)))]));
}

function packageArtifact() {
  const archive = env.OPENCLAW_CODEX_PACKAGE;
  assert(archive && isAbsolute(archive), 'Explicit absolute custom OpenClaw package required');
  const bytes = readFileSync(archive);
  const sha256 = hash(bytes);
  assert.equal(sha256, env.OPENCLAW_CODEX_PACKAGE_SHA256, 'Custom package digest differs');
  const read = path => execFileSync('tar', ['-xOf', archive, `package/${path}`], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const manifest = JSON.parse(read('package.json'));
  const build = JSON.parse(read('dist/build-info.json'));
  assert.equal(manifest.name, 'openclaw');
  assert.equal(manifest.version, '2026.9.2');
  assert.equal(build.commit, '3928bad9badfcb6c7d140530435e806fb8092190');
  assert.equal(manifest.dependencies['@openai/codex'], '0.153.4');
  for (const id of ['codex', 'vercel-ai-gateway']) assert.equal(JSON.parse(read(`dist/extensions/${id}/openclaw.plugin.json`)).id, id);
  assert(read('dist/extensions/vercel-ai-gateway/provider-policy-api.js').includes('codex'), 'Package omits the provider policy entry');
  assert(Array.isArray(manifest.bundleDependencies));
  const bundled = Object.fromEntries(manifest.bundleDependencies.map(name => {
    assert(/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name));
    const entry = JSON.parse(read(`node_modules/${name}/package.json`));
    assert.equal(entry.name, name);
    assert.equal(entry.version, manifest.dependencies[name]);
    return [name, entry.version];
  }));
  return { bytes, sha256, build, bundled };
}

async function main() {
  const artifacts = testArtifacts();
  const archive = packageArtifact();
  if (command === 'offline') {
    process.stdout.write('CODEX_ARTIFACTS_PASS (package and test files only; no credentials, VMs or model calls)\n');
    return;
  }
  if (command === 'verify-receipt' || command === 'verify-smoke') {
    const receipt = JSON.parse(readFileSync(join(env.OPENCLAW_E2E_RESULTS_DIR, 'receipt.json'), 'utf8'));
    const installation = await loadInstallation(env.OPENCLAW_CODEX_INSTALL_DIR, archive, receipt.installation.policy);
    assertCodexReceipt(receipt, { suite, artifacts, archive, installation, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID, model: env.OPENCLAW_E2E_MODEL,
      innerBytes: readFileSync(join(env.OPENCLAW_E2E_RESULTS_DIR, 'vm-receipt.log')),
      traceBytes: readFileSync(join(env.OPENCLAW_E2E_RESULTS_DIR, 'operator-trace.log')),
      lockBytes: installation.lock });
    process.stdout.write(`${suite === 'basic' ? 'CODEX_SMOKE_RECEIPT_PASS' : 'CODEX_RECEIPT_PASS'} (recorded evidence; no live recheck)\n`);
    return;
  }
  const npmConfig = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }));
  assertNpmPolicySupport(npmConfig);
  const registry = npmConfig.registry;
  const npmAuthorization = registryAuthorization(existsSync(npmConfig.userconfig) ? readFileSync(npmConfig.userconfig, 'utf8') : '', registry, env);
  secrets.push(npmAuthorization);
  const npmPolicy = { registry, minReleaseAgeDays: Math.max(2, Number(env.OPENCLAW_E2E_NPM_MIN_AGE ?? 2), npmConfig['min-release-age'] ?? 2), exclusions: [] };
  const npmArgs = npmPolicyArgs(npmPolicy);
  if (command === 'prepare-install') {
    await prepareInstallation(env.OPENCLAW_CODEX_INSTALL_DIR, archive, npmPolicy, authenticatedRegistryFetch(registry, npmAuthorization), env.OPENCLAW_CODEX_NATIVE_SLACK === '1');
    process.stdout.write('CODEX_INSTALL_LOCK_PASS (metadata only; no VMs or model calls)\n');
    return;
  }
  const installation = await loadInstallation(env.OPENCLAW_CODEX_INSTALL_DIR, archive, npmPolicy);
  const config = settings(env, 'model');
  assert(!env.VERCEL_TOKEN, 'Use the existing project-scoped OIDC credential');
  const catalog = await fetchNativeCatalog(config.modelKey, config.model);
  const inventory = await Sandbox.list({ ...config.credentials, tags: { owner: OWNER }, limit: 1, signal: AbortSignal.timeout(30_000) });
  for await (const _ of inventory) break;
  if (command === 'preflight') {
    process.stdout.write('CODEX_SETUP_PREFLIGHT_PASS (package, credentials, catalog only; tool authority is not proven)\n');
    return;
  }
  if (suite === 'full') assert.equal(env.OPENCLAW_E2E_TOOL_PROOF, 'concrete-isolation', 'Tool-proof acceptance is unresolved; no VMs or model turns started');
  const receipt = new Receipt(config.results, [config.token, config.modelKey, npmAuthorization], suite === 'basic' ? SMOKE_REQUIRED : REQUIRED);
  Object.assign(receipt.data, { suite, mode: suite === 'basic' ? 'codex-smoke' : 'codex', model: config.model, toolProof: suite === 'basic' ? 'basic-functional' : env.OPENCLAW_E2E_TOOL_PROOF, artifacts, packageSha256: archive.sha256, build: archive.build, projectId: config.projectId, teamId: config.teamId, catalogSha256: catalog.sha256 });
  if (suite === 'basic') receipt.data.notTested.push('exhaustive native-tool inventory', 'full security probes', 'cancellation', 'worker loss and replacement');
  receipt.data.installation = installation.receipt;
  const name = `ocw-codex-${receipt.data.runId}`;
  const tags = { owner: OWNER, run: receipt.data.runId };
  receipt.intent(name, tags);
  let box;
  let profile;
  let failure;
  let driverStarted = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(VM_TIMEOUT)]);
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const write = (path, content) => box.writeFiles([{ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content) }], { signal });
  const run = async (label, args, options = {}) => {
    process.stdout.write(`STEP ${label}\n`);
    const result = await box.runCommand({ cmd: args[0], args: args.slice(1), cwd: BASE, signal, timeoutMs: 30_000, ...options });
    receipt.log(label, JSON.stringify({ exitCode: result.exitCode, stdout: await result.stdout(), stderr: await result.stderr() }));
    assert.equal(result.exitCode, 0, `${label} failed; see redacted log`);
    return result;
  };
  try {
    const { registryNetworkRules } = await import('../../dist/profile.js');
    box = await Sandbox.create({ ...config.credentials, name, tags, persistent: false, image: 'vercel/sandbox/node:26', timeout: VM_TIMEOUT, ports: [3000], signal,
      networkPolicy: { allow: { [new URL(registry).hostname]: registryNetworkRules(registry, npmAuthorization ? { registry, authorization: npmAuthorization } : undefined), '*': [] } } });
    const origin = box.domain(3000);
    const cfg = codexGatewayConfig({ ...config, origin, catalogPath: catalog.path, npmRegistry: registry, npmAge: npmPolicy.minReleaseAgeDays });
    profile = parseProfile(cfg.cloudWorkers.profiles.vercel.settings);
    const { profileIntent } = await import('../../dist/profile.js');
    receipt.data.workerIntent = profileIntent(profile);
    receipt.save();
    await run('setup-directories', ['mkdir', '-p', BASE], { cwd: '/tmp' });
    await write(`${BASE}/openclaw-poc.tgz`, archive.bytes);
    await run('archive-integrity', ['node', '-e', 'const fs=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")!==process.argv[2])process.exit(1)', `${BASE}/openclaw-poc.tgz`, archive.sha256]);
    await write(`${BASE}/package.json`, installation.manifest);
    await write(`${BASE}/package-lock.json`, installation.lock);
    await run('install-package', ['npm', 'ci', '--ignore-scripts=false', '--include=optional', '--no-audit', '--no-fund', ...npmArgs], { timeoutMs: 600_000 });
    for (const file of Object.keys(artifacts)) {
      const target = file.startsWith('test/') ? `${BASE}/${file}` : `${BASE}/provider/${file}`;
      await write(target, readFileSync(join(ROOT, file)));
    }
    await write(catalog.path, catalog.bytes);
    await run('catalog-read-only', ['chmod', '0444', catalog.path]);
    await write(`${BASE}/input.json`, JSON.stringify({ suite, cfg, origin, toolProof: receipt.data.toolProof, runId: receipt.data.runId, catalogSha256: catalog.sha256, packageSha256: archive.sha256, projectId: config.projectId, teamId: config.teamId }));
    driverStarted = true;
    process.stdout.write('STEP OpenClaw VM driver\n');
    const result = await box.runCommand({ cmd: 'node', args: [`${BASE}/test/codex-e2e/vm-run.mjs`], cwd: BASE, signal, timeoutMs: 1_500_000,
      env: { HOME: `${BASE}/home`, OPENCLAW_STATE_DIR: `${BASE}/state`, OPENCLAW_CONFIG_PATH: `${BASE}/state/openclaw.json`, AI_GATEWAY_API_KEY: config.modelKey, VERCEL_OIDC_TOKEN: config.token, ...(npmAuthorization ? { OPENCLAW_NPM_AUTHORIZATION: npmAuthorization, OPENCLAW_NPM_AUTH_REGISTRY: registry } : {}) } });
    receipt.log('vm-test', JSON.stringify({ exitCode: result.exitCode, stdout: await result.stdout(), stderr: await result.stderr() }));
    const bytes = await box.readFileToBuffer({ path: `${BASE}/vm-results/receipt.json` }, { signal });
    assert(bytes, 'VM driver omitted its receipt');
    const inner = JSON.parse(bytes.toString());
    receipt.log('vm-receipt', bytes.toString());
    for (const name of ['gateway', 'chat-history']) {
      const log = await box.readFileToBuffer({ path: `${BASE}/vm-results/${name}.log` }, { signal });
      if (log) receipt.log(name, log.toString());
    }
    receipt.data.vmReceiptSha256 = hash(readFileSync(join(config.results, 'vm-receipt.log')));
    const trace = await box.readFileToBuffer({ path: `${BASE}/vm-results/operator-trace.log` }, { signal });
    assert(trace, 'VM driver omitted its operator trace');
    receipt.log('operator-trace', trace.toString());
    receipt.data.operatorTraceSha256 = hash(readFileSync(join(config.results, 'operator-trace.log')));
    assert.equal(inner.parentRunId, receipt.data.runId);
    for (const resource of inner.resources) { receipt.intent(resource.name, resource.tags); }
    assert.equal(result.exitCode, 0, 'VM driver failed; see redacted receipt');
    assert.equal(inner.status, 'passed');
    for (const item of inner.assertions.filter(item => item.name !== 'cleanup')) receipt.check(item.name, item);
  } catch (error) {
    failure = error;
  } finally {
    if (driverStarted) {
      try {
        const recovered = await box.runCommand({ cmd: 'node', args: ['--input-type=module', '-e', `import {freezeAndRecover} from './test/codex-e2e/recovery.mjs';process.stdout.write(JSON.stringify(await freezeAndRecover(process.argv[1])))`, receipt.data.workerIntent], cwd: BASE, signal: AbortSignal.timeout(15_000), timeoutMs: 10_000 });
        assert.equal(recovered.exitCode, 0, 'Independent allocation recovery failed');
        const { OWNER: workerOwner } = await import('../../dist/profile.js');
        for (const row of JSON.parse(await recovered.stdout())) receipt.intent(row.name, { owner: workerOwner, intent: row.intent });
        receipt.data.journalRecovered = true;
      } catch (error) { failure ??= error; receipt.data.journalRecovered = false; }
    }
    try { await stopOwned(Sandbox, config.credentials, receipt.data.resources[0]); }
    catch (error) { failure ??= error; }
    try {
      if (profile) {
        const { OWNER: workerOwner, profileIntent } = await import('../../dist/profile.js');
        const intent = profileIntent(profile);
        for await (const worker of await Sandbox.list({ ...config.credentials, tags: { intent }, signal: AbortSignal.timeout(30_000) })) {
          assert.equal(worker.tags?.owner, workerOwner);
          receipt.intent(worker.name, { owner: workerOwner, intent });
        }
      }
      assert(receipt.data.resources.length <= 3, 'Allocation budget exceeded');
    } catch (error) { failure ??= error; }
    for (const record of receipt.data.resources.slice(1).reverse()) {
      try { await stopOwned(Sandbox, config.credentials, record); }
      catch (error) { failure ??= error; }
      receipt.save();
    }
    if ((!driverStarted || receipt.data.journalRecovered) && receipt.data.resources.every(record => record.cleanup === 'stopped')) receipt.check('cleanup');
    if (!failure) {
      try {
        assertCodexReceipt({ ...receipt.data, status: 'passed', missingAssertions: [] }, { suite, artifacts, archive, installation, projectId: config.projectId, teamId: config.teamId, model: config.model,
          innerBytes: readFileSync(join(config.results, 'vm-receipt.log')), traceBytes: readFileSync(join(config.results, 'operator-trace.log')), lockBytes: installation.lock });
      } catch (error) { failure = error; }
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    receipt.finish(failure);
  }
  process.stdout.write(`${suite === 'basic' ? 'CODEX_SMOKE_PASS' : 'CODEX_E2E_PASS'}\n`);
}

try { await main(); }
catch (error) {
  process.stderr.write(redact(error.stack ?? error, secrets) + '\n');
  process.exitCode = 1;
}
