import { describe, expect, it } from 'vitest';
import { buildOpenClawRuntime } from './openclaw-runtime';

describe('buildOpenClawRuntime', () => {
  it('enables the official plugins and reaches the model through the AI Gateway provider', () => {
    // Both plugins are installed at create because the image ships neither,
    // verified against openclaw:latest on 2026-08-14. Enabling the Slack channel
    // is what keeps a user's own allow/deny lists and approvals working, and the
    // provider plugin replaces an earlier hack that repointed `openai.baseUrl`.
    const runtime = buildOpenClawRuntime({}, 'gateway-token');

    // Only the gateway token. `AI_GATEWAY_API_KEY` must stay out: it never
    // authenticated anything (OpenClaw reports `Shell env : off`; the profile
    // seeded by `seedProviderPlaceholder` is what works), and setting it marks
    // `vercel-ai-gateway` as configured, so a missing plugin sends the startup
    // doctor to npm. npm is unreachable under the steady-state egress policy and
    // that resolution runs before the logger starts, so the gateway hangs with
    // an empty log. Measured 2026-08-17: never bound with it set, 7.42s without.
    expect(runtime.gatewayEnv).toEqual({
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
    });
    expect(runtime.gatewayEnv).not.toHaveProperty('AI_GATEWAY_API_KEY');
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
        OPENAI_API_KEY: 'obsolete-openai-key',
        VERCEL_OIDC_TOKEN: 'obsolete-oidc-token',
      },
      'gateway-token',
    );

    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain('xoxb-obsolete');
    expect(serialized).not.toContain('obsolete-signing-secret');
    expect(serialized).not.toContain('obsolete-ai-key');
    expect(serialized).not.toContain('obsolete-openai-key');
    expect(serialized).not.toContain('obsolete-oidc-token');
  });

  it('configures native Slack through the host bridge without changing channel policy', () => {
    const runtime = buildOpenClawRuntime(
      {
        OPENCLAW_SLACK_HOST_BRIDGE_TOKEN: 'host-bridge-token',
        OPENCLAW_SLACK_HOST_BRIDGE_API_URL: 'https://host.example/api/slack-proxy/',
        AI_GATEWAY_API_KEY: 'must-not-enter-the-vm',
        OPENAI_API_KEY: 'must-also-stay-out',
        VERCEL_OIDC_TOKEN: 'firewall-only-oidc',
      },
      'gateway-token',
    );

    expect(runtime.gatewayEnv).toEqual({
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
      OPENCLAW_SLACK_HOST_BRIDGE_TOKEN: 'host-bridge-token',
    });
    expect(runtime.configOperations).toEqual(
      expect.arrayContaining([
        { path: 'channels.slack.enabled', value: true },
        { path: 'channels.slack.mode', value: 'http' },
        { path: 'channels.slack.streaming.mode', value: 'off' },
        {
          path: 'channels.slack.hostBridge.apiUrl',
          value: 'https://host.example/api/slack-proxy/',
        },
        {
          path: 'channels.slack.hostBridge.authToken',
          value: {
            source: 'env',
            provider: 'default',
            id: 'OPENCLAW_SLACK_HOST_BRIDGE_TOKEN',
          },
        },
        { path: 'channels.slack.webhookPath', value: '/slack/events' },
      ]),
    );
    const paths = runtime.configOperations.map((operation) => operation.path);
    expect(paths).not.toContain('channels.slack.allowFrom');
    expect(paths).not.toContain('channels.slack.dmPolicy');
    expect(paths).not.toContain('channels.slack.groupPolicy');
    expect(JSON.stringify(runtime)).not.toContain('must-not-enter-the-vm');
    expect(JSON.stringify(runtime)).not.toContain('must-also-stay-out');
    expect(JSON.stringify(runtime)).not.toContain('firewall-only-oidc');
  });

  it('rejects a partial native Slack bridge configuration', () => {
    expect(() =>
      buildOpenClawRuntime(
        { OPENCLAW_SLACK_HOST_BRIDGE_TOKEN: 'host-bridge-token' },
        'gateway-token',
      ),
    ).toThrow(
      /OPENCLAW_SLACK_HOST_BRIDGE_TOKEN and OPENCLAW_SLACK_HOST_BRIDGE_API_URL/,
    );
  });

  it('changes the persistent fingerprint when the host assertion rotates', () => {
    const environment = {
      OPENCLAW_SLACK_HOST_BRIDGE_API_URL: 'https://host.example/api/slack-proxy/',
    };
    const first = buildOpenClawRuntime(
      { ...environment, OPENCLAW_SLACK_HOST_BRIDGE_TOKEN: 'first' },
      'gateway-token',
    );
    const second = buildOpenClawRuntime(
      { ...environment, OPENCLAW_SLACK_HOST_BRIDGE_TOKEN: 'second' },
      'gateway-token',
    );

    expect(first.fingerprint).not.toBe(second.fingerprint);
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
