import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_MODEL_KEY } from './model-credentials';
import { buildOpenClawRuntime } from './openclaw-runtime';

describe('buildOpenClawRuntime', () => {
  it('enables the official plugins and reaches the model through the AI Gateway provider', () => {
    // Both plugins are installed at create because the image ships neither,
    // verified against openclaw:latest on 2026-08-14. Enabling the Slack channel
    // is what keeps a user's own allow/deny lists and approvals working, and the
    // provider plugin replaces an earlier hack that repointed `openai.baseUrl`.
    const runtime = buildOpenClawRuntime({}, 'gateway-token');

    expect(runtime.gatewayEnv).toEqual({
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
      // Read by the provider plugin and sent as a Bearer to AI Gateway, where
      // the sandbox firewall replaces it with the real OIDC token.
      AI_GATEWAY_API_KEY: PLACEHOLDER_MODEL_KEY,
    });
    expect(runtime.configOperations).toEqual(
      expect.arrayContaining([
        { path: 'plugins.entries.slack.enabled', value: true },
        { path: 'plugins.entries.vercel-ai-gateway.enabled', value: true },
        {
          path: 'agents.defaults.model.primary',
          value: 'vercel-ai-gateway/openai/gpt-5.6-sol',
        },
      ]),
    );
  });

  it('no longer overrides the built-in openai provider endpoint', () => {
    // The provider plugin owns the endpoint, so writing baseUrl/apiKey under
    // models.providers.openai would be a second, conflicting source of truth.
    const paths = buildOpenClawRuntime({}, 'gateway-token').configOperations.map((op) => op.path);
    expect(paths).not.toContain('models.providers.openai.baseUrl');
    expect(paths).not.toContain('models.providers.openai.apiKey');
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
