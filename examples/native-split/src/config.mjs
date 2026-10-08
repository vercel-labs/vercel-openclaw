import assert from 'node:assert/strict';

export const SOURCE_COMMIT = '4a6520de4990169a45c6ea2cf64ff0dd44ba8c70';
export const NODE_STATE = '/data/openclaw-node';
export const NODE_CONFIG = '/tmp/openclaw-node.json';
export const PROFILE = 'dedicated-native';
export function settings(env = process.env) {
  const required = name => { assert(env[name]?.trim(), `${name} is required`); return env[name].trim(); };
  const publicUrl = new URL(env.SPLIT_PUBLIC_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : required('SPLIT_PUBLIC_URL')));
  assert(publicUrl.protocol === 'https:' && !publicUrl.username && !publicUrl.password && publicUrl.pathname === '/' && !publicUrl.search && !publicUrl.hash, 'SPLIT_PUBLIC_URL must be an HTTPS origin');
  const redisUrl = new URL(required('SPLIT_REDIS_URL'));
  assert(redisUrl.protocol === 'https:' && !redisUrl.username && !redisUrl.password && !redisUrl.search && !redisUrl.hash, 'SPLIT_REDIS_URL must be credential-free HTTPS');
  const image = required('SPLIT_WORKER_IMAGE');
  assert(/@sha256:[a-f0-9]{64}$/.test(image), 'SPLIT_WORKER_IMAGE must be an immutable native image digest');
  const agent = required('SPLIT_AGENT_ID');
  assert(/^[a-z0-9][a-z0-9-]{0,39}$/.test(agent), 'SPLIT_AGENT_ID must be a short resource-safe identifier');
  const controlToken = required('SPLIT_CONTROL_TOKEN');
  assert(controlToken.length >= 32, 'SPLIT_CONTROL_TOKEN must have at least 32 characters');
  assert(required('SPLIT_STORAGE_MODE') === 'ephemeral-proof', 'Persistent gateway storage is not qualified; only ephemeral-proof is implemented');
  return { publicUrl, image, agent, controlToken, model: env.OPENCLAW_MODEL ?? 'openai/gpt-5.4',
    gatewayKey: required('AI_GATEWAY_API_KEY'), redisUrl: redisUrl.toString(), redisToken: required('SPLIT_REDIS_TOKEN'),
    deploymentToken: env.VERCEL_OIDC_TOKEN, port: Number(env.PORT ?? 80), runtime: env.OPENCLAW_RUNTIME ?? '/app/openclaw.mjs',
    credentials: env.VERCEL_TOKEN ? {token: env.VERCEL_TOKEN, teamId: required('VERCEL_TEAM_ID'), projectId: required('VERCEL_PROJECT_ID')} : {},
  };
}
const metadata = model => ({ id: model, name: model, contextWindow: 128000, maxTokens: 2048, reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0} });
export function gatewayConfig(model, deviceId) {
  const ref = `vercel-ai-gateway/${model}`;
  return {
    models: { providers: { 'vercel-ai-gateway': {api: 'openai-completions', models: [metadata(model)]} } },
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: {mode: 'token'}, trustedProxies: ['127.0.0.1', '::1'] },
    agents: {entries: {assistant: {}}, defaults: { model: {primary: ref}, models: {[ref]: {agentRuntime: {id: 'openclaw'}}}, skipBootstrap: true, skills: [], heartbeat: {every: '0m'}, compaction: {memoryFlush: {enabled: false}} }},
    cloudWorkers: {requiredProfile: PROFILE, profiles: deviceId ? {[PROFILE]: {provider: 'device', settings: {device: deviceId, inference: 'worker'}}} : {}},
    tools: {allow: ['read', 'write'], fs: {workspaceOnly: true}, codeMode: false, toolSearch: false},
    cron: {enabled: false}, memory: {search: {provider: 'none', sources: ['memory']}},
  };
}
export function nodeConfig(model) {
  return {models: {providers: {'vercel-ai-gateway': {api: 'openai-completions', baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: '${WORKER_PROXY_AUTH}', models: [metadata(model)]}}},
    nodeHost: {workerRuns: {enabled: true, capacity: 1, isolation: 'none'}}};
}
export function workerPolicy(publicUrl, gatewayKey, deploymentToken) {
  return {allow: {
    [publicUrl.hostname]: deploymentToken ? [{transform: [{headers: {'x-vercel-trusted-oidc-idp-token': deploymentToken}}]}] : [],
    'ai-gateway.vercel.sh': [{match: {path: {startsWith: '/v1/'}, method: ['POST']}, transform: [{headers: {Authorization: `Bearer ${gatewayKey}`}}]}, {response: {statusCode: 403}}],
  }};
}
export function gatewayEnvironment(stateDir, token) {
  return {PATH: process.env.PATH, HOME: stateDir, LANG: 'C.UTF-8', NODE_ENV: 'production',
    OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json`, OPENCLAW_GATEWAY_TOKEN: token};
}
