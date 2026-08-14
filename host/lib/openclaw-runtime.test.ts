import { describe, expect, it } from 'vitest';
import { AI_GATEWAY_BASE_URL, PLACEHOLDER_MODEL_KEY } from './model-credentials';
import { buildOpenClawRuntime } from './openclaw-runtime';

describe('buildOpenClawRuntime', () => {
  it('migrates any existing direct-Slack sandbox to the credential-brokered runtime', () => {
    const runtime = buildOpenClawRuntime({}, 'gateway-token');

    expect(runtime.gatewayEnv).toEqual({
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
      OPENAI_API_KEY: PLACEHOLDER_MODEL_KEY,
    });
    expect(runtime.configOperations).toEqual(
      expect.arrayContaining([
        { path: 'plugins.entries.slack.enabled', value: false },
        { path: 'plugins.entries.vercel-ai-gateway.enabled', value: false },
        { path: 'models.providers.openai.baseUrl', value: AI_GATEWAY_BASE_URL },
        { path: 'models.providers.openai.apiKey', value: PLACEHOLDER_MODEL_KEY },
        { path: 'agents.defaults.model.primary', value: 'openai/gpt-5.6-sol' },
      ]),
    );
  });

  it('does not put Slack or model credentials in the sandbox process environment', () => {
    const runtime = buildOpenClawRuntime(
      {
        SLACK_BOT_TOKEN: 'xoxb-obsolete',
        SLACK_SIGNING_SECRET: 'obsolete-signing-secret',
        AI_GATEWAY_API_KEY: 'obsolete-ai-key',
        VERCEL_OIDC_TOKEN: 'obsolete-oidc-token',
      },
      'gateway-token',
    );

    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain('xoxb-obsolete');
    expect(serialized).not.toContain('obsolete-signing-secret');
    expect(serialized).not.toContain('obsolete-ai-key');
    expect(serialized).not.toContain('obsolete-oidc-token');
  });

  it('changes the persistent fingerprint when the model configuration changes', () => {
    const first = buildOpenClawRuntime({}, 'gateway-token');
    const second = buildOpenClawRuntime(
      { OPENCLAW_MODEL: 'openai/anthropic/claude-sonnet-4.5' },
      'gateway-token',
    );

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
