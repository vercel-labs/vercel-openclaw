import type { ChannelName } from "@/shared/channels";
import { logError } from "@/server/log";
import {
  channelFailedIndexKey,
  channelFailedIndexLockKey,
  channelFailedKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

export const CHANNEL_DLQ_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
const CHANNEL_DLQ_INDEX_MAX = 500;

export type ChannelDlqPhase =
  | "workflow-start-failed"
  | "workflow-step-failed";

export type ChannelDlqRecord = {
  channel: ChannelName;
  deliveryId: string;
  phase: ChannelDlqPhase;
  terminal: boolean;
  retryable: boolean;
  requestId: string | null;
  errorName: string | null;
  errorMessage: string;
  firstFailedAt: number;
  failedAt: number;
  failureCount: number;
  receivedAtMs: number | null;
  ageMs: number | null;
  diag: Record<string, unknown>;
};

export type ChannelDlqIndexEntry = {
  channel: ChannelName;
  deliveryId: string;
  key: string;
  failedAt: number;
  phase: ChannelDlqPhase;
  terminal: boolean;
};

export async function recordChannelDlqFailure(input: {
  channel: ChannelName;
  deliveryId: string;
  phase: ChannelDlqPhase;
  terminal: boolean;
  retryable: boolean;
  requestId: string | null;
  receivedAtMs: number | null;
  error: unknown;
  diag?: Record<string, unknown>;
}): Promise<ChannelDlqRecord | null> {
  const key = channelFailedKey(input.channel, input.deliveryId);
  const now = Date.now();
  const store = getStore();
  const existing = await store
    .getValue<Partial<ChannelDlqRecord>>(key)
    .catch(() => null);
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const errorName =
    input.error instanceof Error ? input.error.name : null;
  const record: ChannelDlqRecord = {
    channel: input.channel,
    deliveryId: input.deliveryId,
    phase: input.phase,
    terminal: input.terminal,
    retryable: input.retryable,
    requestId: input.requestId,
    errorName,
    errorMessage,
    firstFailedAt:
      typeof existing?.firstFailedAt === "number"
        ? existing.firstFailedAt
        : now,
    failedAt: now,
    failureCount:
      typeof existing?.failureCount === "number"
        ? existing.failureCount + 1
        : 1,
    receivedAtMs: input.receivedAtMs,
    ageMs:
      typeof input.receivedAtMs === "number" ? now - input.receivedAtMs : null,
    diag: input.diag ?? {},
  };
  try {
    await store.setValue(key, record, CHANNEL_DLQ_RECORD_TTL_SECONDS);
  } catch (writeError) {
    logError("channels.dlq_record_write_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      phase: input.phase,
      error:
        writeError instanceof Error ? writeError.message : String(writeError),
    });
    return null;
  }
  // Index maintenance is best-effort. Record persistence must not
  // depend on the index being writable.
  await indexDlqRecord(record).catch((indexError) => {
    logError("channels.dlq_index_write_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      error:
        indexError instanceof Error ? indexError.message : String(indexError),
    });
  });
  return record;
}

export type ChannelDlqSummary = {
  indexSize: number;
  channelCounts: Record<ChannelName, number>;
  terminalCount: number;
  oldestFailedAt: number | null;
  newestFailedAt: number | null;
  unavailable?: boolean;
};

/**
 * Best-effort aggregate of the bounded DLQ index. Safe to call from
 * preflight / health routes — a store read failure returns an empty
 * summary with `unavailable: true` rather than throwing, so it never
 * flips a config preflight from ok to not-ok.
 */
export async function getChannelDlqSummary(): Promise<ChannelDlqSummary> {
  const base: ChannelDlqSummary = {
    indexSize: 0,
    channelCounts: { slack: 0, telegram: 0, whatsapp: 0, discord: 0 },
    terminalCount: 0,
    oldestFailedAt: null,
    newestFailedAt: null,
  };
  try {
    const store = getStore();
    const indexRaw = await store
      .getValue<ChannelDlqIndexEntry[] | null>(channelFailedIndexKey())
      .catch(() => null);
    const index: ChannelDlqIndexEntry[] = Array.isArray(indexRaw)
      ? indexRaw.filter((entry): entry is ChannelDlqIndexEntry => {
          return (
            entry != null &&
            typeof entry === "object" &&
            typeof (entry as ChannelDlqIndexEntry).key === "string" &&
            typeof (entry as ChannelDlqIndexEntry).channel === "string"
          );
        })
      : [];
    const summary: ChannelDlqSummary = {
      ...base,
      indexSize: index.length,
    };
    for (const entry of index) {
      if (entry.channel in summary.channelCounts) {
        summary.channelCounts[entry.channel] += 1;
      }
      if (entry.terminal) summary.terminalCount += 1;
      if (typeof entry.failedAt === "number") {
        if (
          summary.oldestFailedAt === null ||
          entry.failedAt < summary.oldestFailedAt
        ) {
          summary.oldestFailedAt = entry.failedAt;
        }
        if (
          summary.newestFailedAt === null ||
          entry.failedAt > summary.newestFailedAt
        ) {
          summary.newestFailedAt = entry.failedAt;
        }
      }
    }
    return summary;
  } catch {
    return { ...base, unavailable: true };
  }
}

async function indexDlqRecord(record: ChannelDlqRecord): Promise<void> {
  const store = getStore();
  const indexKey = channelFailedIndexKey();
  const lockKey = channelFailedIndexLockKey();
  const lockToken = await store.acquireLock(lockKey, 5).catch(() => null);
  try {
    const currentRaw = await store
      .getValue<ChannelDlqIndexEntry[] | null>(indexKey)
      .catch(() => null);
    const current: ChannelDlqIndexEntry[] = Array.isArray(currentRaw)
      ? currentRaw.filter((entry): entry is ChannelDlqIndexEntry => {
          return (
            entry != null &&
            typeof entry === "object" &&
            typeof (entry as ChannelDlqIndexEntry).key === "string"
          );
        })
      : [];
    const key = channelFailedKey(record.channel, record.deliveryId);
    const nextEntry: ChannelDlqIndexEntry = {
      channel: record.channel,
      deliveryId: record.deliveryId,
      key,
      failedAt: record.failedAt,
      phase: record.phase,
      terminal: record.terminal,
    };
    const next = [nextEntry, ...current.filter((e) => e.key !== key)].slice(
      0,
      CHANNEL_DLQ_INDEX_MAX,
    );
    await store.setValue(indexKey, next, CHANNEL_DLQ_RECORD_TTL_SECONDS);
  } finally {
    if (lockToken) {
      await store.releaseLock(lockKey, lockToken).catch(() => {});
    }
  }
}
