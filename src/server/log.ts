import type { ChannelName } from "@/shared/channels";
import type { LogEntry, LogLevel, LogSource } from "@/shared/types";

const RING_BUFFER_SIZE = 1000;

/**
 * Maximum serialized size (in chars) of a log entry's `data` field before it
 * is truncated in the ring buffer. The full ctx is still emitted to
 * console.* (Vercel function logs are not size-constrained the same way).
 */
export const MAX_LOG_DATA_BYTES = 4096;

let _buffer: LogEntry[] = [];
let _idCounter = 0;

const SOURCE_PREFIXES: Record<string, LogSource> = {
  sandbox: "lifecycle",
  gateway: "proxy",
  firewall: "firewall",
  channels: "channels",
  auth: "auth",
};

function inferSource(msg: string, ctx?: Record<string, unknown>): LogSource {
  if (typeof ctx?.source === "string" && ctx.source in SOURCE_PREFIXES) {
    return SOURCE_PREFIXES[ctx.source] ?? "system";
  }
  if (typeof ctx?.source === "string") {
    const known: LogSource[] = [
      "lifecycle",
      "proxy",
      "firewall",
      "channels",
      "auth",
      "system",
    ];
    if (known.includes(ctx.source as LogSource)) {
      return ctx.source as LogSource;
    }
  }

  const prefix = msg.split(".")[0];
  if (prefix && prefix in SOURCE_PREFIXES) {
    return SOURCE_PREFIXES[prefix]!;
  }

  return "system";
}

/**
 * Generate a stable, monotonically increasing log ID.
 *
 * Format: `slog-NNNNNNNNNNNN` (12-digit zero-padded counter). The fixed-width
 * counter ensures lexicographic sort matches numeric sort, and dropping the
 * `Date.now()` component eliminates collisions when two logs land in the same
 * millisecond.
 *
 * Exported so cursor parsing in API routes can reuse the same scheme.
 */
function nextId(): string {
  _idCounter += 1;
  return `slog-${String(_idCounter).padStart(12, "0")}`;
}

/**
 * Parse a server-buffer log id of the form `slog-NNN...` into its numeric
 * counter. Returns `null` when the id does not match the expected shape.
 */
export function parseServerLogIdCounter(id: string | null): number | null {
  if (!id) return null;
  const match = /^slog-(\d+)$/.exec(id);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Extract a request ID from incoming headers for log correlation.
 * Prefers `x-vercel-id` (set by Vercel's edge), falls back to `x-request-id`.
 * Returns `undefined` when neither header is present so the field is omitted from logs.
 */
export function extractRequestId(request: Request): string | undefined {
  return (
    request.headers.get("x-vercel-id") ??
    request.headers.get("x-request-id") ??
    undefined
  );
}

/**
 * Cap a log entry's `data` payload to `MAX_LOG_DATA_BYTES` (measured against
 * its JSON.stringify length). Returns the input unchanged when it is under
 * the cap, or a truncation marker object
 * `{ __truncated, __originalBytes, __preview }` when it exceeds the cap.
 * Returns `undefined` when the input is `undefined`.
 *
 * This is applied both to entries produced in-process by `log()` (for the
 * ring buffer) and to entries parsed from sandbox tail output in
 * `/api/admin/logs` so that a single oversized ctx (e.g. a multi-KB stack
 * trace) cannot dominate the UI.
 */
export function capLogData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_LOG_DATA_BYTES) return data;
  return {
    __truncated: true,
    __originalBytes: serialized.length,
    __preview: serialized.slice(0, 512),
  };
}

export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const source = inferSource(msg, ctx);
  const now = Date.now();

  const entry: LogEntry = {
    id: nextId(),
    timestamp: now,
    level,
    source,
    message: msg,
    ...(ctx && Object.keys(ctx).length > 0 ? { data: { ...ctx } } : {}),
  };

  // Remove source from data if it was only used for inference
  if (entry.data?.source) {
    delete entry.data.source;
    if (Object.keys(entry.data).length === 0) {
      delete entry.data;
    }
  }

  // Debug entries go to console (Vercel function logs) but not the ring
  // buffer.  This prevents high-frequency diagnostic logs from evicting
  // operationally important info/warn/error entries.
  if (level !== "debug") {
    // Cap buffered `data` size so a single oversized payload (e.g. a giant
    // upstream response) cannot dominate the ring or balloon /api/admin/logs.
    // The full ctx is still passed to console.* below for Vercel function logs.
    const cappedData = capLogData(entry.data);
    const bufferedEntry: LogEntry =
      cappedData === entry.data
        ? entry
        : { ...entry, ...(cappedData ? { data: cappedData } : {}) };
    _buffer.push(bufferedEntry);
    if (_buffer.length > RING_BUFFER_SIZE) {
      _buffer = _buffer.slice(-RING_BUFFER_SIZE);
    }
  }

  const payload = JSON.stringify({
    ts: new Date(now).toISOString(),
    level,
    source,
    msg,
    ctx: ctx ?? {},
  });

  switch (level) {
    case "debug":
      console.debug(payload);
      return;
    case "warn":
      console.warn(payload);
      return;
    case "error":
      console.error(payload);
      return;
    default:
      console.info(payload);
  }
}

export function logInfo(msg: string, ctx?: Record<string, unknown>): void {
  log("info", msg, ctx);
}

export function logWarn(msg: string, ctx?: Record<string, unknown>): void {
  log("warn", msg, ctx);
}

export function logError(msg: string, ctx?: Record<string, unknown>): void {
  log("error", msg, ctx);
}

export function logDebug(msg: string, ctx?: Record<string, unknown>): void {
  log("debug", msg, ctx);
}

/**
 * Return all server-side log entries from the in-memory ring buffer.
 */
export function getServerLogs(): LogEntry[] {
  return [..._buffer];
}

export type LogFilters = {
  level?: LogLevel;
  source?: LogSource;
  search?: string;
  opId?: string;
  requestId?: string;
  channel?: ChannelName;
  sandboxId?: string;
  messageId?: string;
};

/**
 * Test whether a single log entry matches all non-empty filter criteria.
 *
 * This is the shared predicate used by both server-buffer and sandbox-log
 * filtering so that correlation semantics stay consistent across sources.
 */
export function matchesLogEntry(entry: LogEntry, filters: LogFilters): boolean {
  if (filters.level && entry.level !== filters.level) return false;
  if (filters.source && entry.source !== filters.source) return false;
  if (filters.search) {
    const term = filters.search.toLowerCase();
    const haystack =
      entry.message.toLowerCase() +
      " " +
      (entry.data ? JSON.stringify(entry.data).toLowerCase() : "");
    if (!haystack.includes(term)) return false;
  }
  if (filters.opId) {
    const id = filters.opId;
    if (entry.data?.opId !== id && entry.data?.parentOpId !== id) return false;
  }
  if (filters.requestId && entry.data?.requestId !== filters.requestId) return false;
  if (filters.channel && entry.data?.channel !== filters.channel) return false;
  if (filters.sandboxId && entry.data?.sandboxId !== filters.sandboxId) return false;
  if (filters.messageId && entry.data?.messageId !== filters.messageId) return false;
  return true;
}

/**
 * Filter an array of log entries using the shared matcher.
 */
export function filterLogEntries(
  entries: readonly LogEntry[],
  filters: LogFilters,
): LogEntry[] {
  return entries.filter((entry) => matchesLogEntry(entry, filters));
}

/**
 * Return filtered server-side log entries.
 *
 * Supports both the original level/source/search filters and the new
 * correlation-based filters (opId, requestId, channel, sandboxId, messageId)
 * that match against the `data` context attached to each log entry.
 */
export function getFilteredServerLogs(filters: LogFilters): LogEntry[] {
  return filterLogEntries(_buffer, filters);
}

/** Reset the buffer — for testing only. */
export function _resetLogBuffer(): void {
  _buffer = [];
  _idCounter = 0;
}
