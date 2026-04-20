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

// Poison-payload detection: when the same deliveryId fails many times
// in a short window, it's very likely a payload the step can never
// process (malformed fields, unsupported interaction type, etc.) rather
// than a transient infra blip. Alert once per deliveryId to avoid
// spamming logs on every redelivery after the threshold.
const CHANNEL_DLQ_POISON_THRESHOLD = 5;
const CHANNEL_DLQ_POISON_WINDOW_MS = 15 * 60 * 1000;

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
  // Timestamp of the poison-payload alert emitted for this deliveryId.
  // Null when no alert has fired yet; carried across upserts so each
  // poison payload produces exactly one `dlq_poison_payload_detected`
  // log, not one per redelivery.
  poisonAlertedAt: number | null;
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
  const firstFailedAt =
    typeof existing?.firstFailedAt === "number"
      ? existing.firstFailedAt
      : now;
  const failureCount =
    typeof existing?.failureCount === "number" ? existing.failureCount + 1 : 1;
  const previousPoisonAlertedAt =
    typeof existing?.poisonAlertedAt === "number"
      ? existing.poisonAlertedAt
      : null;
  // Only alert on the first threshold crossing, and only when the
  // failures are clustered inside the window. Rare per-week failures
  // that happen to accumulate over 30 days should NOT be flagged.
  const poisonWindowMs = now - firstFailedAt;
  const shouldEmitPoisonAlert =
    previousPoisonAlertedAt === null &&
    failureCount >= CHANNEL_DLQ_POISON_THRESHOLD &&
    poisonWindowMs <= CHANNEL_DLQ_POISON_WINDOW_MS;
  const record: ChannelDlqRecord = {
    channel: input.channel,
    deliveryId: input.deliveryId,
    phase: input.phase,
    terminal: input.terminal,
    retryable: input.retryable,
    requestId: input.requestId,
    errorName,
    errorMessage,
    firstFailedAt,
    failedAt: now,
    failureCount,
    receivedAtMs: input.receivedAtMs,
    ageMs:
      typeof input.receivedAtMs === "number" ? now - input.receivedAtMs : null,
    poisonAlertedAt: shouldEmitPoisonAlert ? now : previousPoisonAlertedAt,
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
  // Poison-payload alert fires once per deliveryId when failureCount
  // crosses the threshold inside a tight window. Durable record of
  // having alerted is carried on poisonAlertedAt so the next retry
  // won't re-fire. Log AFTER the successful write so alerting
  // necessarily reflects durable state.
  if (shouldEmitPoisonAlert) {
    logError("channels.dlq_poison_payload_detected", {
      channel: record.channel,
      deliveryId: record.deliveryId,
      phase: record.phase,
      terminal: record.terminal,
      retryable: record.retryable,
      requestId: record.requestId,
      failureCount: record.failureCount,
      firstFailedAt: record.firstFailedAt,
      failedAt: record.failedAt,
      poisonWindowMs,
      poisonThreshold: CHANNEL_DLQ_POISON_THRESHOLD,
      errorName: record.errorName,
      errorMessage: record.errorMessage,
    });
  }
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
