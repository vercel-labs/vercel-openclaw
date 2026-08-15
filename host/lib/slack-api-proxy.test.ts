import { describe, expect, it, vi } from 'vitest';
import { createSlackApiProxy, HOST_AUTH_HEADER } from './slack-api-proxy';

describe('createSlackApiProxy', () => {
  it('replaces host authentication with a short-lived Slack token', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-slack-req-id': 'req-1' },
        }),
    );
    const slackToken = vi.fn(async () => 'xoxb-short-lived');
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken,
      fetcher: fetcher as typeof fetch,
    });
    const request = new Request('https://host.example/api/slack-proxy/chat.postMessage', {
      method: 'POST',
      headers: {
        [HOST_AUTH_HEADER]: 'Bearer host-secret',
        authorization: 'Bearer openclaw-host-bridge',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'channel=C1&thread_ts=123.4&text=hello',
    });

    const response = await proxy(request, 'chat.postMessage');

    expect(response.status).toBe(200);
    expect(slackToken).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-short-lived');
    expect(new Headers(init?.headers).has(HOST_AUTH_HEADER)).toBe(false);
    expect(Buffer.from(init?.body as ArrayBuffer).toString('utf8')).toContain('thread_ts=123.4');
    expect(response.headers.get('x-slack-req-id')).toBe('req-1');
  });

  it('rejects an invalid host assertion before minting a Slack token', async () => {
    const slackToken = vi.fn(async () => 'xoxb-never-used');
    const fetcher = vi.fn();
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken,
      fetcher: fetcher as typeof fetch,
    });

    const response = await proxy(
      new Request('https://host.example/api/slack-proxy/auth.test', {
        method: 'POST',
        headers: { [HOST_AUTH_HEADER]: 'Bearer wrong' },
      }),
      'auth.test',
    );

    expect(response.status).toBe(401);
    expect(slackToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
