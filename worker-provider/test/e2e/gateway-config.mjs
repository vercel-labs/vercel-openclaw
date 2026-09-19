export function gatewayConfig({ origin, projectId, teamId, model, npmRegistry, npmAge, npmExceptions }) {
  const id = model ?? 'fixture';
  return {
    gateway: { mode: 'local', port: 18789, bind: 'loopback', publicOrigin: origin, auth: { mode: 'token' }, trustedProxies: ['127.0.0.1', '::1'], controlUi: { enabled: false }, reload: { mode: 'off' } },
    plugins: { enabled: true, allow: ['vercel-worker'], load: { paths: ['/vercel/sandbox/e2e/provider'] }, entries: { 'vercel-worker': { enabled: true } }, slots: { memory: 'none' } },
    agents: {
      defaults: { workspace: '/vercel/sandbox/e2e/repo', model: { primary: `e2e/${id}` }, models: { [`e2e/${id}`]: { agentRuntime: { id: 'openclaw' } } }, skills: [], skipBootstrap: true, timeoutSeconds: 120 },
      entries: { main: { skills: [] } },
    },
    tools: { allow: ['read', 'write', 'edit', 'apply_patch', 'exec'], exec: { mode: 'full', timeoutSeconds: 110 }, elevated: { enabled: false } },
    models: { mode: 'replace', providers: { e2e: {
      baseUrl: 'http://127.0.0.1:4000/v1',
      api: 'openai-completions', apiKey: '${E2E_MODEL_TOKEN}',
      models: [{ id, name: id, api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } },
    cloudWorkers: { profiles: { vercel: { provider: 'vercel-worker', settings: { gatewayOrigin: origin, projectId, teamId, timeoutMs: 2700000, npmRegistry, npmMinReleaseAgeDays: npmAge, npmReleaseAgeExclusions: npmExceptions } } } },
  };
}
