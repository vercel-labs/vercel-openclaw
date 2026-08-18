import { describe, expect, it, vi } from 'vitest';
import { createSlackApiProxy, HOST_AUTH_HEADER } from './slack-api-proxy';

describe('createSlackApiProxy', () => {
  it('replaces host authentication with a short-lived Slack token', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        void input;
        void init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-slack-req-id': 'req-1' },
        });
      },
    );
    const slackToken = vi.fn(async () => 'xoxb-short-lived');
    const logger = vi.fn();
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken,
      fetcher: fetcher as typeof fetch,
      logger,
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
    expect(logger).toHaveBeenCalledWith({
      event: 'slack_proxy_upstream',
      method: 'chat.postMessage',
      tokenSource: 'connect',
      status: 200,
      slackRequestId: 'req-1',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(
      /host-secret|xoxb-short-lived|openclaw-host-bridge|thread_ts|hello|authorization/i,
    );
  });

  it('removes Bolt-style token overrides before forwarding to Slack', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        void input;
        void init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken: async () => 'xoxb-short-lived',
      fetcher: fetcher as typeof fetch,
    });
    const request = new Request(
      'https://host.example/api/slack-proxy/auth.test?token=query-sentinel&team_id=T1',
      {
        method: 'POST',
        headers: {
          [HOST_AUTH_HEADER]: 'Bearer host-secret',
          authorization: 'Bearer openclaw-host-bridge',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'token=openclaw-host-bridge&foo=bar',
      },
    );

    await proxy(request, 'auth.test');

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://slack.com/api/auth.test?team_id=T1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-short-lived');
    expect(Buffer.from(init?.body as ArrayBuffer).toString('utf8')).toBe('foo=bar');
  });

  it('removes JSON token overrides while preserving method arguments', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        void input;
        void init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken: async () => 'xoxb-short-lived',
      fetcher: fetcher as typeof fetch,
    });

    await proxy(
      new Request('https://host.example/api/slack-proxy/chat.postMessage', {
        method: 'POST',
        headers: {
          [HOST_AUTH_HEADER]: 'Bearer host-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: 'sandbox-token', channel: 'C1', text: 'hello' }),
      }),
      'chat.postMessage',
    );

    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(Buffer.from(init?.body as ArrayBuffer).toString('utf8'))).toEqual({
      channel: 'C1',
      text: 'hello',
    });
  });

  it('removes multipart token overrides while preserving method arguments', async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        void input;
        void init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken: async () => 'xoxb-short-lived',
      fetcher: fetcher as typeof fetch,
    });
    const fields = new FormData();
    fields.set('token', 'sandbox-token');
    fields.set('channel', 'C1');

    await proxy(
      new Request('https://host.example/api/slack-proxy/files.upload', {
        method: 'POST',
        headers: { [HOST_AUTH_HEADER]: 'Bearer host-secret' },
        body: fields,
      }),
      'files.upload',
    );

    const [, init] = fetcher.mock.calls[0];
    const forwarded = new Request('https://slack.com/api/files.upload', {
      method: 'POST',
      headers: init?.headers,
      body: init?.body,
    });
    const forwardedFields = await forwarded.formData();
    expect(forwardedFields.get('token')).toBeNull();
    expect(forwardedFields.get('channel')).toBe('C1');
  });

  it('rejects unsupported bodies that cannot be credential-sanitized', async () => {
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
        headers: {
          [HOST_AUTH_HEADER]: 'Bearer host-secret',
          'content-type': 'text/plain',
        },
        body: 'token=sandbox-token',
      }),
      'auth.test',
    );

    expect(response.status).toBe(415);
    expect(slackToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an invalid host assertion before minting a Slack token', async () => {
    const slackToken = vi.fn(async () => 'xoxb-never-used');
    const fetcher = vi.fn();
    const logger = vi.fn();
    const proxy = createSlackApiProxy({
      bridgeToken: () => 'host-secret',
      slackToken,
      fetcher: fetcher as typeof fetch,
      logger,
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
    expect(logger).not.toHaveBeenCalled();
  });
});
