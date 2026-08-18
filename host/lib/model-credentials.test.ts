import { afterEach, describe, expect, it } from 'vitest';
import { AI_GATEWAY_DOMAIN, buildNetworkPolicy, readOidcToken } from './model-credentials';

describe('readOidcToken', () => {
  const original = process.env.VERCEL_OIDC_TOKEN;
  const originalAllowedDomains = process.env.OPENCLAW_ALLOWED_DOMAINS;

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = original;
    if (originalAllowedDomains === undefined) delete process.env.OPENCLAW_ALLOWED_DOMAINS;
    else process.env.OPENCLAW_ALLOWED_DOMAINS = originalAllowedDomains;
  });

  it('prefers the request-scoped Function token over the local env fallback', () => {
    process.env.VERCEL_OIDC_TOKEN = 'local-token';
    expect(readOidcToken('request-token')).toBe('request-token');
  });

  it('allows only AI Gateway even when a legacy extra-domain variable is present', () => {
    process.env.OPENCLAW_ALLOWED_DOMAINS = 'example.com';
    const policy = buildNetworkPolicy('request-token') as {
      allow: Record<string, unknown>;
    };
    expect(Object.keys(policy.allow)).toEqual([AI_GATEWAY_DOMAIN]);
  });

  it('allows the native Slack host bridge without injecting model credentials there', () => {
    const policy = buildNetworkPolicy(
      'request-token',
      'https://host.example/api/slack-proxy/',
    ) as { allow: Record<string, unknown[]> };

    expect(Object.keys(policy.allow)).toEqual([AI_GATEWAY_DOMAIN, 'host.example']);
    expect(JSON.stringify(policy.allow[AI_GATEWAY_DOMAIN])).toContain(
      'Bearer request-token',
    );
    expect(policy.allow['host.example']).toEqual([]);
  });

  it('rejects a non-HTTPS native Slack host bridge', () => {
    expect(() =>
      buildNetworkPolicy('request-token', 'http://host.example/api/slack-proxy/'),
    ).toThrow(/must be an HTTPS URL/);
  });

  it('rejects the AI Gateway hostname as the native Slack host bridge', () => {
    expect(() =>
      buildNetworkPolicy(
        'request-token',
        `https://${AI_GATEWAY_DOMAIN}/api/slack-proxy/`,
      ),
    ).toThrow(/must not use the AI Gateway hostname/);
  });
});
