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
  // Return type widened deliberately: `ts` is optional on the real helper, and
  // one test covers a successful send that carries no usable timestamp.
  postSlackReply: vi.fn(async (): Promise<{ ts?: string }> => ({ ts: 'placeholder-ts' })),
  updateSlackMessage: vi.fn(async () => undefined),
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
  THINKING_TEXT: '_Thinking…_',
  postSlackReply: mocks.postSlackReply,
  updateSlackMessage: mocks.updateSlackMessage,
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
    mocks.postSlackReply.mockReset().mockResolvedValue({ ts: 'placeholder-ts' });
    mocks.updateSlackMessage.mockReset().mockResolvedValue(undefined);
    mocks.tasks.length = 0;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
    process.env.SLACK_CONNECTOR = 'slack/openclaw';
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

  it('posts the thinking placeholder before waking, then edits it into the answer', async () => {
    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    await mocks.tasks[0]();

    // The placeholder is the whole point of the glimmer: it has to be in the
    // thread before the ~10s wake, not after it.
    expect(mocks.postSlackReply).toHaveBeenCalledWith({
      token: 'connect-token',
      channelId: 'C123',
      threadTs: '1.0',
      text: '_Thinking…_',
      budget: mocks.budget,
    });
    expect(mocks.postSlackReply.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureAwake.mock.invocationCallOrder[0],
    );

    // And the answer edits that same message rather than adding a second one, so
    // the thread stays one question and one answer.
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith({
      token: 'connect-token',
      channelId: 'C123',
      ts: 'placeholder-ts',
      text: 'hello from OpenClaw',
      budget: mocks.budget,
    });
    expect(mocks.postSlackReply).toHaveBeenCalledTimes(1);
  });

  it('posts the placeholder before activity bookkeeping can stall', async () => {
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
      vi.waitFor(() => expect(mocks.postSlackReply).toHaveBeenCalled(), {
        interval: 1,
        timeout: 20,
      }).then(() => 'posted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);

    releaseActivity?.();
    await turn;
    expect(outcome).toBe('posted');
    expect(mocks.postSlackReply.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activitySet.mock.invocationCallOrder[0],
    );
  });

  it('falls back to a fresh message when the placeholder never posted', async () => {
    // A placeholder that fails must not swallow the answer, and a successful
    // send with no usable ts must not be treated as editable.
    mocks.postSlackReply
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValueOnce({ ts: undefined });

    await POST(
      new NextRequest('https://example.test/api/slack', {
        method: 'POST',
        headers: { authorization: 'Bearer verified-runtime-oidc-token' },
        body: '{}',
      }),
    );

    await mocks.tasks[0]();

    expect(mocks.updateSlackMessage).not.toHaveBeenCalled();
    expect(mocks.postSlackReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'hello from OpenClaw' }),
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
    // Edited into the placeholder, so a failed turn cannot leave "Thinking…" as
    // the last word in the thread.
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: 'placeholder-ts',
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
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: 'placeholder-ts',
        text: 'Something went wrong handling that. Check the logs.',
      }),
    );
  });
});
