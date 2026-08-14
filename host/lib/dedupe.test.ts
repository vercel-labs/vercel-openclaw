import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDedupeStore, RedisDedupeStore, claimEvent, type DedupeStore } from './dedupe';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('InMemoryDedupeStore', () => {
  it('claims an id once', async () => {
    const store = new InMemoryDedupeStore();
    expect(await store.claim('Ev123')).toBe(true);
    expect(await store.claim('Ev123')).toBe(false);
  });

  it('keeps different ids independent', async () => {
    const store = new InMemoryDedupeStore();
    expect(await store.claim('Ev1')).toBe(true);
    expect(await store.claim('Ev2')).toBe(true);
  });

  it('lets an id be claimed again once its ttl has passed', async () => {
    vi.useFakeTimers();
    const store = new InMemoryDedupeStore();
    expect(await store.claim('Ev1', 60)).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(await store.claim('Ev1', 60)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(await store.claim('Ev1', 60)).toBe(true);
  });
});

describe('RedisDedupeStore', () => {
  it('uses an atomic SET NX EX rather than a racy read-then-write', async () => {
    const calls: unknown[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ result: 'OK' }) };
    });

    const store = new RedisDedupeStore('https://redis.example', 'token');
    expect(await store.claim('Ev123', 900)).toBe(true);
    expect(calls[0]).toEqual(['SET', 'openclaw:event:Ev123', '1', 'NX', 'EX', '900']);
    expect(timeout).toHaveBeenCalledWith(1_000);
  });

  it('treats a nil result as already claimed', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ result: null }) }));
    const store = new RedisDedupeStore('https://redis.example', 'token');
    expect(await store.claim('Ev123')).toBe(false);
  });

  it('throws on a transport failure so the caller can decide', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const store = new RedisDedupeStore('https://redis.example', 'token');
    await expect(store.claim('Ev123')).rejects.toThrow(/dedupe store request failed: 500/);
  });
});

describe('claimEvent', () => {
  const alwaysClaimed: DedupeStore = { claim: async () => false };
  const throwing: DedupeStore = {
    claim: async () => {
      throw new Error('redis down');
    },
  };

  it('processes an event with no id, since there is nothing to dedupe on', async () => {
    expect(await claimEvent(undefined, alwaysClaimed)).toBe(true);
  });

  it('skips an event that was already claimed', async () => {
    expect(await claimEvent('Ev1', alwaysClaimed)).toBe(false);
  });

  it('fails OPEN when the store is unreachable', async () => {
    // A duplicate reply is a visible annoyance; a dropped message looks like the
    // agent ignored the user. Prefer the annoyance.
    expect(await claimEvent('Ev1', throwing)).toBe(true);
  });
});
