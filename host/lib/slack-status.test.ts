import { afterEach, expect, it, vi } from 'vitest';
import { setSlackSessionStatus } from './slack-status';

afterEach(() => vi.unstubAllGlobals());

it('uses the current native Slack API with the thread root and a bounded deadline', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await setSlackSessionStatus({ token: 'synthetic-secret', channelId: 'C123', threadTs: '1.0', status: 'processing' });
  expect(fetcher).toHaveBeenCalledWith('https://slack.com/api/agents.sessions.setStatus', expect.objectContaining({ method: 'POST', body: JSON.stringify({ channel_id: 'C123', thread_ts: '1.0', status: 'processing' }) }));
  expect(timeout).toHaveBeenCalledWith(3000);
  timeout.mockRestore();
});

it.each([Response.json({ ok: false, error: 'missing_scope' }), new Response('{}', { status: 503 })])('rejects an unsuccessful Slack response', async response => {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(setSlackSessionStatus({ token: 'synthetic-secret', channelId: 'C123', threadTs: '1.0', status: 'active' })).rejects.toThrow('Slack session status');
});
