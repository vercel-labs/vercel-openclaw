import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createConnectWebhookHandler,
  type BackgroundConnectWebhook,
} from './connect-webhook-handler';

describe('createConnectWebhookHandler', () => {
  it('acknowledges after Connect verification and schedules the exact raw envelope', async () => {
    const rawBody =
      '{ "type": "event_callback", "event_id": "Ev1", "event": { "type": "app_mention" } }\n';
    const scheduled: Array<() => void | Promise<void>> = [];
    const verify = vi.fn(async () => true);
    const processVerifiedWebhook = vi.fn(async (message: BackgroundConnectWebhook) => {
      void message;
    });
    const logger = vi.fn();
    const handler = createConnectWebhookHandler({
      verify,
      schedule: (task) => scheduled.push(task),
      processVerifiedWebhook,
      logger,
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
    expect(logger).toHaveBeenCalledWith({
      event: 'slack_ingress_verified',
      eventId: 'Ev1',
      rawBodySha256: 'b66d74888b1af98ea649b9111f5c51a7e74c100e8a7aaae6eb045ee1dbe78f58',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(
      /verified-connect-oidc|app_mention|authorization/i,
    );
    await scheduled[0]();
    const forwarded = processVerifiedWebhook.mock.calls[0][0];
    expect(Buffer.from(forwarded.rawBody).toString('utf8')).toBe(rawBody);
    expect(forwarded.oidcToken).toBe('verified-connect-oidc');
    expect(forwarded.headers.has('authorization')).toBe(false);
  });

  it('does not schedule work when Connect verification fails', async () => {
    const schedule = vi.fn();
    const logger = vi.fn();
    const handler = createConnectWebhookHandler({
      verify: vi.fn(async () => {
        throw new Error('bad OIDC');
      }),
      schedule,
      processVerifiedWebhook: vi.fn(async () => {}),
      logger,
    });
    const request = new NextRequest('https://example.com/api/slack', {
      method: 'POST',
      headers: { authorization: 'Bearer rejected' },
      body: '{}',
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
    expect(schedule).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });

  it('rejects a verified request that has no bearer to broker at the firewall', async () => {
    const schedule = vi.fn();
    const logger = vi.fn();
    const handler = createConnectWebhookHandler({
      verify: vi.fn(async () => true),
      schedule,
      processVerifiedWebhook: vi.fn(async () => {}),
      logger,
    });

    const response = await handler(
      new NextRequest('https://example.com/api/slack', {
        method: 'POST',
        body: '{"type":"event_callback","event_id":"Ev-not-accepted"}',
      }),
    );

    expect(response.status).toBe(401);
    expect(schedule).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });
});
