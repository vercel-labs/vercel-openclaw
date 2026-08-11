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
}
