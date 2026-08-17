/**
 * Exactly-once-ish delivery for forwarded Slack events.
 *
 * Two things make this necessary rather than nice to have:
 *
 *   - Vercel Connect retries a trigger delivery up to three times on a 5xx
 *     ("Requests that receive status 500, 502, 503, or 504 are attempted up to
 *     three times", vercel.com/docs/connect/concepts/triggers) and provides no
 *     delivery id of its own.
 *   - Waking a stopped sandbox takes ~10s, which is comfortably long enough to
 *     collide with a retry.
 *
 * Without a claim step, one Slack mention can start several agent turns, each
 * billing CPU and each posting its own reply. Slack's `event_id` is the natural
 * idempotency key: it is stable across Slack's own retries too.
 *
 * Deliberately fails OPEN. If the store is unreachable, the message is
 * processed: a duplicate reply is a visible annoyance, a dropped message looks
 * like the agent ignored someone. Same trade-off the webhook route already
 * makes for the idle clock.
 */

import { RedisRestClient, resolveRedisRestConfig } from './redis-rest';

const DEFAULT_TTL_SECONDS = 30 * 60;
// This claim remains on the acknowledgement path. Bound store degradation
// well below Connect/Slack delivery deadlines, then fail open as documented.
const CLAIM_TIMEOUT_MS = 1_000;
const KEY_PREFIX = 'openclaw:event:';

export interface DedupeStore {
  /**
   * Atomically claims an event id. Returns true when this caller is the first
   * to claim it and should process the event, false when it was already seen.
   */
  claim(eventId: string, ttlSeconds?: number): Promise<boolean>;
}

/** Single-instance development only; invisible across serverless functions. */
export class InMemoryDedupeStore implements DedupeStore {
  private seen = new Map<string, number>();

  async claim(eventId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    const now = Date.now();
    // Opportunistic sweep so a long-lived instance does not grow unbounded.
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + ttlSeconds * 1000);
    return true;
  }
}

/**
 * Upstash-compatible REST Redis store, matching lib/activity-store.ts.
 *
 * Uses `SET key 1 NX EX ttl`, which is atomic: exactly one concurrent caller
 * gets `OK` and every other gets nil. A read-then-write pair would race, which
 * is the precise failure mode being defended against.
 */
export class RedisDedupeStore implements DedupeStore {
  private readonly client: RedisRestClient;

  constructor(url: string, token: string) {
    this.client = new RedisRestClient({
      url,
      token,
      timeoutMs: CLAIM_TIMEOUT_MS,
      label: 'dedupe store',
    });
  }

  async claim(eventId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    const result = await this.client.command([
      'SET',
      `${KEY_PREFIX}${eventId}`,
      '1',
      'NX',
      'EX',
      String(ttlSeconds),
    ]);
    // "OK" when the key was created, null when it already existed.
    return result === 'OK';
  }
}

function createDefaultStore(): DedupeStore {
  const config = resolveRedisRestConfig();
  if (config) return new RedisDedupeStore(config.url, config.token);
  console.warn(
    'dedupe store: no Redis configured (KV_REST_API_URL/KV_REST_API_TOKEN); ' +
      'falling back to in-memory. Retried deliveries WILL start duplicate agent ' +
      'turns across serverless functions without a durable store.',
  );
  return new InMemoryDedupeStore();
}

export const defaultDedupeStore = createDefaultStore();

/**
 * Claims an event, treating a store failure as "process it".
 * Returns true when the caller should handle the event.
 */
export async function claimEvent(
  eventId: string | undefined,
  store: DedupeStore = defaultDedupeStore,
): Promise<boolean> {
  // No id means nothing to deduplicate on; process rather than drop.
  if (!eventId) return true;
  try {
    return await store.claim(eventId);
  } catch (err) {
    console.error('dedupe claim failed; processing anyway (may duplicate):', err);
    return true;
  }
}
