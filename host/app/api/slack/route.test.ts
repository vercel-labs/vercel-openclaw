import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  budget: { deadlineMs: 281_000, replyReserveMs: 15_000 },
  tasks: [] as Array<() => Promise<void> | void>,
  verify: vi.fn(async () => undefined),
  getToken: vi.fn(async () => 'connect-token'),
  accessDecision: vi.fn(
    (): { allowed: boolean; reason?: string } => ({ allowed: true }),
  ),
  claimEvent: vi.fn(async () => true),
  activitySet: vi.fn(async () => undefined),
  ensureAwake: vi.fn(async () => ({ sandbox: {} })),
  topUpSessionTimeout: vi.fn(async () => undefined),
  slackSessionKey: vi.fn(() => 'agent:main:slack-C123'),
  runAgentTurn: vi.fn(async () => ({ reply: 'hello from OpenClaw' })),
  postSlackReaction: vi.fn(async () => undefined),
  removeSlackReaction: vi.fn(async () => undefined),
  postSlackReply: vi.fn(async () => undefined),
  processVerifiedSlackWebhook: vi.fn(async (message: unknown) => {
    void message;
  }),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: vi.fn((task: () => Promise<void> | void) => mocks.tasks.push(task)),
  };
});

vi.mock('@vercel/connect', () => ({ getToken: mocks.getToken }));
vi.mock('@vercel/connect/chat', () => ({
  createConnectWebhookVerifier: () => mocks.verify,
}));
vi.mock('@/lib/access', () => ({ decideAccess: mocks.accessDecision }));
vi.mock('@/lib/activity-store', () => ({
  defaultActivityStore: { set: mocks.activitySet },
}));
vi.mock('@/lib/agent', () => ({
  slackSessionKey: mocks.slackSessionKey,
  runAgentTurn: mocks.runAgentTurn,
}));
vi.mock('@/lib/dedupe', () => ({ claimEvent: mocks.claimEvent }));
vi.mock('@/lib/execution-budget', () => ({
  createExecutionBudget: () => mocks.budget,
  withExecutionBudget: async (
    _budget: unknown,
    _phase: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) => operation(new AbortController().signal),
}));
vi.mock('@/lib/slack', () => ({
  parseSlackEvent: () => ({
    handle: true,
    message: {
      eventId: 'Ev123',
      userId: 'U123',
      channelId: 'C123',
      messageTs: '1.0',
      threadTs: '1.0',
      text: 'hello',
    },
  }),
  postSlackReaction: mocks.postSlackReaction,
  postSlackReply: mocks.postSlackReply,
  removeSlackReaction: mocks.removeSlackReaction,
}));
vi.mock('../../../lib/slack-connect-processor', () => ({
  processVerifiedSlackWebhook: mocks.processVerifiedSlackWebhook,
}));
vi.mock('@/lib/wake', () => ({
  ensureAwake: mocks.ensureAwake,
  topUpSessionTimeout: mocks.topUpSessionTimeout,
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

describe('POST /api/slack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReset().mockResolvedValue(undefined);
    mocks.getToken.mockReset().mockResolvedValue('connect-token');
    mocks.accessDecision.mockReset().mockReturnValue({ allowed: true });
    mocks.claimEvent.mockReset().mockResolvedValue(true);
    mocks.activitySet.mockReset().mockResolvedValue(undefined);
    mocks.ensureAwake.mockReset().mockResolvedValue({ sandbox: {} });
    mocks.topUpSessionTimeout.mockReset().mockResolvedValue(undefined);
    mocks.slackSessionKey.mockReset().mockReturnValue('agent:main:slack-C123');
    mocks.runAgentTurn
      .mockReset()
      .mockResolvedValue({ reply: 'hello from OpenClaw' });
    mocks.postSlackReaction.mockReset().mockResolvedValue(undefined);
    mocks.removeSlackReaction.mockReset().mockResolvedValue(undefined);
    mocks.postSlackReply.mockReset().mockResolvedValue(undefined);
    mocks.processVerifiedSlackWebhook.mockReset().mockResolvedValue(undefined);
    mocks.tasks.length = 0;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
    process.env.SLACK_CONNECTOR = 'slack/openclaw';
    delete process.env.OPENCLAW_SLACK_HOST_BRIDGE_TOKEN;
    delete process.env.OPENCLAW_SLACK_HOST_BRIDGE_API_URL;
  });

  it('rejects an unverified delivery before access checks or wake work', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('bad token'));

    const response = await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.accessDecision).not.toHaveBeenCalled();
    expect(mocks.claimEvent).not.toHaveBeenCalled();
    expect(mocks.tasks).toHaveLength(0);
  });

  it('does not schedule denied or duplicate events', async () => {
    mocks.accessDecision.mockReturnValueOnce({ allowed: false, reason: 'not_allowed' });
    const denied = await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );
    expect(denied.status).toBe(200);
    expect(mocks.claimEvent).not.toHaveBeenCalled();
    expect(mocks.tasks).toHaveLength(0);

    mocks.accessDecision.mockReturnValueOnce({ allowed: true });
    mocks.claimEvent.mockResolvedValueOnce(false);
    const duplicate = await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );
    expect(duplicate.status).toBe(200);
    expect(mocks.tasks).toHaveLength(0);
  });

  it('passes the request-scoped OIDC token and one deadline into the scheduled turn', async () => {
    const response = await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: {
          authorization: 'Bearer verified-runtime-oidc-token',
          'x-vercel-oidc-token': 'unverified-header-value',
        },
        body: JSON.stringify({ type: 'event_callback' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.tasks).toHaveLength(1);
    await mocks.tasks[0]();

    expect(mocks.ensureAwake).toHaveBeenCalledWith('openclaw', {
      oidcToken: 'verified-runtime-oidc-token',
      budget: mocks.budget,
    });
    expect(mocks.topUpSessionTimeout).toHaveBeenCalledWith({}, mocks.budget);
    expect(mocks.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ budget: mocks.budget }),
    );
    // Channel only: one shared session per channel, not one per person.
    expect(mocks.slackSessionKey).toHaveBeenCalledWith('C123');
    expect(mocks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ budget: mocks.budget }),
    );
    expect(mocks.getToken).toHaveBeenCalledWith(
      'slack/openclaw',
      {
        subject: { type: 'app' },
        scopes: ['chat:write', 'reactions:write'],
      },
      { vercelToken: 'verified-runtime-oidc-token' },
    );
  });

  it('routes a verified native-mode envelope without invoking openclaw agent', async () => {
    process.env.OPENCLAW_SLACK_HOST_BRIDGE_TOKEN = 'host-bridge-token';
    process.env.OPENCLAW_SLACK_HOST_BRIDGE_API_URL =
      'https://host.example/api/slack-proxy/';
    const rawBody =
      '{ "type": "event_callback", "event_id": "Ev-native", "event": { "type": "app_mention" } }\n';

    const response = await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: {
          authorization: 'Bearer verified-runtime-oidc-token',
          'content-type': 'application/json',
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.tasks).toHaveLength(1);
    expect(mocks.accessDecision).not.toHaveBeenCalled();
    expect(mocks.claimEvent).not.toHaveBeenCalled();
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();

    await mocks.tasks[0]();
    expect(mocks.processVerifiedSlackWebhook).toHaveBeenCalledOnce();
    const forwarded = mocks.processVerifiedSlackWebhook.mock.calls[0]![0] as {
      rawBody: ArrayBuffer;
      oidcToken: string;
      headers: Headers;
    };
    expect(Buffer.from(forwarded.rawBody).toString('utf8')).toBe(rawBody);
    expect(forwarded.oidcToken).toBe('verified-runtime-oidc-token');
    expect(forwarded.headers.has('authorization')).toBe(false);
  });

  it('acknowledges without waiting for the activity store', async () => {
    let releaseActivity!: () => void;
    mocks.activitySet.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (releaseActivity = () => resolve(undefined))),
    );

    const responsePromise = POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );
    const outcome = await Promise.race([
      responsePromise.then(() => 'acknowledged'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 10)),
    ]);

    releaseActivity?.();
    await responsePromise;
    expect(outcome).toBe('acknowledged');
  });

  it('adds a visible reaction before waking the sandbox', async () => {
    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    await mocks.tasks[0]();

    expect(mocks.postSlackReaction).toHaveBeenCalledWith({
      token: 'connect-token',
      channelId: 'C123',
      messageTs: '1.0',
      name: 'eyes',
      budget: mocks.budget,
    });
    expect(mocks.postSlackReaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureAwake.mock.invocationCallOrder[0],
    );
    expect(mocks.removeSlackReaction).toHaveBeenCalledWith({
      token: 'connect-token',
      channelId: 'C123',
      messageTs: '1.0',
      name: 'eyes',
      budget: mocks.budget,
    });
    expect(mocks.postSlackReply.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeSlackReaction.mock.invocationCallOrder[0],
    );
  });

  it('adds the visible reaction before activity bookkeeping can stall', async () => {
    let releaseActivity!: () => void;
    mocks.activitySet.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (releaseActivity = () => resolve(undefined))),
    );
    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    const turn = Promise.resolve(mocks.tasks[0]());
    const outcome = await Promise.race([
      vi.waitFor(() => expect(mocks.postSlackReaction).toHaveBeenCalled(), {
        interval: 1,
        timeout: 20,
      }).then(() => 'reacted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);

    releaseActivity?.();
    await turn;
    expect(outcome).toBe('reacted');
    expect(mocks.postSlackReaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activitySet.mock.invocationCallOrder[0],
    );
  });

  it('posts a failure reply when required runtime configuration is missing', async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    await mocks.tasks[0]();
    expect(mocks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Something went wrong handling that. Check the logs.',
      }),
    );
  });

  it('posts a failure reply instead of silently dropping an empty agent result', async () => {
    mocks.runAgentTurn.mockResolvedValueOnce({ reply: '   ' });
    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    await mocks.tasks[0]();
    expect(mocks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Something went wrong handling that. Check the logs.',
      }),
    );
  });
});
