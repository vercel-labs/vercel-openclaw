import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseEnv } from 'node:util';
import { assertNpmPolicySupport, npmPolicyArgs } from '../../assets/bootstrap.mjs';
import { gatewayConfig } from './gateway-config.mjs';
import { verifyLockedDependencyAges } from './dependency-policy.mjs';
import { registryAuthorization, authenticatedRegistryFetch } from './npm-auth.mjs';
import { assertWorkerDenial } from './worker-probe.mjs';
import { assertCancellationAck, assertNativeReceipt, builtArtifacts, hash, observablePolicy, OWNER, Receipt, redact, ROOT, rpcResult, settings, stopOwned, testOperatorPairing, until, VM_TIMEOUT } from './support.mjs';

const command = process.argv[2];
assert(['preflight', 'fixture', 'model'].includes(command), 'Use preflight, fixture, or model');
const env = { ...process.env };
if (env.OPENCLAW_E2E_OIDC_FILE) {
  const scoped = parseEnv(readFileSync(env.OPENCLAW_E2E_OIDC_FILE, 'utf8'));
  assert(scoped.VERCEL_OIDC_TOKEN, 'The selected file has no OIDC credential');
  env.VERCEL_OIDC_TOKEN = scoped.VERCEL_OIDC_TOKEN;
}
let config;
let receipt;
let npmAuthorization;
try {
  config = settings(env, command === 'model' ? 'model' : 'fixture');
  assert(!env.VERCEL_TOKEN, 'This test requires project-scoped OIDC; unset VERCEL_TOKEN');
  const artifacts = builtArtifacts();
  const npmConfig = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }));
  assertNpmPolicySupport(npmConfig);
  const npmRegistry = npmConfig.registry;
  npmAuthorization = registryAuthorization(existsSync(npmConfig.userconfig) ? readFileSync(npmConfig.userconfig, 'utf8') : '', npmRegistry, env);
  const policy = { registry: npmRegistry, minReleaseAgeDays: Math.max(config.npmAge, npmConfig['min-release-age'] ?? 2), exclusions: config.npmExceptions };
  const npmArgs = npmPolicyArgs(policy);
  const dependencyEvidence = await verifyLockedDependencyAges(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')), policy, authenticatedRegistryFetch(npmRegistry, npmAuthorization));
  const { Sandbox } = await import('@vercel/sandbox');
  const { parseProfile, profileIntent, networkPolicy, registryNetworkRules, OWNER: WORKER_OWNER } = await import('../../dist/profile.js');
  const inventory = await Sandbox.list({ ...config.credentials, tags: { owner: OWNER }, limit: 1, signal: AbortSignal.timeout(30_000) });
  for await (const _ of inventory) break;
  if (config.mode === 'model') {
    assert(env.OPENCLAW_E2E_NATIVE_RECEIPT, 'Point OPENCLAW_E2E_NATIVE_RECEIPT to the passing deterministic receipt');
    assertNativeReceipt(JSON.parse(readFileSync(env.OPENCLAW_E2E_NATIVE_RECEIPT, 'utf8')), config, artifacts);
    const models = await fetch('https://ai-gateway.vercel.sh/v1/models', { headers: { authorization: `Bearer ${config.modelKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(models.status, 200, 'Model inventory authentication failed');
    assert((await models.json()).data.some(model => model.id === config.model), 'Selected model is not in the live inventory');
  }
  if (command === 'preflight') {
    process.stdout.write('NATIVE_E2E_PREFLIGHT_PASS (no resources allocated)\n');
  } else {
    const operatorToken = randomBytes(32).toString('hex');
    const fixtureToken = randomBytes(32).toString('hex');
    receipt = new Receipt(config.results, [config.token, config.modelKey, operatorToken, fixtureToken, npmAuthorization], config.mode === 'model'
      ? ['public-auth', 'native-enrollment', 'worker-execution', 'workspace-reconciliation', 'guardrails', 'admitted-worker-rpc', 'native-reclaim', 'cleanup'] : undefined);
    Object.assign(receipt.data, { mode: config.mode, projectId: config.projectId, teamId: config.teamId, artifacts, npmPolicy: policy });
    receipt.log('dependency-age-checks', JSON.stringify(dependencyEvidence));
    receipt.save();
    const lifetime = new AbortController();
    const onSignal = () => lifetime.abort(new Error('Test interrupted'));
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(VM_TIMEOUT)]);
    const gatewayName = `ocw-e2e-${receipt.data.runId}`;
    const gatewayTags = { owner: OWNER, run: receipt.data.runId };
    const base = '/vercel/sandbox/e2e';
    const state = `${base}/state`;
    const cli = `${base}/node_modules/openclaw/openclaw.mjs`;
    let gateway;
    let gatewayProcess;
    let services;
    let profile;
    let key;
    let sessionId;
    let worktree;
    let failure;
    const write = (box, path, content) => box.writeFiles([{ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content) }], { signal });
    const run = async (box, label, args, options = {}) => {
      const result = await box.runCommand({ cmd: args[0], args: args.slice(1), signal, timeoutMs: 30_000, ...options });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      receipt.log(`${Date.now()}-${label}`, JSON.stringify({ exitCode: result.exitCode, stdout, stderr }));
      assert.equal(result.exitCode, 0, `${label} failed; see redacted command log`);
      return stdout;
    };
    const file = (box, path) => run(box, 'read-file', ['node', '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path]);
    const exists = async (box, path) => (await run(box, 'file-exists', ['node', '-e', 'process.stdout.write(String(require("node:fs").existsSync(process.argv[1])))', path])).trim() === 'true';
    const gatewayEnv = { HOME: `${base}/home`, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`, OPENCLAW_GATEWAY_TOKEN: operatorToken,
      E2E_MODEL_TOKEN: fixtureToken, OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_GMAIL_WATCHER: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1', OPENCLAW_SKIP_CANVAS_HOST: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' };
    const rpc = async (method, params = {}, { token = operatorToken, publicUrl = false, timeout = 30_000, rejected = false, pairing = false, scopes } = {}) => {
      const result = await gateway.runCommand({ cmd: 'node', args: [`${base}/rpc.mjs`], cwd: base, env: { ...gatewayEnv, E2E_OPERATOR_TOKEN: token,
        E2E_RPC_REQUEST: JSON.stringify({ method, params, timeout, scopes, ...(publicUrl ? { url: gateway.domain(3000).replace('https:', 'wss:') } : {}) }) }, signal, timeoutMs: timeout + 15_000 });
      const output = await result.stdout();
      receipt.log(`${Date.now()}-rpc-${method}`, output + '\n' + await result.stderr());
      const parsed = rpcResult(output);
      if (pairing) {
        assert.equal(parsed.ok, false);
        assert.equal(parsed.code, 'NOT_PAIRED');
        return parsed;
      }
      if (rejected) {
        assert.equal(parsed.ok, false, 'Unauthenticated public RPC unexpectedly succeeded');
        assert.match(parsed.message, /unauthorized|token.*mismatch|token.*missing|auth.*required/i, 'Expected auth rejection, not a network failure');
      } else {
        assert.equal(parsed.ok, true, `${method} failed: ${redact(parsed.message, receipt.secrets)}`);
        assert.equal(result.exitCode, 0);
      }
      return parsed.result;
    };
    const discoverWorkers = async () => {
      if (!profile) return;
      const intent = profileIntent(profile);
      const workers = await Sandbox.list({ ...config.credentials, tags: { intent }, signal: AbortSignal.timeout(30_000) });
      for await (const box of workers) {
        assert.equal(box.tags?.owner, WORKER_OWNER, 'Worker ownership tag mismatch');
        receipt.intent(box.name, { owner: WORKER_OWNER, intent });
      }
      assert(receipt.data.resources.length <= (config.mode === 'model' ? 2 : 3), 'Unexpected extra worker allocation');
    };
    const dispatch = async () => {
      await discoverWorkers();
      assert(receipt.data.resources.length < (config.mode === 'model' ? 2 : 3), 'Total allocation budget exhausted');
      assert(receipt.data.resources.filter(r => r.name !== gatewayName).every(r => r.cleanup === 'stopped'), 'Previous worker must be stopped before dispatch');
      receipt.data.pendingWorkerIntent = profileIntent(profile);
      receipt.save();
      const result = await rpc('sessions.dispatch', { key, profileId: 'vercel' }, { timeout: 900_000 });
      assert.equal(result.placement.state, 'active');
      const status = await rpc('environments.status', { environmentId: result.placement.environmentId });
      const name = status.worker?.leaseId;
      assert(name, 'Native environment did not return an exact lease handle');
      receipt.intent(name, { owner: WORKER_OWNER, intent: profileIntent(profile) });
      await discoverWorkers();
      const box = await Sandbox.get({ ...config.credentials, name, resume: false, signal });
      assert.equal(box.persistent, false);
      assert.equal(box.tags?.intent, profileIntent(profile));
      assert.equal(box.tags?.owner, WORKER_OWNER);
      assert.deepEqual(box.currentSession().networkPolicy, observablePolicy(networkPolicy(profile, false)), 'Worker is not under gateway-only egress policy');
      const nonce = randomBytes(32).toString('hex');
      await write(box, '/tmp/ocw-e2e-worker-only', JSON.stringify({ nonce, gatewayOrigin: profile.gatewayOrigin }));
      receipt.check('native-enrollment', { environmentId: result.placement.environmentId, worker: name, placement: result.placement });
      return { box, nonce, environmentId: result.placement.environmentId, remote: result.placement.remoteWorkspaceDir, record: receipt.data.resources.find(r => r.name === name) };
    };
    const send = scenario => rpc('chat.send', { sessionKey: key, message: `E2E_CASE=${scenario}. Use exec to run exactly: node e2e-task.mjs ${scenario}, with yieldMs=120000 and timeoutSeconds=110. Do not edit the test files. Report its output.`, idempotencyKey: `${receipt.data.runId}-${scenario}`, deliver: false, timeoutMs: 120_000 });
    const terminal = (runId, timeout = 125_000) => rpc('agent.wait', { runId, timeoutMs: timeout }, { timeout: timeout + 5000 });
    const assertNoFallback = async () => assert.equal(await exists(gateway, '/tmp/ocw-e2e-local-fallback'), false, 'Detected gateway-local fallback');
    const verifyTurn = async (worker, scenario) => {
      const turn = await send(scenario);
      assert(turn.runId);
      assert.equal((await terminal(turn.runId)).status, 'ok', 'Native turn failed');
      const path = `e2e-result-${scenario}.json`;
      const bytes = await file(worker.box, posix.join(worker.remote, path));
      const result = JSON.parse(bytes);
      assert.equal(result.nonceHash, hash(worker.nonce));
      assert.equal(result.cwd, worker.remote);
      assert.equal(result.scenario, scenario);
      for (const name of ['adminEnvironmentAbsent', 'gatewayFileAbsent', 'gatewayPolicyPathAbsent', 'gatewayReachable', 'externalDenied']) assert.equal(result[name], true, `${name} failed`);
      assert.deepEqual(result.operatorDenied, { 'config.get': true, 'config.patch': true });
      receipt.check('worker-execution', { worker: worker.box.name, sha256: hash(bytes), scenario });
      await until(() => exists(gateway, posix.join(worktree, path)), { timeout: 45_000, signal, label: 'accepted worktree result' });
      assert.equal(await file(gateway, posix.join(worktree, path)), bytes, 'Accepted worktree bytes differ');
      const history = await rpc('chat.history', { sessionKey: key, limit: 100 });
      assert(JSON.stringify(history.messages).includes(`E2E_FILE_WRITTEN_${scenario}`), 'Accepted transcript does not contain tool output');
      receipt.check('workspace-reconciliation', { sha256: hash(bytes), scenario });
      await assertNoFallback();
      return bytes;
    };
    try {
      receipt.intent(gatewayName, gatewayTags);
      const registryHost = new URL(npmRegistry).hostname;
      gateway = await Sandbox.create({ ...config.credentials, name: gatewayName, tags: gatewayTags, persistent: false, image: 'vercel/sandbox/node:26', timeout: VM_TIMEOUT, ports: [3000], signal,
        networkPolicy: { allow: { [registryHost]: registryNetworkRules(npmRegistry, npmAuthorization ? { registry: npmRegistry, authorization: npmAuthorization } : undefined), '*': [] } } });
      const origin = gateway.domain(3000);
      const cfg = gatewayConfig({ ...config, origin, npmRegistry, npmAge: policy.minReleaseAgeDays });
      profile = parseProfile(cfg.cloudWorkers.profiles.vercel.settings);
      const cfgBytes = JSON.stringify(cfg);
      receipt.data.gatewayPolicyHash = hash(cfgBytes);
      receipt.data.workerIntent = profileIntent(profile);
      receipt.save();
      await run(gateway, 'setup-directories', ['mkdir', '-p', `${base}/repo`, `${base}/home`, state, `${base}/provider/dist`, `${base}/provider/assets`]);
      for (const path of ['package.json', 'package-lock.json']) await write(gateway, `${base}/${path}`, readFileSync(join(ROOT, path)));
      const supported = JSON.parse(await run(gateway, 'npm-capabilities', ['npm', 'config', 'list', '--json']));
      assertNpmPolicySupport(supported);
      await run(gateway, 'install-runtime', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', ...npmArgs], { cwd: base, timeoutMs: 600_000 });
      await run(gateway, 'complete-package-install', ['node', `${base}/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs`], { cwd: base });
      for (const path of ['package.json', 'openclaw.plugin.json', 'dist/index.js', 'dist/provider.js', 'dist/profile.js', 'dist/journal.js', 'assets/bootstrap.mjs']) await write(gateway, `${base}/provider/${path}`, readFileSync(join(ROOT, path)));
      for (const path of ['rpc.mjs', 'gateway-services.mjs', 'model-fixture.mjs', 'worker-probe.mjs']) await write(gateway, `${base}/${path}`, readFileSync(join(ROOT, 'test/e2e', path)));
      await write(gateway, `${base}/repo/e2e-task.mjs`, readFileSync(join(ROOT, 'test/e2e/task.mjs')));
      await write(gateway, `${base}/repo/e2e-authority.mjs`, readFileSync(join(ROOT, 'test/e2e/worker-authority.mjs')));
      await write(gateway, `${base}/gateway-only-canary`, randomBytes(32));
      await write(gateway, `${state}/openclaw.json`, cfgBytes);
      for (const args of [['init'], ['add', '.'], ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'Synthetic worker task']]) await run(gateway, 'git', ['git', ...args], { cwd: `${base}/repo` });
      const startServices = privileged => gateway.runCommand({ cmd: 'node', args: [`${base}/gateway-services.mjs`], cwd: base, detached: true,
        env: { E2E_MODEL_TOKEN: fixtureToken, E2E_ORIGIN: origin, ...(privileged && config.mode === 'model' ? { E2E_REAL_MODEL: config.model, AI_GATEWAY_API_KEY: config.modelKey } : {}) }, signal });
      services = await startServices(false);
      const startGateway = privileged => gateway.runCommand({ cmd: 'node', args: [cli, 'gateway', '--port', '18789', '--bind', 'loopback'], cwd: base, detached: true,
        env: { ...gatewayEnv, ...(privileged ? { VERCEL_OIDC_TOKEN: config.token, ...(npmAuthorization ? { OPENCLAW_NPM_AUTHORIZATION: npmAuthorization, OPENCLAW_NPM_AUTH_REGISTRY: npmRegistry } : {}) } : {}) }, signal });
      gatewayProcess = await startGateway(false);
      await until(async () => {
        try { return (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
      }, { timeout: 60_000, signal, label: 'gateway startup' });
      await rpc('config.get', {}, { token: 'synthetic-invalid-token', publicUrl: true, rejected: true });
      const pairingFailure = await rpc('config.get', {}, { publicUrl: true, pairing: true });
      const pairing = testOperatorPairing(pairingFailure, await rpc('device.pair.list'));
      const approval = await rpc('device.pair.approve', { requestId: pairing.requestId }, { scopes: ['operator.pairing', 'operator.read'] });
      assert.equal(approval.requestId, pairing.requestId);
      assert.equal(approval.device?.deviceId, pairing.deviceId);
      await rpc('config.get', {}, { publicUrl: true });
      receipt.check('public-auth');
      await gatewayProcess.kill('SIGTERM', { abortSignal: AbortSignal.timeout(10_000) });
      await gatewayProcess.wait({ signal: AbortSignal.timeout(30_000) });
      if (config.mode === 'model') {
        await services.kill('SIGTERM', { abortSignal: AbortSignal.timeout(10_000) });
        await services.wait({ signal: AbortSignal.timeout(15_000) });
        services = await startServices(true);
      }
      gatewayProcess = await startGateway(true);
      await until(async () => { try { return await rpc('health'); } catch { return false; } }, { timeout: 60_000, signal, label: 'privileged gateway restart' });
      const environments = await rpc('environments.list');
      assert(environments.profiles.some(p => p.id === 'vercel' && p.providerId === 'vercel-worker'), 'Native provider was not discovered');
      await run(gateway, 'external-control', ['node', '-e', 'const r=await fetch("https://example.com",{signal:AbortSignal.timeout(10000)}); if(!r.ok)process.exit(1);await r.body.cancel();'], { cwd: base });
      const created = await rpc('sessions.create', { key: `agent:main:e2e-${receipt.data.runId}`, worktree: true, cwd: `${base}/repo`, worktreeName: `e2e-${receipt.data.runId}` });
      key = created.key;
      sessionId = created.sessionId;
      worktree = created.worktree?.path;
      assert(key && posix.isAbsolute(worktree), 'Managed worktree creation failed');
      let worker = await dispatch();
      const first = await verifyTurn(worker, 'success');
      assert.equal(hash(await file(gateway, `${state}/openclaw.json`)), hash(cfgBytes), 'Gateway policy was modified');
      receipt.check('guardrails');
      if (config.mode === 'fixture') {
        const loss = await send('loss');
        await until(() => exists(worker.box, '/tmp/ocw-e2e-loss-started'), { timeout: 30_000, signal, label: 'active worker task' });
        await stopOwned(Sandbox, config.credentials, worker.record);
        receipt.save();
        assert.equal((await terminal(loss.runId)).status, 'error', 'Lost worker must visibly fail');
        await assertNoFallback();
        assert.equal(await file(gateway, posix.join(worktree, 'e2e-result-success.json')), first);
        await discoverWorkers();
        assert.equal(receipt.data.resources.length, 2, 'Worker loss caused unexpected replacement');
        receipt.check('worker-loss');
        await rpc('sessions.reclaim', { key }, { timeout: 180_000 });
        worker = await dispatch();
        assert.equal(await file(worker.box, posix.join(worker.remote, 'e2e-result-success.json')), first);
        await verifyTurn(worker, 'restored');
        receipt.check('redispatch');
        const cancelStarted = Date.now();
        const cancel = await send('cancel');
        await until(() => exists(worker.box, '/tmp/ocw-e2e-cancel-started'), { timeout: 30_000, signal, label: 'cancellable task' });
        const ack = await rpc('chat.abort', { sessionKey: key, runId: cancel.runId }, { timeout: 10_000 });
        assertCancellationAck(ack, cancel.runId);
        const ended = await terminal(cancel.runId, 10_000);
        assert.notEqual(ended.status, 'timeout', 'Cancellation did not terminate the turn');
        const heartbeat = await file(worker.box, '/tmp/ocw-e2e-cancel-heartbeat');
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(await file(worker.box, '/tmp/ocw-e2e-cancel-heartbeat'), heartbeat, 'Cancelled command is still running');
        assert(Date.now() - cancelStarted < 60_000, 'Cancellation was not proven before the task natural deadline');
        await assertNoFallback();
        receipt.check('cancellation');
      }
      const authorityStarted = Date.now();
      const authority = await send('authority');
      assert(authority.runId && sessionId);
      await until(() => exists(worker.box, '/tmp/ocw-e2e-authority-started'), { timeout: 30_000, signal, label: 'active authority task' });
      const target = { environmentId: worker.environmentId, sessionId, runId: authority.runId, id: `e2e-authority-${randomBytes(16).toString('hex')}` };
      await write(gateway, `${base}/authority-arm.json`, JSON.stringify(target));
      await until(() => exists(gateway, `${base}/authority-result.json`), { timeout: 15_000, signal, label: 'admitted worker RPC rejection' });
      const observed = JSON.parse(await file(gateway, `${base}/authority-result.json`));
      assert.equal(observed.ok, true, 'Admitted-worker authorization probe did not complete');
      assertWorkerDenial(observed.proof, target);
      assert.equal((await terminal(authority.runId, 15_000)).status, 'error', 'Probed native run must visibly fail');
      const authorityHeartbeat = await file(worker.box, '/tmp/ocw-e2e-authority-heartbeat');
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(await file(worker.box, '/tmp/ocw-e2e-authority-heartbeat'), authorityHeartbeat, 'Rejected worker task is still running');
      assert(Date.now() - authorityStarted < 60_000, 'Authority failure was not proven before the task natural deadline');
      assert.equal(hash(await file(gateway, `${state}/openclaw.json`)), hash(cfgBytes), 'Gateway policy changed');
      assert.equal(await file(gateway, posix.join(worktree, 'e2e-result-success.json')), first, 'Accepted output changed');
      await assertNoFallback();
      await discoverWorkers();
      assert.equal(receipt.data.resources.length, config.mode === 'model' ? 2 : 3, 'Authority failure caused an extra allocation');
      receipt.check('admitted-worker-rpc', observed.proof);
      await rpc('sessions.reclaim', { key }, { timeout: 180_000 });
      assert.equal((await Sandbox.get({ ...config.credentials, name: worker.box.name, resume: false, signal })).status, 'stopped', 'Native reclaim did not stop its worker');
      worker.record.cleanup = 'stopped';
      receipt.check('native-reclaim');
    } catch (error) { failure = error; }
    finally {
      lifetime.abort();
      if (gatewayProcess) {
        try {
          await gatewayProcess.kill('SIGTERM', { abortSignal: AbortSignal.timeout(10_000) });
          await gatewayProcess.wait({ signal: AbortSignal.timeout(30_000) });
        } catch (error) {
          failure ??= error;
          try {
            await gatewayProcess.kill('SIGKILL', { abortSignal: AbortSignal.timeout(10_000) });
            await gatewayProcess.wait({ signal: AbortSignal.timeout(10_000) });
          } catch (killError) { receipt.log('gateway-fence', killError.stack); }
        }
        try { receipt.log('gateway-process', await gatewayProcess.output('both', { signal: AbortSignal.timeout(10_000) })); } catch {}
      }
      if (gateway && profile && receipt.data.pendingWorkerIntent) {
        try {
          const result = await gateway.runCommand({ cmd: 'node', args: ['-e', 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});try{process.stdout.write(JSON.stringify(db.prepare("SELECT name,intent FROM allocations").all()))}finally{db.close()}', `${state}/vercel-worker/allocations.sqlite`], timeoutMs: 15_000, signal: AbortSignal.timeout(20_000) });
          assert.equal(result.exitCode, 0, 'Allocation journal could not be recovered');
          for (const row of JSON.parse(await result.stdout())) {
            assert.equal(row.intent, profileIntent(profile));
            receipt.intent(row.name, { owner: WORKER_OWNER, intent: row.intent });
          }
        } catch (error) { failure ??= error; receipt.log('cleanup-journal', error.stack); }
      }
      try { await discoverWorkers(); } catch (error) { failure ??= error; receipt.log('cleanup-discovery', error.stack); }
      for (const record of [...receipt.data.resources.filter(r => r.name !== gatewayName), ...receipt.data.resources.filter(r => r.name === gatewayName)]) {
        try { await stopOwned(Sandbox, config.credentials, record); }
        catch (error) { failure ??= error; receipt.log(`cleanup-${record.name}`, error.stack); }
        receipt.save();
      }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    if (receipt.data.resources.every(r => r.cleanup === 'stopped')) receipt.check('cleanup');
    receipt.finish(failure);
    process.stdout.write(config.mode === 'model' ? 'NATIVE_MODEL_SMOKE_PASS\n' : 'NATIVE_WORKER_E2E_PASS\n');
  }
} catch (error) {
  process.stderr.write(redact(error.stack ?? error, [config?.token, config?.modelKey, npmAuthorization, ...(receipt?.secrets ?? [])]) + '\n');
  process.exitCode = 1;
}
