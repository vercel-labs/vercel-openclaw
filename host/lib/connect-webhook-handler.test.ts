import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createConnectWebhookHandler,
  type BackgroundConnectWebhook,
} from './connect-webhook-handler';

describe('createConnectWebhookHandler', () => {
  it('acknowledges after Connect verification and schedules the exact raw envelope', async () => {
    const rawBody = '{"type":"event_callback","event_id":"Ev1","event":{"type":"app_mention"}}';
    const scheduled: Array<() => void | Promise<void>> = [];
    const verify = vi.fn(async () => true);
    const processVerifiedWebhook = vi.fn(async (_message: BackgroundConnectWebhook) => {});
    const handler = createConnectWebhookHandler({
      verify,
      schedule: (task) => scheduled.push(task),
      processVerifiedWebhook,
      now: () => 1_700_000_000_000,
    });
    const request = new NextRequest('https://example.com/api/slack', {
      method: 'POST',
      headers: {
        authorization: 'Bearer verified-connect-oidc',
        'content-type': 'application/json',
      },
      body: rawBody,
    });

    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(processVerifiedWebhook).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(request, rawBody);
    await scheduled[0]();
    const forwarded = processVerifiedWebhook.mock.calls[0][0];
    expect(Buffer.from(forwarded.rawBody).toString('utf8')).toBe(rawBody);
    expect(forwarded.vercelOidcToken).toBe('verified-connect-oidc');
  });

  it('does not schedule work when Connect verification fails', async () => {
    const schedule = vi.fn();
    const handler = createConnectWebhookHandler({
      verify: vi.fn(async () => {
        throw new Error('bad OIDC');
      }),
      schedule,
      processVerifiedWebhook: vi.fn(async () => {}),
    });
    const request = new NextRequest('https://example.com/api/slack', {
      method: 'POST',
      headers: { authorization: 'Bearer rejected' },
      body: '{}',
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
    expect(schedule).not.toHaveBeenCalled();
  });
});
