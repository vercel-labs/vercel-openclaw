import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const CODEX_ENDPOINT = 'https://ai-gateway.vercel.sh/codex/v1';
export const BASE = '/tmp/openclaw-codex-e2e';
export const REQUIRED = ['public-auth', 'native-enrollment', 'tool-authority', 'codex-repair', 'callback', 'guardrails', 'workspace-reconciliation', 'cancellation', 'worker-loss', 'redispatch', 'native-reclaim', 'cleanup'];
export const SMOKE_REQUIRED = REQUIRED.filter(name => !['guardrails', 'cancellation', 'worker-loss', 'redispatch'].includes(name));

export async function fetchNativeCatalog(key, model, fetchImpl = fetch) {
  assert(typeof key === 'string' && key.trim(), 'Explicit AI Gateway key required');
  const response = await fetchImpl(`${CODEX_ENDPOINT}/models`, {
    headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, 'Native catalog authentication failed');
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      assert(length <= 8 * 1024 * 1024, 'Native catalog exceeds test bound');
      chunks.push(chunk);
    }
  } catch {
    throw new Error('Native catalog download failed');
  }
  const bytes = Buffer.concat(chunks);
  const parsed = JSON.parse(bytes);
  assert(Array.isArray(parsed.models), 'Invalid native model catalog');
  const entries = new Map(parsed.models.map(entry => [entry.slug, entry]));
  assert.equal(entries.size, parsed.models.length, 'Duplicate native model identifier');
  const selected = entries.get(model);
  assert(selected, 'Selected model is absent from native catalog');
  assert(!selected.auto_review_model_override || entries.has(selected.auto_review_model_override), 'Reviewer is absent from native catalog');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, count: entries.size, path: `${BASE}/catalog/${sha256}.json` };
}

export function codexToolExclusions(toolNames = []) {
  return [...new Set(['exec', 'process', 'gateway', 'openclaw', ...toolNames.filter(name => name !== 'session_status')])].sort();
}

export function codexGatewayConfig({ origin, projectId, teamId, model, catalogPath, npmRegistry, npmAge = 2, excludedTools = [], workerImage, workerSnapshot, sessionTimeoutMs = 2700000, base = BASE }) {
  assert(posix.isAbsolute(catalogPath), 'Absolute native catalog path required');
  assert(!excludedTools.includes('session_status'), 'The test requires session_status');
  const ref = `vercel-ai-gateway/${model}`;
  return {
    gateway: {
      mode: 'local', port: 18789, bind: 'loopback', publicOrigin: origin,
      auth: { mode: 'token' }, trustedProxies: ['127.0.0.1', '::1'],
      nodes: { commands: { allow: ['codex.exec-server.stdio.v1'] } },
      controlUi: { enabled: false }, reload: { mode: 'off' },
    },
    plugins: {
      enabled: true, allow: ['vercel-worker', 'codex', 'vercel-ai-gateway'],
      load: { paths: [`${base}/provider`] }, slots: { memory: 'none' },
      entries: {
        'vercel-worker': { enabled: true }, 'vercel-ai-gateway': { enabled: true },
        codex: { enabled: true, config: {
          discovery: { enabled: false }, sessionCatalog: { enabled: false },
          computerUse: { enabled: false }, codexDynamicToolsLoading: 'direct',
          codexDynamicToolsExclude: codexToolExclusions(excludedTools),
          appServer: { transport: 'stdio', homeScope: 'agent', args: [
            'app-server', '-c', 'model_provider="vercel"',
            '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`,
            '-c', 'model_providers.vercel={name="Vercel AI Gateway",base_url="https://ai-gateway.vercel.sh/codex/v1",env_key="AI_GATEWAY_API_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0}',
          ] },
        } },
      },
    },
    agents: {
      defaults: { workspace: `${base}/repo`, model: { primary: ref }, models: { [ref]: { agentRuntime: { id: 'codex' } } }, skills: [], skipBootstrap: true, timeoutSeconds: 120 },
      entries: { main: { skills: [] } },
    },
    tools: { exec: { mode: 'auto', timeoutSeconds: 110 }, elevated: { enabled: false } },
    models: { mode: 'replace', providers: { 'vercel-ai-gateway': {
      baseUrl: CODEX_ENDPOINT, api: 'openai-responses', apiKey: '${AI_GATEWAY_API_KEY}',
      models: [{ id: model, name: model, api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 2048 }],
    } } },
    cloudWorkers: { profiles: { vercel: { provider: 'vercel-worker', settings: {
      gatewayOrigin: origin, projectId, teamId, timeoutMs: sessionTimeoutMs,
      npmRegistry, npmMinReleaseAgeDays: npmAge, npmReleaseAgeExclusions: [],
      ...(workerImage ? { workerImage } : {}), ...(workerSnapshot ? { workerSnapshot } : {}),
    } } } },
  };
}

export function exactLaunchApproval(pending, expected, now = Date.now()) {
  assert(Array.isArray(pending), 'Invalid pending plugin approval response');
  const matches = pending.filter(item => item.request?.sessionKey === expected.sessionKey && item.request?.runId === expected.runId);
  if (matches.length === 0) return undefined;
  assert.equal(matches.length, 1, 'Ambiguous test launch approval');
  const approval = matches[0];
  const request = approval.request;
  const binding = request.placementGrant;
  assert.equal(approval.approvalKind, 'plugin');
  assert.equal(request.pluginId, 'codex');
  assert.equal(request.severity, 'critical');
  assert(request.allowedDecisions?.includes('allow-once'), 'One-shot launch approval unavailable');
  assert(Number.isFinite(approval.expiresAtMs) && approval.expiresAtMs > now, 'Launch approval expired');
  assert(binding, 'Launch approval lacks placement binding');
  for (const [key, value] of Object.entries({
    pluginId: 'codex', command: 'codex.exec-server.stdio.v1', approvalScope: 'codex.exec-server',
    agentId: 'main', sessionKey: expected.sessionKey, sessionId: expected.sessionId,
    environmentId: expected.environmentId, nodeId: expected.nodeId,
    cwd: expected.cwd, ownerEpoch: expected.ownerEpoch, placementGeneration: expected.placementGeneration,
  })) {
    assert(value !== undefined && binding[key] === value, `Launch ${key} differs from the owned placement`);
  }
  assert(typeof binding.pairingGeneration === 'string' && binding.pairingGeneration, 'Launch pairing identity unavailable');
  assert(typeof approval.id === 'string' && approval.id, 'Missing approval identity');
  return { id: approval.id, decision: 'allow-once' };
}
