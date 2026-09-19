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
  release: vi.fn(async () => undefined),
  admitCodexEvent: vi.fn(),
  runCodexLifecycle: vi.fn(),
  // Return type widened deliberately: `ts` is optional on the real helper, and
  // one test covers a successful send that carries no usable timestamp.
  postSlackReply: vi.fn(async (): Promise<{ ts?: string }> => ({ ts: 'placeholder-ts' })),
  updateSlackMessage: vi.fn(async () => undefined),
  postSlackReaction: vi.fn(async () => undefined),
  removeSlackReaction: vi.fn(async () => undefined),
  setSlackSessionStatus: vi.fn<(options: { status: string }) => Promise<void>>(async () => undefined),
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
vi.mock('@/lib/codex-admission', () => ({ admitCodexEvent: mocks.admitCodexEvent }));
vi.mock('@/lib/codex-lifecycle', () => ({ runCodexLifecycle: mocks.runCodexLifecycle }));
vi.mock('@/lib/codex-diagnostics', () => import('../../../lib/codex-diagnostics'));
vi.mock('@/lib/codex-native-slack', () => import('../../../lib/codex-native-slack'));
vi.mock('@/lib/slack-status', () => ({ setSlackSessionStatus: mocks.setSlackSessionStatus }));
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
      messageTs: '2.0',
      threadTs: '1.0',
      text: 'hello',
    },
  }),
  THINKING_TEXT: '_Thinking…_',
  postSlackReply: mocks.postSlackReply,
  updateSlackMessage: mocks.updateSlackMessage,
  postSlackReaction: mocks.postSlackReaction,
  removeSlackReaction: mocks.removeSlackReaction,
}));
vi.mock('@/lib/wake', () => ({
  ensureAwake: mocks.ensureAwake,
  topUpSessionTimeout: mocks.topUpSessionTimeout,
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const nativeBody = { type: 'event_callback', event_id: 'Ev123', team_id: 'T123', event: { type: 'app_mention', user: 'U123', channel: 'C123', ts: '2.0', thread_ts: '1.0', text: 'hello' } };

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
    mocks.postSlackReaction.mockReset().mockResolvedValue(undefined);
    mocks.removeSlackReaction.mockReset().mockResolvedValue(undefined);
    mocks.setSlackSessionStatus.mockReset().mockResolvedValue(undefined);
    mocks.tasks.length = 0;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
    process.env.SLACK_CONNECTOR = 'slack/openclaw';
    delete process.env.OPENCLAW_ENGINE;
    delete process.env.OPENCLAW_CODEX_NATIVE_SLACK;
    process.env.OPENCLAW_NATIVE_SLACK_CONFIG = JSON.stringify({ teamId: 'T123', channels: ['C123'], users: ['U123'] });
    process.env.OPENCLAW_CODEX_SANDBOX_NAME = 'codex-test';
    mocks.admitCodexEvent.mockReset().mockResolvedValue({ status: 'accepted', release: mocks.release });
    mocks.runCodexLifecycle.mockReset().mockImplementation(async options => {
      await options.publish('Codex reply');
      return { sessionId: 'session', workerName: 'worker' };
    });
  });

  it('uses the Codex lifecycle and reacquires Connect credentials for the reply', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    const response = await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    expect(response.status).toBe(200);
    expect(mocks.runCodexLifecycle).not.toHaveBeenCalled();
    await mocks.tasks[0]();
    expect(mocks.runCodexLifecycle).toHaveBeenCalledWith(expect.objectContaining({ name: 'codex-test', sessionKey: 'agent:main:slack-C123', eventId: 'Ev123', oidcToken: 'verified-oidc' }));
    expect(mocks.getToken).toHaveBeenCalledTimes(2);
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Codex reply' }));
    expect(mocks.ensureAwake).not.toHaveBeenCalled();
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('forwards the full verified body for native Slack without a duplicate placeholder or reply', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    mocks.runCodexLifecycle.mockResolvedValue({ nativeSlackDelivered: true, sessionId: 'native', workerName: 'worker' });
    const rawBody = JSON.stringify({ ...nativeBody, event: { ...nativeBody.event, blocks: [{ type: 'section', text: 'retained' }] } });
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: rawBody }));
    await mocks.tasks[0]();
    expect(mocks.runCodexLifecycle).toHaveBeenCalledWith(expect.objectContaining({ nativeSlack: expect.objectContaining({ rawBody }) }));
    expect(mocks.postSlackReply).not.toHaveBeenCalled();
    expect(mocks.updateSlackMessage).not.toHaveBeenCalled();
    expect(mocks.postSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['DM', { ...nativeBody, event: { ...nativeBody.event, type: 'message', channel: 'D123', channel_type: 'im' } }],
    ['wrong channel', { ...nativeBody, event: { ...nativeBody.event, channel: 'C456' } }],
    ['wrong team', { ...nativeBody, team_id: 'T456' }],
    ['wrong native user', { ...nativeBody, event: { ...nativeBody.event, user: 'U456' } }],
    ['bot message', { ...nativeBody, event: { ...nativeBody.event, bot_id: 'B123' } }],
    ['message edit', { ...nativeBody, event: { ...nativeBody.event, subtype: 'message_changed' } }],
  ])('ignores native %s before admission or any Slack/Sandbox side effect', async (_label, body) => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    const response = await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: 'native_slack_not_allowed' });
    expect(mocks.tasks).toHaveLength(0);
    expect(mocks.admitCodexEvent).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.postSlackReaction).not.toHaveBeenCalled();
    expect(mocks.postSlackReply).not.toHaveBeenCalled();
    expect(mocks.runCodexLifecycle).not.toHaveBeenCalled();
    expect(mocks.setSlackSessionStatus).not.toHaveBeenCalled();
  });

  it('starts native working status immediately and clears it without changing native replies', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    mocks.runCodexLifecycle.mockResolvedValue({ nativeSlackDelivered: true, sessionId: 'native', workerName: 'worker' });
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(nativeBody) }));
    await mocks.tasks[0]();
    expect(mocks.setSlackSessionStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({ token: 'connect-token', channelId: 'C123', threadTs: '1.0', status: 'processing' }));
    expect(mocks.setSlackSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(mocks.runCodexLifecycle.mock.invocationCallOrder[0]);
    expect(mocks.setSlackSessionStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }));
    expect(mocks.postSlackReply).not.toHaveBeenCalled();
  });

  it('does not wait for native acknowledgements to start work and drains them before clearing', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    let finishStatus!: () => void;
    let finishEyes!: () => void;
    mocks.setSlackSessionStatus.mockImplementationOnce(() => new Promise(resolve => { finishStatus = resolve; }));
    mocks.postSlackReaction.mockImplementationOnce(() => new Promise(resolve => { finishEyes = () => resolve(undefined); }));
    mocks.runCodexLifecycle.mockResolvedValue({ nativeSlackDelivered: true, sessionId: 'native', workerName: 'worker' });
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(nativeBody) }));
    const running = mocks.tasks[0]();
    await vi.waitFor(() => expect(mocks.runCodexLifecycle).toHaveBeenCalled());
    expect(mocks.setSlackSessionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.removeSlackReaction).not.toHaveBeenCalled();
    finishStatus(); finishEyes();
    await running;
    expect(mocks.setSlackSessionStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }));
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each(['processing', 'active', 'runtime'])('cleans up native status and lease despite %s failure', async failure => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    mocks.runCodexLifecycle.mockResolvedValue({ nativeSlackDelivered: true, sessionId: 'native', workerName: 'worker' });
    mocks.setSlackSessionStatus.mockImplementation(async options => { if (options.status === failure) throw new Error('Slack unavailable'); });
    if (failure === 'runtime') mocks.runCodexLifecycle.mockRejectedValueOnce(new Error('startup failed'));
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(nativeBody) }));
    await mocks.tasks[0]();
    expect(mocks.runCodexLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.setSlackSessionStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }));
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.postSlackReply).toHaveBeenCalledTimes(failure === 'runtime' ? 1 : 0);
  });

  it.each([undefined, '{}', 'broken', '{"teamId":"T123","channels":[],"users":["U123"]}'])('fails closed for invalid native policy %s', async policy => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    if (policy === undefined) delete process.env.OPENCLAW_NATIVE_SLACK_CONFIG;
    else process.env.OPENCLAW_NATIVE_SLACK_CONFIG = policy;
    const response = await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(nativeBody) }));
    expect(response.status).toBe(503);
    expect(mocks.tasks).toHaveLength(0);
    expect(mocks.admitCodexEvent).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it('does not post a false failure after native delivery when stop confirmation fails', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    process.env.OPENCLAW_CODEX_NATIVE_SLACK = '1';
    mocks.runCodexLifecycle.mockImplementationOnce(async options => {
      options.onNativeDelivered?.();
      throw new Error('VM1 stop is not confirmed');
    });
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: JSON.stringify(nativeBody) }));
    await mocks.tasks[0]();
    expect(mocks.postSlackReply).not.toHaveBeenCalled();
    expect(mocks.updateSlackMessage).not.toHaveBeenCalled();
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('records credential-safe error details and event correlation for a host failure', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.runCodexLifecycle.mockRejectedValueOnce(new DOMException('Bearer private-token request-body', 'TimeoutError'));
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    await mocks.tasks[0]();
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain('TimeoutError');
    expect(output).toContain('Ev123');
    expect(output).not.toContain('private-token');
    expect(output).not.toContain('request-body');
    expect(mocks.release).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it.each([['busy', 503], ['duplicate', 200]])('does not wake for a %s Codex admission', async (status, expected) => {
    process.env.OPENCLAW_ENGINE = 'codex';
    mocks.admitCodexEvent.mockResolvedValue({ status, release: mocks.release });
    const response = await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    expect(response.status).toBe(expected);
    expect(mocks.tasks).toHaveLength(0);
    expect(mocks.postSlackReaction).not.toHaveBeenCalled();
  });

  it('adds eyes to the triggering message before waking and clears them with the fresh reply token', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    mocks.getToken.mockResolvedValueOnce('ack-token').mockResolvedValueOnce('reply-token');
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    expect(mocks.postSlackReaction).not.toHaveBeenCalled();
    await mocks.tasks[0]();
    expect(mocks.postSlackReaction).toHaveBeenCalledWith(expect.objectContaining({ token: 'ack-token', channelId: 'C123', messageTs: '2.0', name: 'eyes' }));
    expect(mocks.postSlackReaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.runCodexLifecycle.mock.invocationCallOrder[0]);
    expect(mocks.removeSlackReaction).toHaveBeenCalledWith(expect.objectContaining({ token: 'reply-token', channelId: 'C123', messageTs: '2.0', name: 'eyes' }));
    expect(mocks.removeSlackReaction.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.updateSlackMessage.mock.invocationCallOrder[0]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each(['runtime', 'reply'])('clears eyes after a Codex %s failure', async failure => {
    process.env.OPENCLAW_ENGINE = 'codex';
    if (failure === 'runtime') mocks.runCodexLifecycle.mockRejectedValueOnce(new Error('runtime failed'));
    else mocks.updateSlackMessage.mockRejectedValueOnce(new Error('reply failed'));
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    await mocks.tasks[0]();
    expect(mocks.updateSlackMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Something went wrong handling that. Check the logs.' }));
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('does not fail a Codex turn when adding eyes fails', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    mocks.postSlackReaction.mockRejectedValueOnce(new Error('missing_scope'));
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    await mocks.tasks[0]();
    expect(mocks.postSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Codex reply' }));
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('does not lose the reply or lease cleanup when removing eyes fails', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    mocks.removeSlackReaction.mockRejectedValueOnce(new Error('Slack unavailable'));
    await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    await mocks.tasks[0]();
    expect(mocks.removeSlackReaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateSlackMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Codex reply' }));
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rejects before acknowledging when Codex admission storage is unavailable', async () => {
    process.env.OPENCLAW_ENGINE = 'codex';
    mocks.admitCodexEvent.mockRejectedValue(new Error('unavailable'));
    const response = await POST(new NextRequest('https://example.test/api/slack', { method: 'POST', headers: { authorization: 'Bearer verified-oidc' }, body: '{}' }));
    expect(response.status).toBe(503);
    expect(mocks.tasks).toHaveLength(0);
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
