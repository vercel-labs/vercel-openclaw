import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryActivityStore, RedisActivityStore } from './activity-store';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InMemoryActivityStore', () => {
  it('returns the newest activity across channels', async () => {
    const store = new InMemoryActivityStore();
    expect(await store.latest()).toBeUndefined();
    await store.set('slack', 100);
    await store.set('cron', 200);
    expect(await store.latest()).toBe(200);
  });
});

describe('RedisActivityStore', () => {
  it('stores channel timestamps in one hash', async () => {
    let requestBody: BodyInit | null | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://redis.example');
      requestBody = init?.body;
      return {
        ok: true,
        json: async () => ({ result: 1 }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await new RedisActivityStore('https://redis.example', 'token').set('slack', 123);

    expect(JSON.parse(requestBody as string)).toEqual([
      'HSET',
      'openclaw:activity',
      'slack',
      '123',
    ]);
  });

  it('ignores malformed timestamps and returns undefined when none are valid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ['100', 'not-a-time', '200'] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ['not-a-time'] }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const store = new RedisActivityStore('https://redis.example', 'token');

    expect(await store.latest()).toBe(200);
    expect(await store.latest()).toBeUndefined();
  });
});
