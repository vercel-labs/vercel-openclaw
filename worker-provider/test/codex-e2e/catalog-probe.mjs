import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const endpoint = 'https://ai-gateway.vercel.sh/codex/v1';
const model = 'openai/gpt-5.6-sol';
const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl' };
const receipt = { startedAt: new Date().toISOString(), scope: 'Configuration and catalog only; no thread, model turn, tool or VM.', methods: [] };
let stage = 'preflight';
let directory;
let child;
let closed;
const pending = new Map();

try {
  assert.equal(process.env.OPENCLAW_CODEX_CATALOG_RUN, '1', 'explicit catalog opt-in required');
  const mode = process.argv[2];
  assert(['default', 'gateway-json'].includes(mode), 'select default or gateway-json');
  const key = process.env.AI_GATEWAY_API_KEY;
  assert(key?.trim().length > 20, 'AI_GATEWAY_API_KEY missing');
  const output = process.env.OPENCLAW_CODEX_CATALOG_DIR;
  assert(output && isAbsolute(output), 'fresh absolute output directory required');
  const target = `${process.platform}-${process.arch}`;
  assert(targets[target], 'diagnostic supports macOS arm64 and Linux x64');
  const binary = join(packageRoot, `node_modules/@openai/codex-${target}/vendor/${targets[target]}/bin/codex`);
  const plugin = JSON.parse(readFileSync(join(packageRoot, 'node_modules/@openclaw/codex/package.json')));
  assert.equal(plugin.version, '2026.9.2');
  assert.equal(plugin.dependencies['@openai/codex'], '0.153.4');
  mkdirSync(output, { mode: 0o700 });
  directory = output;
  const home = join(directory, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(directory, 'empty-workspace');
  for (const path of [codexHome, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = { PATH: `${dirname(binary)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: codexHome, TMPDIR: directory, AI_GATEWAY_API_KEY: key, RUST_LOG: 'error' };
  const version = spawnSync(binary, ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.status, 0, 'native binary failed');
  assert.equal(version.stdout.trim(), 'codex-cli 0.153.4');
  receipt.version = version.stdout.trim();
  receipt.mode = mode;
  receipt.binarySha256 = hash(readFileSync(binary));
  receipt.lockSha256 = hash(readFileSync(join(packageRoot, 'package-lock.json')));
  const catalogConfig = [];
  if (mode === 'gateway-json') {
    stage = 'gateway-catalog';
    const response = await fetch(endpoint + '/models', { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, 'catalog HTTP status');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      assert(length <= 8 * 1024 * 1024, 'catalog size limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const catalog = JSON.parse(bytes);
    assert(Array.isArray(catalog.models) && catalog.models.some(item => item.slug === model), 'selected model missing upstream');
    const path = join(codexHome, 'gateway-catalog.json');
    // Preserve the entire external catalog, including native tool and review metadata.
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    catalogConfig.push(`model_catalog_json = ${JSON.stringify(path)}`);
    receipt.gatewayCatalog = { status: response.status, count: catalog.models.length, sha256: hash(bytes), modified: false };
  }
  const config = [
    'model_provider = "vercel"', `model = "${model}"`, ...catalogConfig,
    'sandbox_mode = "read-only"', 'approval_policy = "on-request"', 'approvals_reviewer = "auto_review"',
    'cli_auth_credentials_store = "file"', 'web_search = "disabled"',
    '[model_providers.vercel]', 'name = "Vercel AI Gateway"', `base_url = "${endpoint}"`,
    'env_key = "AI_GATEWAY_API_KEY"', 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0',
  ].join('\n') + '\n';
  writeFileSync(join(codexHome, 'config.toml'), config, { flag: 'wx', mode: 0o600 });
  receipt.configSha256 = hash(config);
  stage = 'native-start';
  child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let seq = 0;
  let buffered = '';
  let totalBytes = 0;
  let stderrBytes = 0;
  const notifications = new Set();
  const failAll = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on('error', () => failAll(new Error('native spawn failed')));
  child.once('close', () => failAll(new Error('native process closed')));
  child.stderr.on('data', data => {
    stderrBytes += data.length;
    if (stderrBytes > 1024 * 1024) { failAll(new Error('stderr limit')); child.kill('SIGTERM'); }
  });
  child.stdout.on('data', data => {
    try {
      totalBytes += data.length;
      assert(totalBytes <= 8 * 1024 * 1024, 'RPC output limit');
      buffered += data.toString('utf8');
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method) {
          assert(message.id === undefined, 'unexpected server request');
          assert(!/^(thread|turn|item)\//.test(message.method), 'unexpected execution event');
          notifications.add(message.method);
        } else {
          const item = pending.get(message.id);
          assert(item, 'unexpected RPC response');
          pending.delete(message.id);
          if (message.error) item.reject(new Error('native RPC failed'));
          else item.resolve(message.result);
        }
      }
    } catch (error) { failAll(error); child.kill('SIGTERM'); }
  });
  async function request(method, params) {
    // This diagnostic must never create a thread or accept model-generated tool requests.
    assert(['initialize', 'config/read', 'account/read', 'model/list'].includes(method));
    receipt.methods.push(method);
    const id = ++seq;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout')); child.kill('SIGTERM'); }, 20_000);
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally { clearTimeout(timer); }
  }
  await request('initialize', { clientInfo: { name: 'openclaw_vercel_catalog_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  stage = 'native-config';
  const effective = (await request('config/read', { includeLayers: false, cwd })).config;
  assert.equal(effective.model_provider, 'vercel');
  assert.equal(effective.model, model);
  assert.equal(effective.model_providers.vercel.base_url, endpoint);
  assert.equal(effective.model_providers.vercel.env_key, 'AI_GATEWAY_API_KEY');
  assert.equal(effective.approvals_reviewer, 'auto_review');
  assert.equal(effective.approval_policy, 'on-request');
  assert.equal(effective.sandbox_mode, 'read-only');
  receipt.effectiveConfig = { provider: effective.model_provider, model, endpoint, reviewer: effective.approvals_reviewer, sandbox: effective.sandbox_mode };
  stage = 'native-account';
  const account = await request('account/read', { refreshToken: false });
  assert.equal(account.requiresOpenaiAuth, false);
  assert.equal(account.account, null);
  receipt.account = { requiresOpenaiAuth: false, account: null };
  stage = 'native-models';
  const models = [];
  const cursors = new Set();
  let cursor;
  do {
    assert(receipt.methods.length < 14, 'pagination limit');
    const page = await request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    assert(Array.isArray(page.data));
    models.push(...page.data);
    cursor = page.nextCursor;
    if (cursor) { assert(!cursors.has(cursor), 'repeated cursor'); cursors.add(cursor); }
  } while (cursor);
  receipt.catalog = { count: models.length, selectedModelPresent: models.some(item => item.id === model || item.model === model), providerQualifiedCount: models.filter(item => item.id.includes('/')).length, sha256: hash(JSON.stringify(models)) };
  if (mode === 'gateway-json') assert(receipt.catalog.selectedModelPresent, 'native catalog did not load selected model');
  receipt.notifications = [...notifications].sort();
  receipt.status = 'CATALOG_OBSERVED';
} catch {
  receipt.status = 'CATALOG_DIAGNOSTIC_FAILED';
  receipt.failureStage = stage;
  process.exitCode = 1;
} finally {
  if (child) {
    child.stdin.end();
    const soft = setTimeout(() => child.kill('SIGTERM'), 3000);
    const hard = setTimeout(() => child.kill('SIGKILL'), 6000);
    receipt.processExit = await closed;
    clearTimeout(soft); clearTimeout(hard);
    if (receipt.processExit.code !== 0 || receipt.processExit.signal) { receipt.status = 'CATALOG_DIAGNOSTIC_FAILED'; process.exitCode = 1; }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.probeSha256 = hash(readFileSync(new URL(import.meta.url)));
  if (directory) writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
