/**
 * ActivityStore interface for managing lastActivityAt timestamps.
 * Implementations track when activity last occurred (webhooks, UI requests, wake events).
 * Per suspension-spec.md, lastActivityAt is the idle timer's basis.
 */
export interface ActivityStore {
  /**
   * Get the last activity timestamp for a channel, or undefined if never seen.
   */
  get(channel: string): Promise<number | undefined>;

  /**
   * Set the last activity timestamp for a channel to now.
   */
  set(channel: string, timestampMs: number): Promise<void>;
}

/**
 * In-memory implementation of ActivityStore.
 * Suitable for single-instance development; not persistent across restarts.
 */
export class InMemoryActivityStore implements ActivityStore {
  private store = new Map<string, number>();

  async get(channel: string): Promise<number | undefined> {
    return this.store.get(channel);
  }

  async set(channel: string, timestampMs: number): Promise<void> {
    this.store.set(channel, timestampMs);
  }

  /** Most recent activity across all channels (the idle clock's input). */
  async latest(): Promise<number | undefined> {
    return this.store.size ? Math.max(...this.store.values()) : undefined;
  }
}

/**
 * Shared store instance so the webhook route and the idle-check cron read the
 * same clock. v1 LIMITATION: in-memory state is per serverless instance and
 * lost on cold start; production needs a KV/Redis-backed ActivityStore.
 */
export const defaultActivityStore = new InMemoryActivityStore();
