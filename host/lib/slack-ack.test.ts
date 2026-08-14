import { describe, expect, it, vi } from 'vitest';
import { addSlackAckReaction } from './slack-ack';

describe('addSlackAckReaction', () => {
  it('adds an eyes reaction to a Slack message event', async () => {
    const fetcher = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const rawBody = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', channel: 'C123', ts: '1234.5678' },
    });

    await expect(
      addSlackAckReaction(rawBody, 'xoxb-token', fetcher),
    ).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://slack.com/api/reactions.add');
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer xoxb-token' });
    expect(String(init.body)).toContain('channel=C123');
    expect(String(init.body)).toContain('timestamp=1234.5678');
    expect(String(init.body)).toContain('name=eyes');
  });

  it('skips payloads that do not identify a Slack message', async () => {
    const fetcher = vi.fn();

    await expect(
      addSlackAckReaction(JSON.stringify({ type: 'event_callback', event: {} }), 'token', fetcher),
    ).resolves.toEqual({ ok: false, skipped: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
