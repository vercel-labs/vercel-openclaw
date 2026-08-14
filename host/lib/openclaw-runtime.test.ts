import { describe, expect, it } from 'vitest';
import {
  buildOpenClawRuntime,
  DEFAULT_AGENT_MODEL,
  type RuntimeEnvironment,
} from './openclaw-runtime';

function environment(overrides: RuntimeEnvironment = {}): RuntimeEnvironment {
  return {
    SLACK_BOT_TOKEN: 'xoxb-bot-token',
    SLACK_SIGNING_SECRET: 'slack-signing-secret',
    VERCEL_OIDC_TOKEN: 'oidc-token-one',
    ...overrides,
  };
}

describe('buildOpenClawRuntime', () => {
  it('configures Slack HTTP mode with environment-backed secret references', () => {
    const runtime = buildOpenClawRuntime(environment(), 'gateway-token');

    expect(runtime.gatewayEnv).toMatchObject({
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
      SLACK_BOT_TOKEN: 'xoxb-bot-token',
      SLACK_SIGNING_SECRET: 'slack-signing-secret',
      AI_GATEWAY_API_KEY: 'oidc-token-one',
    });
    expect(runtime.configOperations).toEqual(
      expect.arrayContaining([
        { path: 'plugins.entries.slack.enabled', value: true },
        { path: 'channels.slack.enabled', value: true },
        { path: 'channels.slack.mode', value: 'http' },
        { path: 'channels.slack.webhookPath', value: '/slack/events' },
        {
          path: 'channels.slack.replyToModeByChatType.channel',
          value: 'all',
        },
        { path: 'channels.slack.slashCommand.enabled', value: true },
        { path: 'channels.slack.slashCommand.name', value: 'openclaw' },
        { path: 'plugins.entries.vercel-ai-gateway.enabled', value: true },
        {
          path: 'channels.slack.botToken',
          value: { source: 'env', provider: 'default', id: 'SLACK_BOT_TOKEN' },
        },
        {
          path: 'channels.slack.signingSecret',
          value: { source: 'env', provider: 'default', id: 'SLACK_SIGNING_SECRET' },
        },
        { path: 'agents.defaults.model.primary', value: DEFAULT_AGENT_MODEL },
      ]),
    );
    expect(JSON.stringify(runtime.configOperations)).not.toContain('xoxb-bot-token');
    expect(JSON.stringify(runtime.configOperations)).not.toContain('slack-signing-secret');
    expect(runtime.needsSlackPlugin).toBe(true);
    expect(runtime.needsAiGatewayPlugin).toBe(true);
  });

  it('prefers an explicit AI Gateway key over deployment OIDC', () => {
    const runtime = buildOpenClawRuntime(
      environment({ AI_GATEWAY_API_KEY: 'explicit-ai-key' }),
      'gateway-token',
    );

    expect(runtime.gatewayEnv.AI_GATEWAY_API_KEY).toBe('explicit-ai-key');
  });

  it('rejects partial Slack credentials instead of starting a broken adapter', () => {
    expect(() =>
      buildOpenClawRuntime(
        environment({ SLACK_BOT_TOKEN: undefined }),
        'gateway-token',
      ),
    ).toThrow(/SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be set together/);
  });

  it('rotates the gateway when its short-lived deployment OIDC token rotates', () => {
    const first = buildOpenClawRuntime(environment(), 'gateway-token');
    const second = buildOpenClawRuntime(
      environment({ VERCEL_OIDC_TOKEN: 'oidc-token-two' }),
      'gateway-token',
    );

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('accepts a request-scoped OIDC token from a Vercel Function', () => {
    const runtime = buildOpenClawRuntime(
      environment({ VERCEL_OIDC_TOKEN: undefined }),
      'gateway-token',
      { aiGatewayCredential: 'request-oidc-token' },
    );

    expect(runtime.gatewayEnv.AI_GATEWAY_API_KEY).toBe('request-oidc-token');
    expect(runtime.configOperations).toContainEqual({
      path: 'agents.defaults.model.primary',
      value: DEFAULT_AGENT_MODEL,
    });
  });
});
