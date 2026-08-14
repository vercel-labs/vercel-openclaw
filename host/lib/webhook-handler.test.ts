import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookHandler, type BackgroundWebhook } from './webhook-handler';

const NOW = 1_700_000_000_000;
const SECRET = 'slack-signing-secret';

function slackRequest(
  body: string,
  secret = SECRET,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const timestamp = String(NOW / 1000);
  const signature = `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return new NextRequest('https://example.com/api/webhook/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
      ...extraHeaders,
    },
    body,
  });
}

describe('createWebhookHandler', () => {
  it('acknowledges a verified Slack event before background processing starts', async () => {
    const scheduled: Array<() => void | Promise<void>> = [];
    const processVerifiedWebhook = vi.fn(async (_message: BackgroundWebhook) => {});
    const handler = createWebhookHandler({
      schedule: (task) => scheduled.push(task),
      processVerifiedWebhook,
      getSlackSigningSecret: () => SECRET,
      now: () => NOW,
    });

    const response = await handler(
      slackRequest(
        JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } }),
        SECRET,
        { 'x-vercel-oidc-token': 'request-oidc-token' },
      ),
      { params: Promise.resolve({ channel: 'slack' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(processVerifiedWebhook).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    await scheduled[0]();
    expect(processVerifiedWebhook).toHaveBeenCalledOnce();
    expect(processVerifiedWebhook.mock.calls[0][0]).toMatchObject({
      channel: 'slack',
      receivedAt: NOW,
      vercelOidcToken: 'request-oidc-token',
    });
  });

  it('rejects an invalid signature without scheduling a sandbox wake', async () => {
    const schedule = vi.fn();
    const processVerifiedWebhook = vi.fn(async () => {});
    const handler = createWebhookHandler({
      schedule,
      processVerifiedWebhook,
      getSlackSigningSecret: () => SECRET,
      now: () => NOW,
    });

    const response = await handler(slackRequest('{}', 'wrong-secret'), {
      params: Promise.resolve({ channel: 'slack' }),
    });

    expect(response.status).toBe(401);
    expect(schedule).not.toHaveBeenCalled();
    expect(processVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('returns Slack URL verification challenges synchronously', async () => {
    const schedule = vi.fn();
    const handler = createWebhookHandler({
      schedule,
      processVerifiedWebhook: vi.fn(async () => {}),
      getSlackSigningSecret: () => SECRET,
      now: () => NOW,
    });
    const request = new NextRequest('https://example.com/api/webhook/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'challenge-value' }),
    });

    const response = await handler(request, {
      params: Promise.resolve({ channel: 'slack' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: 'challenge-value' });
    expect(schedule).not.toHaveBeenCalled();
  });
});
