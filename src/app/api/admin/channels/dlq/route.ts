import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import type { ChannelDlqIndexEntry, ChannelDlqRecord } from "@/server/channels/dlq";
import { channelFailedIndexKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";
import { isChannelName } from "@/shared/channels";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toPositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limit = toPositiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const channelParam = url.searchParams.get("channel");
  const channel =
    channelParam && isChannelName(channelParam) ? channelParam : null;
  const includeTerminalOnly = url.searchParams.get("terminal") === "true";

  const store = getStore();
  const indexRaw = await store
    .getValue<ChannelDlqIndexEntry[] | null>(channelFailedIndexKey())
    .catch(() => null);
  const index: ChannelDlqIndexEntry[] = Array.isArray(indexRaw)
    ? indexRaw.filter((entry): entry is ChannelDlqIndexEntry => {
        return (
          entry != null &&
          typeof entry === "object" &&
          typeof (entry as ChannelDlqIndexEntry).key === "string"
        );
      })
    : [];
  const filtered = index
    .filter((entry) => !channel || entry.channel === channel)
    .filter((entry) => !includeTerminalOnly || entry.terminal === true);
  const windowed = filtered.slice(0, limit);

  const now = Date.now();
  const items = await Promise.all(
    windowed.map(async (entry) => {
      const record = await store
        .getValue<ChannelDlqRecord>(entry.key)
        .catch(() => null);
      if (!record) {
        return {
          channel: entry.channel,
          deliveryId: entry.deliveryId,
          key: entry.key,
          phase: entry.phase,
          terminal: entry.terminal,
          failedAt: entry.failedAt,
          ageMs: now - entry.failedAt,
          detail: null,
          missing: true,
        };
      }
      return {
        channel: record.channel,
        deliveryId: record.deliveryId,
        key: entry.key,
        phase: record.phase,
        terminal: record.terminal,
        retryable: record.retryable,
        requestId: record.requestId,
        errorName: record.errorName,
        errorMessage: record.errorMessage,
        firstFailedAt: record.firstFailedAt,
        failedAt: record.failedAt,
        failureCount: record.failureCount,
        receivedAtMs: record.receivedAtMs,
        ageMs:
          typeof record.failedAt === "number" ? now - record.failedAt : null,
      };
    }),
  );

  return Response.json({
    items,
    count: items.length,
    indexSize: index.length,
    limit,
    channel,
    includeTerminalOnly,
  });
}
