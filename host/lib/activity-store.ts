/**
 * ActivityStore: the durable idle clock. Per docs/suspension-spec.md,
 * lastActivityAt is the basis of the idle timer.
 *
 * IMPORTANT: the webhook route and the idle-check cron compile to separate
 * serverless functions with separate memory, so the store MUST be external
 * for the idle path to work at all. The Redis-backed store activates when
 * KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN) are
 * set; without them the in-memory fallback makes the idle path a NO-OP in
 * production and logs a warning saying so.
 */
export interface ActivityStore {
  /** Record a host-visible activity event for a channel. */
  set(channel: string, timestampMs: number): Promise<void>;

  /** Most recent activity across all channels (the idle clock's input). */
  latest(): Promise<number | undefined>;
}

/** Single-instance development only; invisible across serverless functions. */
export class InMemoryActivityStore implements ActivityStore {
  private store = new Map<string, number>();

  async set(channel: string, timestampMs: number): Promise<void> {
    this.store.set(channel, timestampMs);
  }

  async latest(): Promise<number | undefined> {
    return this.store.size ? Math.max(...this.store.values()) : undefined;
  }
}

/**
 * Upstash-compatible REST Redis store (Vercel Marketplace Redis exposes the
 * same env vars). One hash holds per-channel timestamps.
 */
export class RedisActivityStore implements ActivityStore {
  constructor(
    private url: string,
    private token: string,
    private key = 'openclaw:activity',
  ) {}

  private async command(cmd: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`activity store request failed: ${res.status}`);
    }
    const data = (await res.json()) as { result?: unknown; error?: string };
    if (data.error) throw new Error(`activity store error: ${data.error}`);
    return data.result;
  }

  async set(channel: string, timestampMs: number): Promise<void> {
    await this.command(['HSET', this.key, channel, String(timestampMs)]);
  }

  async latest(): Promise<number | undefined> {
    const values = (await this.command(['HVALS', this.key])) as string[] | null;
    if (!values || values.length === 0) return undefined;
    return Math.max(...values.map(Number).filter((n) => Number.isFinite(n)));
  }
}

function createDefaultStore(): ActivityStore {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisActivityStore(url, token);
  console.warn(
    'activity store: no Redis configured (KV_REST_API_URL/KV_REST_API_TOKEN); ' +
      'falling back to in-memory. The idle-suspend path DOES NOT WORK across ' +
      'serverless functions without a durable store.',
  );
  return new InMemoryActivityStore();
}

/** Shared store used by the webhook route and the idle-check cron. */
export const defaultActivityStore = createDefaultStore();
