import assert from 'node:assert/strict';
import { STATE, WORKSPACE } from './config.js';

export function configuration(model: string) {
  const ref = `gateway/${model}`;
  return {
    models: { mode: 'replace', providers: { gateway: {
      baseUrl: 'https://ai-gateway.vercel.sh/v1', api: 'openai-completions', apiKey: '${OPENCLAW_DRIVES_MODEL_KEY}',
      models: [{ id: model, name: model, input: ['text'], contextWindow: 128000, maxTokens: 2048 }],
    } } },
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token' } },
    agents: { entries: { main: {} }, defaults: {
      workspace: WORKSPACE, model: { primary: ref }, models: { [ref]: { agentRuntime: { id: 'openclaw' } } },
      skipBootstrap: true, skills: [], heartbeat: { every: '0m' },
      compaction: { memoryFlush: { enabled: false } },
    } },
    tools: { allow: ['read','write'], deny: ['apply_patch'], fs: { workspaceOnly: true }, codeMode: false, toolSearch: false },
    memory: { search: { provider: 'none', sources: ['memory'] } },
    cron: { enabled: false },
  };
}

export function agentArgs(conversation: string, message: string): string[] {
  return ['/app/openclaw.mjs', 'agent', '--agent', 'main', '--session-key', `agent:main:drive-${conversation}`,
    '--message', message, '--timeout', '120', '--json'];
}

export interface AgentReply {
  text: string;
  runId: string;
  sessionId: string;
  harness: string | null;
  toolSummary: { calls: number; tools: string[]; failures?: number; unresolvedError?: unknown } | null;
  promptReport: {
    source?: string;
    injectedWorkspaceFiles?: Array<{ name: string; path: string; missing: boolean; injectionStatus?: string; injectedChars: number | null }>;
    tools?: { entries?: Array<{name: string}> };
  } | null;
}

export function parseAgentReply(stdout: string, model: string): AgentReply {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('Agent output is not a single JSON response.'); }
  assert(parsed && parsed.status === 'ok' && typeof parsed.runId === 'string' && parsed.runId.length > 0,
    'Agent did not return a completed Gateway-owned run.');
  const result = parsed.result;
  assert(result && Array.isArray(result.payloads), 'Missing Gateway result payloads.');
  assert(!result.meta?.error && !result.meta?.aborted, 'Gateway reported an error or aborted turn.');
  assert(!result.payloads.some((p: { isError?: boolean }) => p.isError), 'Agent returned an error payload.');
  const meta = result.meta?.agentMeta;
  assert.equal(meta?.provider, 'gateway', 'Unexpected model provider.');
  assert.equal(meta?.model, model, 'Unexpected model or fallback.');
  assert(typeof meta?.sessionId === 'string' && meta.sessionId.length > 0, 'Missing durable OpenClaw session identity.');
  if (meta.agentHarnessId !== undefined) assert.equal(meta.agentHarnessId, 'openclaw', 'Unexpected agent harness.');
  const text = result.payloads.filter((p: { isReasoning?: boolean; isCommentary?: boolean; text?: string }) =>
    !p.isReasoning && !p.isCommentary && typeof p.text === 'string').map((p: { text: string }) => p.text).join('\n');
  assert(text.trim(), 'Agent did not produce a final text reply.');
  return { text, runId: parsed.runId, sessionId: meta.sessionId, harness: meta.agentHarnessId ?? null,
    toolSummary: result.meta?.toolSummary ?? null,
    promptReport: result.meta?.systemPromptReport ?? null };
}

export function assertCleanShutdown(exitCode: number, logs: string): void {
  logs = logs.replaceAll('[shutdown]', 'shutdown');
  assert.equal(exitCode, 0, 'Gateway did not exit cleanly after SIGTERM. Sandbox is preserved.');
  assert(/shutdown completed cleanly in \d+ms/.test(logs), 'Missing explicit clean-shutdown confirmation.');
  assert(!/shutdown deadline reached|abandoning unfinished cleanup|shutdown failed in|shutdown completed in .*with warnings|drain.*timed out/i.test(logs),
    'Gateway reported incomplete shutdown despite its exit status.');
}

export function assertNativeMemory(reply: AgentReply): void {
  assert.equal(reply.harness, 'openclaw', 'No-tool evidence requires the inspected native harness.');
  // This release omits toolSummary when the native run collected zero tool calls.
  if (reply.toolSummary !== null) {
    assert.equal(reply.toolSummary.calls, 0, 'Memory recall must make zero tool calls.');
    assert.deepEqual(reply.toolSummary.tools, [], 'Memory recall used a tool.');
    assert(!reply.toolSummary.failures && !reply.toolSummary.unresolvedError, 'Memory recall reported tool failures.');
  }
  assert.equal(reply.promptReport?.source, 'run', 'Memory injection needs actual run evidence.');
  const file = reply.promptReport?.injectedWorkspaceFiles?.find(f => f.path === `${WORKSPACE}/MEMORY.md`);
  assert(file && !file.missing && file.injectionStatus !== 'native_unverified' && (file.injectedChars ?? 0) > 0,
    'Native MEMORY.md injection was not verified.');
}

export const bootstrapScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, rawConfig, version] = process.argv.slice(1);
const prepared = path.join(root, '.vercel-drive-prepared.json');
if (!fs.existsSync(prepared) || fs.readFileSync(prepared,'utf8') !== JSON.stringify({format:1,uid:1000,gid:1000})) throw new Error('Drive is not prepared. Run the init command for this agent first.');
const marker = path.join(root, '.vercel-drives-example.json');
const configPath = path.join(root, 'openclaw.json');
const expected = { format: 1, version, configSha256: crypto.createHash('sha256').update(rawConfig).digest('hex') };
if (fs.existsSync(marker)) {
  if (JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) !== JSON.stringify(expected)) throw new Error('State belongs to another release or configuration. Explicit migration required.');
  if (!fs.existsSync(configPath)) throw new Error('Owned state has no configuration; refusing to reinitialize.');
  const saved = fs.readFileSync(configPath, 'utf8');
  if (saved !== rawConfig) throw new Error('Saved configuration changed; inspect it before restarting.');
  console.log('existing-state-preserved');
} else {
  if (fs.readdirSync(root).filter(name => name !== '.vercel-drive-prepared.json').length) throw new Error('Unrecognized nonempty Drive; refusing to overwrite it.');
  const workspace = path.join(root,'workspace'); fs.mkdirSync(workspace, {mode:0o700});
  for (const [file, bytes] of [[configPath,rawConfig],[marker,JSON.stringify(expected)]]) {
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(tmp,file);
  }
  console.log('new-state-initialized');
}
`;

export const inventoryScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[1];
if (!fs.existsSync(root)) throw new Error('Drive is not prepared. Run the init command for this agent first.');
const out = {};
let total = 0;
function visit(relative) {
  for (const entry of fs.readdirSync(path.join(root,relative)).sort()) {
    const name = path.join(relative,entry);const absolute = path.join(root,name);
    const stat = fs.lstatSync(absolute);
    if(stat.isDirectory())visit(name);
    else if(stat.isFile()) {
      total += stat.size;
      if(total > 128*1024*1024)throw new Error('Acceptance state exceeds 128 MiB; do not silently truncate inventory.');
      const bytes = fs.readFileSync(absolute);
      out[name] = {sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
    } else if(stat.isSymbolicLink()) out[name] = {symlink:fs.readlinkSync(absolute)};
    else throw new Error('Unsupported state entry: '+name);
  }
}
visit('');console.log(JSON.stringify(out));
`;
