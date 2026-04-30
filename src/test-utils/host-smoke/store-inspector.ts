/**
 * Store inspectors for L4-host smoke scenarios.
 *
 * The slack webhook keys pending-boot ts under
 * `channels:slack:pending-boot:<channelId>[:<scope>]`. Cleanup on bot reply
 * derives `scope` from the bot reply's threadTs, falling back to the bot
 * reply's own ts when no thread exists. That fallback is the bug that leaves
 * "🦞 Almost ready…" placeholders dangling.
 *
 * These helpers let scenarios assert *exactly which* candidate keys still hold
 * pending-boot ts after a wake roundtrip — without reaching into Store
 * internals or duplicating keyspace logic.
 */

import {
  channelPendingBootMessageKey,
  channelPendingBootMessageLockKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

function pendingBootTsList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}

export type PendingBootEntry = {
  key: string;
  scope: string | undefined;
  bootTsList: string[];
};

/**
 * Read the pending-boot entry for a single (channel, channelId, scope?) tuple.
 * Returns null if the key is unset.
 */
export async function readPendingBootEntry(
  channel: "slack" | "telegram" | "discord",
  channelId: string,
  scope?: string,
): Promise<PendingBootEntry | null> {
  const key = channelPendingBootMessageKey(channel, channelId, scope);
  const raw = await getStore().getValue<unknown>(key);
  if (raw == null) return null;
  return { key, scope, bootTsList: pendingBootTsList(raw) };
}

/**
 * Read pending-boot entries for several candidate scopes at once. Useful for
 * asserting that *no* candidate scope (user ts, bot reply ts, threaded root)
 * has lingering pending-boot state after cleanup should have fired.
 */
export async function readPendingBootEntries(
  channel: "slack" | "telegram" | "discord",
  channelId: string,
  scopes: ReadonlyArray<string | undefined>,
): Promise<PendingBootEntry[]> {
  const seen = new Set<string>();
  const results: PendingBootEntry[] = [];
  for (const scope of scopes) {
    const key = channelPendingBootMessageKey(channel, channelId, scope);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = await readPendingBootEntry(channel, channelId, scope);
    if (entry) results.push(entry);
  }
  return results;
}

/**
 * True iff at least one candidate scope still holds pending-boot ts.
 * Lets a scenario assert `expect(hasAnyPendingBoot).toBe(false)` after wake.
 */
export async function hasAnyPendingBoot(
  channel: "slack" | "telegram" | "discord",
  channelId: string,
  scopes: ReadonlyArray<string | undefined>,
): Promise<boolean> {
  const entries = await readPendingBootEntries(channel, channelId, scopes);
  return entries.some((e) => e.bootTsList.length > 0);
}

/** Lock-key counterpart for completeness. */
export function pendingBootLockKey(
  channel: "slack" | "telegram" | "discord",
  channelId: string,
  scope?: string,
): string {
  return channelPendingBootMessageLockKey(channel, channelId, scope);
}
