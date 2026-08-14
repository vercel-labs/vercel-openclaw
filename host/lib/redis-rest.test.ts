import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisRestClient, resolveRedisRestConfig } from './redis-rest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveRedisRestConfig', () => {
  it('prefers the Vercel Marketplace Redis variables', () => {
    expect(
      resolveRedisRestConfig({
        KV_REST_API_URL: 'https://kv.example',
        KV_REST_API_TOKEN: 'kv-token',
        UPSTASH_REDIS_REST_URL: 'https://upstash.example',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
      }),
    ).toEqual({ url: 'https://kv.example', token: 'kv-token' });
  });

  it('does not combine credentials from different integrations', () => {
    expect(
      resolveRedisRestConfig({
        KV_REST_API_URL: 'https://kv.example',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
      }),
    ).toBeUndefined();
  });
});

describe('RedisRestClient', () => {
  it('uses the configured timeout and returns the Redis result', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: 'OK' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RedisRestClient({
      url: 'https://redis.example',
      token: 'secret',
      timeoutMs: 1_000,
      label: 'dedupe store',
    });

    await expect(client.command(['PING'])).resolves.toBe('OK');
    expect(timeout).toHaveBeenCalledWith(1_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://redis.example',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify(['PING']),
      }),
    );
  });

  it('keeps transport and Redis errors attributable to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    const client = new RedisRestClient({
      url: 'https://redis.example',
      token: 'secret',
      timeoutMs: 5_000,
      label: 'activity store',
    });

    await expect(client.command(['PING'])).rejects.toThrow(
      'activity store request failed: 503',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ error: 'WRONGTYPE' }) })),
    );
    await expect(client.command(['PING'])).rejects.toThrow(
      'activity store error: WRONGTYPE',
    );
  });
});
