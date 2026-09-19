import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import { networkPolicy, OWNER, parseProfile, profileIntent } from '../../provider/dist/profile.js';
import { startIngress } from '../e2e/gateway-services.mjs';
import { hash, observablePolicy, Receipt, redact, stopOwned, until } from '../e2e/support.mjs';
import { BASE, codexToolExclusions, REQUIRED, SMOKE_REQUIRED } from './policy.mjs';
import { connectTestOperator } from './gateway-session.mjs';
import { createNodeProbeRelay } from './node-relay.mjs';
import { readAllocations, recordProcess } from './recovery.mjs';

const state = `${BASE}/state`;
const cli = `${BASE}/node_modules/openclaw/openclaw.mjs`;
const modelKey = process.env.AI_GATEWAY_API_KEY;
const cloudToken = process.env.VERCEL_OIDC_TOKEN;
const operatorToken = randomBytes(32).toString('hex');
const secrets = [modelKey, cloudToken, operatorToken, process.env.OPENCLAW_NPM_AUTHORIZATION];
let receipt;

async function main() {
  process.umask(0o077);
  recordProcess('driver', process.pid);
  const input = JSON.parse(readFileSync(`${BASE}/input.json`, 'utf8'));
  assert(['full', 'basic'].includes(input.suite));
  const basic = input.suite === 'basic';
  const required = (basic ? SMOKE_REQUIRED : REQUIRED).filter(name => name !== 'cleanup');
  const cfg = input.cfg;
  const profile = parseProfile(cfg.cloudWorkers.profiles.vercel.settings);
  const intent = profileIntent(profile);
  const credentials = { token: cloudToken, projectId: input.projectId, teamId: input.teamId };
  assert(modelKey && cloudToken, 'Explicit gateway-only credentials required');
  receipt = new Receipt(`${BASE}/vm-results`, secrets, required);
  Object.assign(receipt.data, { suite: input.suite, parentRunId: input.runId, packageSha256: input.packageSha256, catalogSha256: input.catalogSha256, toolProof: input.toolProof });
  if (basic) receipt.data.notTested.push('exhaustive native-tool inventory', 'full security probes', 'cancellation', 'worker loss and replacement');
  receipt.save();
  for (const path of [state, `${BASE}/home`, `${BASE}/repo`]) mkdirSync(path, { recursive: true });
  const commonEnv = {
    ...process.env, HOME: `${BASE}/home`, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`,
    OPENCLAW_GATEWAY_TOKEN: operatorToken, OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_SKIP_GMAIL_WATCHER: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1', OPENCLAW_SKIP_CANVAS_HOST: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
  };
  Object.assign(process.env, commonEnv);
  const rpc = (method, params = {}, timeout = 15_000, options = {}) => callGatewayFromCli(method, {
    token: options.token ?? operatorToken, ...(options.url ? { url: options.url } : {}), timeout: String(timeout), json: true,
  }, params, { progress: false, sharedStateMode: 'read-only' });
  let gateway, gatewayClosed, ingress, operator, failure, sessionKey, sessionId, worktree;
  let gatewayOutput = '';
  const start = async privileged => {
    const childEnv = { ...commonEnv };
    if (!privileged) {
      for (const key of ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'OPENCLAW_NPM_AUTHORIZATION', 'OPENCLAW_NPM_AUTH_REGISTRY']) delete childEnv[key];
      childEnv.AI_GATEWAY_API_KEY = 'synthetic-unprivileged-setup-key';
    }
    gateway = spawn(process.execPath, [cli, 'gateway', '--port', '18789', '--bind', 'loopback'], { cwd: BASE, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    gatewayClosed = once(gateway, 'close');
    void gatewayClosed.catch(() => {});
    recordProcess('gateway', gateway.pid);
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', bytes => { gatewayOutput = (gatewayOutput + redact(bytes, secrets)).slice(-2 * 1024 * 1024); });
    await until(async () => {
      if (gateway.exitCode !== null) throw new Error('Gateway exited during startup');
      try { return await rpc('health'); } catch { return false; }
    }, { timeout: 60_000, label: 'isolated gateway health' });
  };
  const stopGateway = async () => {
    if (!gateway || gateway.exitCode !== null) return;
    gateway.kill('SIGTERM');
    const timer = setTimeout(() => gateway.kill('SIGKILL'), 10_000);
    try { await gatewayClosed; } finally { clearTimeout(timer); }
  };
  const run = async (box, label, args, options = {}) => {
    const result = await box.runCommand({ cmd: args[0], args: args.slice(1), timeoutMs: 15_000, signal: AbortSignal.timeout(30_000), ...options });
    const out = await result.stdout();
    receipt.log(`${Date.now()}-${label}`, JSON.stringify({ exitCode: result.exitCode, stdout: out, stderr: await result.stderr() }));
    assert.equal(result.exitCode, 0, `${label} failed`);
    return out;
  };
  const read = async (box, path) => {
    const bytes = await box.readFileToBuffer({ path }, { signal: AbortSignal.timeout(15_000) });
    assert(bytes, 'Expected worker artifact is missing');
    return bytes;
  };
  const put = (box, path, bytes) => box.writeFiles([{ path, content: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) }], { signal: AbortSignal.timeout(15_000) });
  const present = async (box, path) => (await run(box, 'artifact-ready', ['node', '-e', 'process.stdout.write(String(require("node:fs").existsSync(process.argv[1])))', path])).trim() === 'true';
  const discover = async () => {
    for await (const box of await Sandbox.list({ ...credentials, tags: { intent }, signal: AbortSignal.timeout(30_000) })) {
      assert.equal(box.tags?.owner, OWNER);
      receipt.intent(box.name, { owner: OWNER, intent });
    }
    assert(receipt.data.resources.length <= 2, 'Worker allocation budget exceeded');
  };
  const dispatch = async () => {
    await discover();
    assert(receipt.data.resources.length < 2, 'No more worker allocations permitted');
    assert(receipt.data.resources.every(record => record.cleanup === 'stopped'), 'Previous worker must be stopped');
    receipt.data.pendingWorkerIntent = intent;
    receipt.save();
    const result = await rpc('sessions.dispatch', { key: sessionKey, profileId: 'vercel' }, 900_000);
    const placement = result.placement;
    assert.equal(placement.state, 'active');
    assert(posix.isAbsolute(placement.remoteWorkspaceDir));
    const status = await rpc('environments.status', { environmentId: placement.environmentId });
    assert.equal(status.worker?.providerId, 'vercel-worker');
    const name = status.worker.leaseId;
    assert(name, 'Missing exact worker lease');
    receipt.intent(name, { owner: OWNER, intent });
    await discover();
    const box = await Sandbox.get({ ...credentials, name, resume: false });
    assert.equal(box.persistent, false);
    assert.equal(box.tags?.intent, intent);
    assert.equal(box.tags?.owner, OWNER);
    assert.deepEqual(box.currentSession().networkPolicy, observablePolicy(networkPolicy(profile, false)));
    const nodes = (await rpc('node.list')).nodes.filter(node => node.connected && !node.gatewayLocal);
    assert.equal(nodes.length, 1, 'Expected one enrolled cloud node');
    const node = nodes[0];
    const deviceId = await run(box, 'worker-public-identity', ['node', '--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";import {homedir} from "node:os";import {join} from "node:path";const db=new DatabaseSync(join(homedir(),".openclaw-vercel-worker/state/state/openclaw.sqlite"),{readOnly:true});try{const row=db.prepare("SELECT device_id FROM device_identities WHERE identity_key = ?").get("primary");if(!row)throw new Error("Missing worker identity");process.stdout.write(row.device_id);}finally{db.close();}']);
    assert(/^[a-f0-9]{64}$/.test(deviceId), 'Invalid worker public identity');
    assert.equal(node.nodeId, deviceId, 'Enrolled node does not match the owned VM');
    assert(node.commands?.includes('codex.exec-server.stdio.v1'));
    assert(node.caps?.includes('codex.exec-server'));
    assert.equal(node.approvalState, 'approved');
    const nonce = randomBytes(24).toString('hex');
    await put(box, '/tmp/ocw-codex-marker', JSON.stringify({ nonce, origin: input.origin }));
    const expected = { sessionKey, sessionId, environmentId: placement.environmentId, nodeId: node.nodeId, cwd: placement.remoteWorkspaceDir, ownerEpoch: placement.activeOwnerEpoch, placementGeneration: placement.generation };
    receipt.check('native-enrollment', { placement, nodeId: node.nodeId, worker: name });
    return { box, nonce, expected, remote: placement.remoteWorkspaceDir, record: receipt.data.resources.find(record => record.name === name) };
  };
  const begin = async (worker, message, label) => {
    const turn = await operator.send(message, `${input.runId}-${label}`);
    let approved = false, ended = false, approvalFailure;
    const approvalLoop = (async () => {
      while (!ended) {
        if (await operator.approveLaunch({ ...worker.expected, runId: turn.runId })) {
          assert(!approved, 'Unexpected second exec-server launch during one attempt');
          approved = true;
        }
        if (!ended) await new Promise(resolve => setTimeout(resolve, 200));
      }
    })().catch(error => { approvalFailure = error; });
    const completion = (async () => {
      try {
        const result = await operator.wait(turn.runId);
        assert(approved, 'The attempt never obtained its exact launch approval');
        return result;
      } finally { ended = true; await approvalLoop; if (approvalFailure) throw approvalFailure; }
    })();
    void completion.catch(() => {});
    return { ...turn, completion };
  };
  const noLocalFallback = () => assert(!existsSync('/tmp/ocw-codex-local-fallback'), 'Generated command reached VM1');
  const accepted = async (worker, path) => {
    const bytes = await read(worker.box, posix.join(worker.remote, path));
    await until(() => existsSync(join(worktree, path)), { timeout: 30_000, label: 'accepted workspace artifact' });
    assert.equal(hash(readFileSync(join(worktree, path))), hash(bytes), 'Reconciled bytes differ');
    return bytes;
  };
  try {
    writeFileSync(`${state}/openclaw.json`, JSON.stringify(cfg));
    writeFileSync(`${BASE}/gateway-only-canary`, randomBytes(32));
    writeFileSync(`${BASE}/repo/invoice.mjs`, 'export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n');
    const visibleTest = 'import assert from "node:assert/strict"; import {total} from "./invoice.mjs"; assert.equal(total([{price:12,quantity:3},{price:5,quantity:2}]),46); assert.equal(total([]),0); console.log("INVOICE_TESTS_PASS");\n';
    writeFileSync(`${BASE}/repo/invoice.test.mjs`, visibleTest);
    writeFileSync(`${BASE}/repo/e2e-task.mjs`, readFileSync(new URL('./task.mjs', import.meta.url)));
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'Synthetic Codex test']]) execFileSync('git', args, { cwd: `${BASE}/repo`, stdio: 'pipe' });
    ingress = await startIngress({ origin: input.origin, upstreamPort: 18789, port: 3000, upgradeRelay: createNodeProbeRelay() });
    await start(false);
    let rejected = false;
    try { await rpc('config.get', {}, 10_000, { token: 'synthetic-invalid-token', url: input.origin.replace('https:', 'wss:') }); }
    catch (error) { rejected = /unauthorized|token.*mismatch|token.*missing|auth.*required/i.test(error.message); }
    assert(rejected, 'Public ingress must return authentication rejection');
    receipt.check('public-auth');
    const catalog = await rpc('tools.catalog', { agentId: 'main', includePlugins: true });
    const toolNames = [...new Set(catalog.groups.flatMap(group => group.tools.map(tool => tool.id)))];
    assert(toolNames.includes('session_status'));
    cfg.plugins.entries.codex.config.codexDynamicToolsExclude = codexToolExclusions(toolNames);
    await stopGateway();
    writeFileSync(`${state}/openclaw.json`, JSON.stringify(cfg));
    const configHash = hash(readFileSync(`${state}/openclaw.json`));
    await start(true);
    const effective = await rpc('config.get');
    assert.equal(effective.valid, true, 'Gateway configuration is invalid');
    assert.deepEqual(effective.config.plugins.entries.codex.config.codexDynamicToolsExclude, cfg.plugins.entries.codex.config.codexDynamicToolsExclude);
    const selected = effective.config.agents.defaults.model.primary;
    assert(selected.startsWith('vercel-ai-gateway/'), 'Gateway model route changed');
    assert.equal(effective.config.agents.defaults.models[selected].agentRuntime.id, 'codex');
    assert.equal(selected, cfg.agents.defaults.model.primary);
    receipt.data.model = selected.slice('vercel-ai-gateway/'.length);
    receipt.save();
    const created = await rpc('sessions.create', { key: `agent:main:e2e-${input.runId}`, worktree: true, cwd: `${BASE}/repo`, worktreeName: `e2e-${input.runId}` });
    sessionKey = created.key; sessionId = created.sessionId; worktree = created.worktree?.path;
    assert(sessionKey && sessionId && posix.isAbsolute(worktree));
    // No exhaustive native inventory is claimed by the catalog/config checks.
    assert.equal(input.toolProof, basic ? 'basic-functional' : 'concrete-isolation', 'Pre-turn tool-proof acceptance is unresolved; do not dispatch a model');
    receipt.check('tool-authority', { proof: basic ? 'configured-dynamic-exclusions-only' : 'configured-dynamic-exclusions-and-concrete-isolation', exhaustiveNativeInventory: false, excludedTools: cfg.plugins.entries.codex.config.codexDynamicToolsExclude });
    let worker = await dispatch();
    operator = await connectTestOperator({ url: 'ws://127.0.0.1:18789', token: operatorToken, sessionKey });
    const repair = await begin(worker, 'Fix invoice.mjs: total must sum price * quantity for every item and return 0 for an empty list. Edit only invoice.mjs; do not edit the test or helper. From the project workspace, use your native command tools to run node invoice.test.mjs and node e2e-task.mjs repair. The helper generates isolation-result.json: leave that output in the project workspace, do not delete or fabricate it. Both commands must succeed; report any failure instead of substituting another command. Call the OpenClaw session_status tool once. Return the exact WORKER_MARKER value from the helper output in your final reply.', 'repair');
    assert.equal((await repair.completion).status, 'ok');
    const history = await operator.request('chat.history', { sessionKey, limit: 100 });
    receipt.log('chat-history', JSON.stringify(history));
    const repaired = await accepted(worker, 'invoice.mjs');
    assert.equal(await read(worker.box, posix.join(worker.remote, 'invoice.test.mjs')).then(bytes => bytes.toString()), visibleTest);
    assert.equal(hash(await read(worker.box, posix.join(worker.remote, 'e2e-task.mjs'))), hash(readFileSync(new URL('./task.mjs', import.meta.url))));
    const cases = Array.from({ length: 8 }, () => Array.from({ length: 3 }, () => ({ price: randomBytes(1)[0], quantity: randomBytes(1)[0] % 8 })));
    const expected = cases.map(items => items.reduce((sum, item) => sum + item.price * item.quantity, 0));
    const checked = JSON.parse(await run(worker.box, 'independent-invoice-check', ['node', '--input-type=module', '-e', 'const {total}=await import(process.argv[1]);process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(total)))', posix.join(worker.remote, 'invoice.mjs'), JSON.stringify(cases)]));
    assert.deepEqual(checked, expected);
    assert(history.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(worker.nonce)), 'Assistant reply omitted the worker-only random marker');
    receipt.check('codex-repair', { sha256: hash(repaired), independentCases: cases.length, markerSha256: hash(worker.nonce), runHash: hash(repair.runId) });
    assert(operator.trace().some(event => event.tool === 'session_status' && event.phase === 'result' && event.isError === false && event.runHash === hash(repair.runId)));
    receipt.check('callback', { tool: 'session_status' });
    const isolationBytes = await accepted(worker, 'isolation-result.json');
    receipt.check('workspace-reconciliation', { sha256: hash(repaired), isolationSha256: hash(isolationBytes) });
    noLocalFallback();
    if (!basic) {
    const cancel = await begin(worker, 'Use the native command tool to run node e2e-task.mjs cancel in the workspace. Keep waiting for that command. Do not edit files.', 'cancel');
    await until(() => present(worker.box, '/tmp/ocw-codex-cancel-started'), { timeout: 50_000, label: 'active cancellable command' });
    const started = JSON.parse(await read(worker.box, '/tmp/ocw-codex-cancel-started'));
    const gatewayProcesses = JSON.parse(execFileSync(process.execPath, [new URL('./runtime-proof.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 5000 })).processes;
    const independent = JSON.parse(await run(worker.box, 'native-placement', ['node', '--input-type=module', '-e', readFileSync(new URL('./runtime-proof.mjs', import.meta.url), 'utf8'), 'probe', input.origin, String(started.pid), worker.remote]));
    const workerProcesses = independent.processes;
    assert.equal(gatewayProcesses.length, 1, 'Expected one isolated native Codex engine in VM1');
    assert.equal(gatewayProcesses[0].role, 'app-server');
    assert.equal(workerProcesses.length, 1, 'Expected one native exec-server in VM2');
    assert.equal(workerProcesses[0].role, 'exec-server');
    assert.equal(workerProcesses[0].sha256, gatewayProcesses[0].sha256, 'Native engine and worker binaries differ');
    assert.equal(workerProcesses[0].administrativeEnvironmentAbsent, true);
    assert.equal(independent.task.administrativeEnvironmentAbsent, true, 'Generated task received an administrative credential');
    for (const key of ['gatewayCanaryAbsent', 'gatewayConfigAbsent', 'gatewayReachable', 'externalDenied']) assert.equal(independent[key], true, key);
    receipt.data.nativeRuntime = { gatewayProcesses, workerProcesses, task: independent.task };
    receipt.save();
    await operator.cancel(cancel.runId);
    await cancel.completion;
    const heartbeat = await read(worker.box, '/tmp/ocw-codex-cancel-heartbeat');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(hash(await read(worker.box, '/tmp/ocw-codex-cancel-heartbeat')), hash(heartbeat));
    assert(Date.now() - started.startedAt < 90_000, 'Process ended naturally; cancellation is not proven');
    const gone = await run(worker.box, 'cancelled-process', ['node', '-e', 'try{process.kill(Number(process.argv[1]),0);process.stdout.write("alive")}catch(e){if(e.code!=="ESRCH")throw e;process.stdout.write("gone")}', String(started.pid)]);
    assert.equal(gone, 'gone');
    receipt.check('cancellation', { pid: started.pid, processGone: true, heartbeatStopped: true, beforeNaturalDeadline: true });
    const loss = await begin(worker, 'Use the native command tool to run node e2e-task.mjs loss in the workspace. Keep waiting. Do not edit files.', 'loss');
    await until(() => present(worker.box, '/tmp/ocw-codex-loss-started'), { timeout: 50_000, label: 'active worker-loss command' });
    await stopOwned(Sandbox, credentials, worker.record);
    assert.equal((await loss.completion).status, 'error');
    noLocalFallback();
    await discover();
    assert.equal(receipt.data.resources.length, 1, 'Worker loss caused automatic replacement');
    assert.equal(hash(readFileSync(join(worktree, 'invoice.mjs'))), hash(repaired));
    receipt.check('worker-loss', { terminalStatus: 'error', localFallbackAbsent: true, workerCount: receipt.data.resources.length });
    const previousNode = worker.expected.nodeId;
    await rpc('sessions.reclaim', { key: sessionKey }, 180_000);
    worker = await dispatch();
    assert.notEqual(worker.expected.nodeId, previousNode);
    assert.equal(hash(await read(worker.box, posix.join(worker.remote, 'invoice.mjs'))), hash(repaired));
    receipt.check('redispatch', { freshNodeIdentity: true, acceptedSha256: hash(repaired), processesResumed: false });
    const denial = await ingress.probe({ nodeId: worker.expected.nodeId });
    assert.deepEqual(denial, { admitted: true, role: 'node', nodeId: worker.expected.nodeId, method: 'config.patch', denied: true, sameConnection: true });
    assert.equal(hash(readFileSync(`${state}/openclaw.json`)), configHash);
    assert.deepEqual((await Sandbox.get({ ...credentials, name: worker.box.name, resume: false })).currentSession().networkPolicy, observablePolicy(networkPolicy(profile, false)));
    receipt.check('guardrails', { ...independent, admittedNodeMutationDenied: true, fullFirewallPolicyMatched: true });
    }
    await rpc('sessions.reclaim', { key: sessionKey }, 180_000);
    assert.equal((await Sandbox.get({ ...credentials, name: worker.box.name, resume: false })).status, 'stopped');
    worker.record.cleanup = 'stopped';
    receipt.check('native-reclaim');
  } catch (error) { failure = error; }
  finally {
    if (operator) {
      receipt.log('operator-trace', JSON.stringify({ status: operator.traceStatus(), events: operator.trace() }));
      receipt.data.operatorTraceSha256 = hash(readFileSync(`${BASE}/vm-results/operator-trace.log`));
      await operator.close().catch(error => { failure ??= error; });
    }
    await stopGateway().catch(error => { failure ??= error; });
    receipt.log('gateway', gatewayOutput);
    await ingress?.close().catch(error => { failure ??= error; });
    try {
      const journal = join(state, 'vercel-worker/allocations.sqlite');
      if (existsSync(journal)) {
        for (const row of readAllocations(journal, intent)) receipt.intent(row.name, { owner: OWNER, intent });
      } else assert(!receipt.data.pendingWorkerIntent, 'Pending allocation has no recoverable journal');
    } catch (error) { failure ??= error; }
    await discover().catch(error => { failure ??= error; });
    for (const record of receipt.data.resources) {
      try { await stopOwned(Sandbox, credentials, record); } catch (error) { failure ??= error; }
      receipt.save();
    }
    receipt.finish(failure);
  }
}

main().catch(error => { process.stderr.write(redact(error.stack ?? error, secrets) + '\n'); process.exitCode = 1; });
