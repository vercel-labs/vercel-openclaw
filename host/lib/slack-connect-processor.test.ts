import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activitySet: vi.fn(async () => {}),
  ensureAwake: vi.fn(async () => ({
    baseUrl: 'https://sandbox.example',
    sandbox: {
      expiresAt: undefined,
      extendTimeout: vi.fn(async () => {}),
    },
  })),
  forwardPayload: vi.fn(async () => new Response(null, { status: 200 })),
  topUpSessionTimeout: vi.fn(async () => {}),
}));

vi.mock('./activity-store', () => ({
  defaultActivityStore: { set: mocks.activitySet },
}));
vi.mock('./wake', () => ({
  ensureAwake: mocks.ensureAwake,
  forwardPayload: mocks.forwardPayload,
  topUpSessionTimeout: mocks.topUpSessionTimeout,
}));

import { processVerifiedSlackWebhook } from './slack-connect-processor';

describe('processVerifiedSlackWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GATEWAY_URL;
    process.env.OPENCLAW_SANDBOX_NAME = 'openclaw-connect-poc-main';
    process.env.OPENCLAW_SLACK_HOST_BRIDGE_TOKEN = 'host-bridge-token';
  });

  it('keeps the verified Connect bearer host-side for firewall brokering', async () => {
    await processVerifiedSlackWebhook({
      rawBody: new TextEncoder().encode('{"type":"event_callback"}').buffer as ArrayBuffer,
      headers: new Headers({ 'content-type': 'application/json' }),
      receivedAt: 1_700_000_000_000,
      oidcToken: 'verified-connect-oidc',
    });

    expect(mocks.ensureAwake).toHaveBeenCalledWith('openclaw-connect-poc-main', {
      oidcToken: 'verified-connect-oidc',
      exposeGatewayPort: true,
    });
    expect(mocks.topUpSessionTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: undefined }),
    );
  });
});
