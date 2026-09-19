import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import { startIngress } from '../test/e2e/gateway-services.mjs';
import { connectTestOperator } from '../test/codex-e2e/gateway-session.mjs';
import { codexGatewayConfig, codexToolExclusions } from '../test/codex-e2e/policy.mjs';
import { OWNER, parseProfile, profileIntent, networkPolicy } from '../provider/dist/profile.js';
import { runRemoteTurn } from './remote-turn.mjs';
import { observablePolicy, redact } from '../test/e2e/support.mjs';
import { nativeSlackInput, nativeSlackConfig, nativeSlackController, waitForNativeSlack } from './native-slack.mjs';
import { startSlackProxy } from './slack-proxy.mjs';
import { serveResident, submitResident } from './resident.mjs';

const base = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const state = `${base}/state`;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rpc = (method, params = {}, timeout = 15_000) => callGatewayFromCli(method, { token, timeout: String(timeout), json: true }, params, { progress: false, sharedStateMode: 'read-only' });
let gateway, closed, ingress, slackProxy;

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  gateway.kill('SIGTERM');
  const timer = setTimeout(() => gateway.kill('SIGKILL'), 10_000);
  try { await closed; } finally { clearTimeout(timer); }
}

async function startGateway() {
  const log = openSync(`${base}/gateway.log`, 'a', 0o600);
  try { gateway = spawn(process.execPath, [`${base}/node_modules/openclaw/openclaw.mjs`, 'gateway', '--port', '18789', '--bind', 'loopback'], { cwd: base, env: process.env, stdio: ['ignore', log, log] }); }
  finally { closeSync(log); }
  closed = once(gateway, 'close');
  void closed.catch(() => {});
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    assert(gateway.exitCode === null, 'Gateway exited during boot');
    try { await rpc('health', {}, 3000); return; } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  throw new Error('Gateway boot deadline exceeded');
}

async function main() {
  process.umask(0o077);
  const input = JSON.parse(process.env.OPENCLAW_HOST_INPUT ?? 'null');
  const preparing = process.argv.includes('--prepare');
  assert(input && token && process.env.VERCEL_OIDC_TOKEN, 'Missing trusted host input');
  const manifest = JSON.parse(readFileSync(`${base}/runtime-manifest.json`, 'utf8'));
  assert.equal(input.runtimeDigest, hash(readFileSync(`${base}/runtime-manifest.json`)));
  for (const [path, digest] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(`${base}/${path}`)), digest, 'Runtime file integrity mismatch');
  let phases = [];
  const observe = phase => { phases.push({ phase, at: Date.now() }); writeFileSync(`${base}/host-phases.json`, JSON.stringify(phases)); };
  observe('runtime-verified');
  Object.assign(process.env, { HOME: `${base}/home`, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`, AI_GATEWAY_API_KEY: 'brokered-by-vercel-sandbox-firewall', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_GMAIL_WATCHER: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1', OPENCLAW_SKIP_CANVAS_HOST: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' });
  delete process.env.OPENCLAW_HOST_INPUT;
  for (const path of [state, `${base}/home`, `${base}/repo`, `${base}/sessions`]) mkdirSync(path, { recursive: true });
  if (!existsSync(`${base}/repo/.git`)) {
    for (const args of [['init'], ['-c','user.name=OpenClaw','-c','user.email=openclaw@example.invalid','commit','--allow-empty','-m','Initialize workspace']]) execFileSync('git', args, { cwd: `${base}/repo`, stdio: 'pipe' });
  }
  const cfg = codexGatewayConfig({ ...manifest.config, origin: input.origin, base });
  let native;
  if (manifest.config.nativeSlack) {
    if (!preparing) {
      native = nativeSlackInput(input.slackRawBody, manifest.config.nativeSlack);
      assert.equal(native.eventId, input.eventId, 'Slack event identity changed');
      delete process.env.OPENCLAW_SKIP_CHANNELS;
      slackProxy = await startSlackProxy();
      process.env.SLACK_API_URL = slackProxy.url;
    }
    Object.assign(cfg, nativeSlackConfig(manifest.config.nativeSlack));
    cfg.plugins.allow.push('slack');
    cfg.plugins.entries.slack = { enabled: true };
    process.env.SLACK_BOT_TOKEN = 'xoxb-brokered-by-vercel-firewall';
    process.env.SLACK_SIGNING_SECRET = randomBytes(32).toString('hex');
    process.env.OPENCLAW_HOST_ADMISSION_PATH = `${base}/host-admission.json`;
    writeFileSync(process.env.OPENCLAW_HOST_ADMISSION_PATH, JSON.stringify({ expiresAt: 0 }));
    if (native) Object.assign(input, native);
  }
  const configPath = `${state}/openclaw.json`;
  writeFileSync(configPath, JSON.stringify(cfg));
  ingress = await startIngress({ origin: input.origin, upstreamPort: 18789, port: 3000 });
  await startGateway();
  observe('gateway-ready');
  if (native) {
    await waitForNativeSlack(rpc);
    // Initialize OpenClaw's shared local approval identity without changing its execution policy.
    await rpc('exec.approvals.get');
    observe('slack-ready');
  }
  const tools = await rpc('tools.catalog', { agentId: 'main', includePlugins: true });
  const exclusions = codexToolExclusions(tools.groups.flatMap(group => group.tools.map(tool => tool.id)));
  if (preparing) {
    await stopGateway();
    await ingress.close(); ingress = undefined;
    process.stdout.write(`OPENCLAW_HOST_PREPARED=${JSON.stringify({ excludedTools: exclusions })}\n`);
    return;
  }
  if (manifest.config.excludedTools) assert.deepEqual(exclusions, manifest.config.excludedTools, 'Live tool catalog differs from prepared guardrails');
  else {
    cfg.plugins.entries.codex.config.codexDynamicToolsExclude = exclusions;
    await stopGateway();
    writeFileSync(configPath, JSON.stringify(cfg));
    await startGateway();
  }
  const configDigest = hash(readFileSync(configPath));
  const credentials = () => ({ token: JSON.parse(readFileSync(`${base}/host-credentials.json`, 'utf8')).token, projectId: manifest.config.projectId, teamId: manifest.config.teamId });
  const profile = parseProfile(cfg.cloudWorkers.profiles.vercel.settings);
  let retained;
  let turns = 0;
  const reclaim = async () => {
    if (!retained) return;
    await rpc('sessions.reclaim', { key: retained.sessionKey }, 60_000);
    await retained.worker.assertStopped();
    retained = undefined;
  };
  const execute = async input => {
    if (turns++) { phases = []; observe('gateway-reused'); }
    if (manifest.config.nativeSlack) {
      native = nativeSlackInput(input.slackRawBody, manifest.config.nativeSlack);
      assert.equal(native.eventId, input.eventId, 'Slack event identity changed');
      Object.assign(input, native);
    }
    if (retained && retained.sessionKey !== input.sessionKey.toLowerCase()) await reclaim();
    const result = await runRemoteTurn({ ...input, base, rpc, observe, retained, keepWorker: true,
    ...(native ? nativeSlackController({ input: native, path: process.env.OPENCLAW_HOST_ADMISSION_PATH, secret: process.env.SLACK_SIGNING_SECRET, rpc, observe, signal: input.signal }) : {}),
    connectOperator: sessionKey => connectTestOperator({ url: 'ws://127.0.0.1:18789', token, sessionKey, localApprovals: Boolean(native), signal: input.signal }),
    loadSession: async key => {
      const path = `${base}/sessions/${hash(key)}.json`;
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    },
    saveSession: async (key, session) => {
      const path = `${base}/sessions/${hash(key)}.json`;
      writeFileSync(`${path}.tmp`, JSON.stringify(session));
      renameSync(`${path}.tmp`, path);
    },
    workerFor: async placement => {
      const verified = async operation => { const value = await operation; input.signal?.throwIfAborted(); return value; };
      const readSignal = () => AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(10_000)]);
      const status = await verified(rpc('environments.status', { environmentId: placement.environmentId }));
      assert.equal(status.worker?.providerId, 'vercel-worker');
      const name = status.worker.leaseId;
      const box = await verified(Sandbox.get({ ...credentials(), name, resume: false, signal: readSignal() }));
      assert.equal(box.status, 'running');
      assert.equal(box.persistent, false);
      assert.equal(box.tags?.owner, OWNER);
      assert.equal(box.tags?.intent, profileIntent(profile));
      // Credential-free steady-state worker policy, independently read back from the platform.
      const observed = box.currentSession().networkPolicy;
      assert.deepEqual(observed, observablePolicy(networkPolicy(profile, false)));
      const nodes = (await verified(rpc('node.list'))).nodes.filter(node => node.connected && !node.gatewayLocal);
      assert.equal(nodes.length, 1, 'Expected exactly one remote node');
      assert(nodes[0].commands?.includes('codex.exec-server.stdio.v1') && nodes[0].approvalState === 'approved');
      const identity = await verified(box.runCommand({ cmd: 'node', args: ['--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";import {homedir} from "node:os";import {join} from "node:path";const db=new DatabaseSync(join(homedir(),".openclaw-vercel-worker/state/state/openclaw.sqlite"),{readOnly:true});try{process.stdout.write(db.prepare("SELECT device_id FROM device_identities WHERE identity_key = ?").get("primary").device_id)}finally{db.close()}'], timeoutMs: 5000, signal: readSignal() }));
      assert.equal(identity.exitCode, 0);
      assert.equal(nodes[0].nodeId, await verified(identity.stdout()), 'Remote node does not belong to the allocated VM');
      const worker = { name, nodeId: nodes[0].nodeId, assertStopped: async () => assert.equal((await Sandbox.get({ ...credentials(), name, resume: false, signal: AbortSignal.timeout(10_000) })).status, 'stopped') };
      retained = { sessionKey: input.sessionKey.toLowerCase(), placement, worker };
      return worker;
    },
  });
    assert.equal(hash(readFileSync(configPath)), configDigest, 'Gateway configuration changed during the turn');
    retained = result.retained;
    return { ...result, retained: undefined, phases, gatewayStopped: false, gatewayPid: gateway.pid };
  };
  await serveResident({ base, token, input, execute, reclaim, rpc, stopGateway, gatewayHasExited: () => gateway.exitCode !== null || gateway.signalCode !== null });
}

try {
  if (process.argv.includes('--prepare')) await main();
  else if (process.argv.includes('--daemon')) {
    process.env.OPENCLAW_HOST_CREDENTIALS_PATH = `${base}/host-credentials.json`;
    await main();
  } else await submitResident({ base, token, input: JSON.parse(process.env.OPENCLAW_HOST_INPUT ?? 'null'), credential: process.env.VERCEL_OIDC_TOKEN });
}
catch (error) {
  writeFileSync(`${base}/host-last-error.log`, redact(error.stack ?? error, [token, process.env.VERCEL_OIDC_TOKEN]), { mode: 0o600 });
  process.stderr.write('OpenClaw Codex host turn failed; no successful lifecycle receipt\n'); process.exitCode = 1;
}
finally { await stopGateway(); await ingress?.close(); await slackProxy?.close(); }
