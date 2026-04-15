import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  capLogData,
  log,
  logInfo,
  logWarn,
  logError,
  logDebug,
  getServerLogs,
  getFilteredServerLogs,
  extractRequestId,
  parseServerLogIdCounter,
  MAX_LOG_DATA_BYTES,
  _resetLogBuffer,
} from "@/server/log";

beforeEach(() => {
  _resetLogBuffer();
});

describe("log() ring buffer", () => {
  it("stores entries in the buffer", () => {
    log("info", "test message");
    const logs = getServerLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "test message");
    assert.equal(logs[0].level, "info");
  });

  it("generates unique ids with slog- prefix", () => {
    log("info", "first");
    log("info", "second");
    const logs = getServerLogs();
    assert.ok(logs[0].id.startsWith("slog-"), `Expected slog- prefix, got ${logs[0].id}`);
    assert.ok(logs[1].id.startsWith("slog-"), `Expected slog- prefix, got ${logs[1].id}`);
    assert.notEqual(logs[0].id, logs[1].id);
  });

  it("assigns timestamps", () => {
    const before = Date.now();
    log("info", "timed");
    const after = Date.now();
    const entry = getServerLogs()[0];
    assert.ok(entry.timestamp >= before && entry.timestamp <= after);
  });

  it("evicts oldest entries when buffer exceeds 1000", () => {
    for (let i = 0; i < 1050; i++) {
      log("info", `msg-${i}`);
    }
    const logs = getServerLogs();
    assert.equal(logs.length, 1000);
    assert.equal(logs[0].message, "msg-50");
    assert.equal(logs[999].message, "msg-1049");
  });

  it("stores context data", () => {
    log("warn", "with data", { key: "value", count: 42 });
    const entry = getServerLogs()[0];
    assert.deepEqual(entry.data, { key: "value", count: 42 });
  });

  it("omits data field when context is empty", () => {
    log("info", "no ctx");
    const entry = getServerLogs()[0];
    assert.equal(entry.data, undefined);
  });

  it("omits data field when context only contains source", () => {
    log("info", "system.test", { source: "system" });
    const entry = getServerLogs()[0];
    assert.equal(entry.data, undefined);
  });

  it("convenience helpers log at correct levels", () => {
    logInfo("i");
    logWarn("w");
    logError("e");
    logDebug("d");
    const logs = getServerLogs();
    // Debug entries are excluded from the ring buffer (console only)
    assert.equal(logs.length, 3);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[1].level, "warn");
    assert.equal(logs[2].level, "error");
  });
});

describe("inferSource() prefix mapping", () => {
  it("maps sandbox prefix to lifecycle", () => {
    log("info", "sandbox.create started");
    assert.equal(getServerLogs()[0].source, "lifecycle");
  });

  it("maps gateway prefix to proxy", () => {
    log("info", "gateway.probe ready");
    assert.equal(getServerLogs()[0].source, "proxy");
  });

  it("maps firewall prefix to firewall", () => {
    log("info", "firewall.sync complete");
    assert.equal(getServerLogs()[0].source, "firewall");
  });

  it("maps channels prefix to channels", () => {
    log("info", "channels.drain started");
    assert.equal(getServerLogs()[0].source, "channels");
  });

  it("maps auth prefix to auth", () => {
    log("info", "auth.verify token");
    assert.equal(getServerLogs()[0].source, "auth");
  });

  it("defaults to system for unknown prefixes", () => {
    log("info", "unknown.thing happened");
    assert.equal(getServerLogs()[0].source, "system");
  });

  it("uses explicit source from context over prefix", () => {
    log("info", "sandbox.create", { source: "auth" });
    assert.equal(getServerLogs()[0].source, "auth");
  });

  it("uses source prefix key from context mapping", () => {
    log("info", "some message", { source: "firewall" });
    assert.equal(getServerLogs()[0].source, "firewall");
  });

  it("defaults to system for no dots in message", () => {
    log("info", "plain message");
    assert.equal(getServerLogs()[0].source, "system");
  });
});

describe("extractRequestId()", () => {
  it("prefers x-vercel-id header", () => {
    const req = new Request("https://example.com", {
      headers: {
        "x-vercel-id": "vercel-123",
        "x-request-id": "req-456",
      },
    });
    assert.equal(extractRequestId(req), "vercel-123");
  });

  it("falls back to x-request-id", () => {
    const req = new Request("https://example.com", {
      headers: { "x-request-id": "req-456" },
    });
    assert.equal(extractRequestId(req), "req-456");
  });

  it("returns undefined when no ID headers present", () => {
    const req = new Request("https://example.com");
    assert.equal(extractRequestId(req), undefined);
  });
});

describe("getFilteredServerLogs()", () => {
  beforeEach(() => {
    _resetLogBuffer();
    log("info", "sandbox.create started");
    log("warn", "firewall.sync delayed", { extra: "data" });
    log("error", "auth.verify failed");
    log("info", "channels.drain ok");
    log("debug", "gateway.probe check");
  });

  it("filters by level", () => {
    const results = getFilteredServerLogs({ level: "warn" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "firewall.sync delayed");
  });

  it("filters by source", () => {
    const results = getFilteredServerLogs({ source: "auth" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "auth.verify failed");
  });

  it("filters by search term in message", () => {
    const results = getFilteredServerLogs({ search: "drain" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "channels.drain ok");
  });

  it("filters by search term in data", () => {
    const results = getFilteredServerLogs({ search: "extra" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "firewall.sync delayed");
  });

  it("combines level and source filters", () => {
    const results = getFilteredServerLogs({ level: "info", source: "lifecycle" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "sandbox.create started");
  });

  it("returns empty array when no matches", () => {
    const results = getFilteredServerLogs({ level: "debug", source: "auth" });
    assert.equal(results.length, 0);
  });

  it("returns all entries with no filters", () => {
    const results = getFilteredServerLogs({});
    // Debug entries are excluded from the ring buffer (they only go to console)
    assert.equal(results.length, 4);
  });

  it("search is case-insensitive", () => {
    const results = getFilteredServerLogs({ search: "DRAIN" });
    assert.equal(results.length, 1);
  });

  it("returns a copy, not a reference to internal buffer", () => {
    const results = getFilteredServerLogs({});
    results.push({
      id: "fake",
      timestamp: 0,
      level: "info",
      source: "system",
      message: "injected",
    });
    // Debug entries excluded from ring buffer, so 4 not 5
    assert.equal(getServerLogs().length, 4);
  });
});

describe("getFilteredServerLogs() correlation filters", () => {
  beforeEach(() => {
    _resetLogBuffer();
    log("info", "channels.wake_requested", {
      opId: "op_aaa111222333",
      channel: "slack",
      messageId: "vq_msg1",
      sandboxId: "sbx_123",
      requestId: "req-abc",
    });
    log("info", "sandbox.restore.phase_complete", {
      opId: "op_aaa111222333",
      phase: "local_ready",
      sandboxId: "sbx_123",
    });
    log("info", "channels.wake_requested", {
      opId: "op_bbb444555666",
      parentOpId: "op_aaa111222333",
      channel: "telegram",
      messageId: "vq_msg2",
      sandboxId: "sbx_456",
      requestId: "req-def",
    });
    log("error", "channels.delivery_failed", {
      opId: "op_ccc777888999",
      channel: "discord",
      messageId: "vq_msg3",
    });
  });

  it("filters by opId (matches opId directly)", () => {
    const results = getFilteredServerLogs({ opId: "op_aaa111222333" });
    // Should match the two entries with opId=op_aaa111222333 plus the child with parentOpId
    assert.equal(results.length, 3);
  });

  it("filters by opId (matches parentOpId)", () => {
    const results = getFilteredServerLogs({ opId: "op_aaa111222333" });
    const hasChild = results.some(
      (e) => e.data?.parentOpId === "op_aaa111222333",
    );
    assert.ok(hasChild, "Should include entries where parentOpId matches");
  });

  it("filters by requestId", () => {
    const results = getFilteredServerLogs({ requestId: "req-abc" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "channels.wake_requested");
    assert.equal(results[0].data?.channel, "slack");
  });

  it("filters by channel", () => {
    const results = getFilteredServerLogs({ channel: "telegram" });
    assert.equal(results.length, 1);
    assert.equal(results[0].data?.opId, "op_bbb444555666");
  });

  it("filters by sandboxId", () => {
    const results = getFilteredServerLogs({ sandboxId: "sbx_123" });
    assert.equal(results.length, 2);
  });

  it("filters by messageId", () => {
    const results = getFilteredServerLogs({ messageId: "vq_msg3" });
    assert.equal(results.length, 1);
    assert.equal(results[0].data?.channel, "discord");
  });

  it("combines correlation filters with level", () => {
    const results = getFilteredServerLogs({
      opId: "op_ccc777888999",
      level: "error",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "channels.delivery_failed");
  });

  it("returns empty when no correlation match", () => {
    const results = getFilteredServerLogs({ opId: "op_nonexistent" });
    assert.equal(results.length, 0);
  });
});

describe("monotonic IDs", () => {
  it("produces strictly ordered ids on consecutive calls", () => {
    log("info", "a");
    log("info", "b");
    log("info", "c");
    const logs = getServerLogs();
    const counters = logs.map((l) => parseServerLogIdCounter(l.id));
    assert.equal(counters[0], 1);
    assert.equal(counters[1], 2);
    assert.equal(counters[2], 3);
    // String sort matches numeric sort because the counter is zero-padded.
    const sorted = [...logs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    assert.deepEqual(
      sorted.map((l) => l.id),
      logs.map((l) => l.id),
    );
  });

  it("does not collide when many ids are generated within the same ms", () => {
    // Synchronous tight loop guarantees most calls land in the same ms.
    for (let i = 0; i < 50; i++) {
      log("info", `same-ms-${i}`);
    }
    const ids = getServerLogs().map((l) => l.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "all ids should be unique");
  });

  it("ids match the slog-NNNNNNNNNNNN shape", () => {
    log("info", "shape");
    const id = getServerLogs()[0].id;
    assert.match(id, /^slog-\d{12}$/);
  });
});

describe("data truncation", () => {
  it("truncates buffered data when JSON.stringify exceeds MAX_LOG_DATA_BYTES", () => {
    const huge = "x".repeat(MAX_LOG_DATA_BYTES + 100);
    log("info", "big.data", { payload: huge });
    const entry = getServerLogs()[0];
    assert.equal(entry.data?.__truncated, true);
    assert.equal(typeof entry.data?.__originalBytes, "number");
    assert.ok((entry.data?.__originalBytes as number) > MAX_LOG_DATA_BYTES);
    assert.equal(typeof entry.data?.__preview, "string");
    assert.ok((entry.data?.__preview as string).length <= 512);
    // Original payload key is gone in the buffered copy.
    assert.equal(entry.data?.payload, undefined);
  });

  it("does not truncate when data fits within the cap", () => {
    log("info", "small.data", { hello: "world", count: 1 });
    const entry = getServerLogs()[0];
    assert.deepEqual(entry.data, { hello: "world", count: 1 });
  });

  it("emits the full ctx to console.info even when buffered copy is truncated", () => {
    const huge = "x".repeat(MAX_LOG_DATA_BYTES + 100);
    const original = console.info;
    const calls: string[] = [];
    console.info = (...args: unknown[]) => {
      calls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    try {
      log("info", "console.full", { payload: huge });
    } finally {
      console.info = original;
    }
    assert.equal(calls.length, 1);
    // Console payload should contain the full huge string.
    assert.ok(
      calls[0].includes(huge.slice(0, 1000)),
      "console.info should receive full ctx",
    );
    // And it should NOT have the truncation markers.
    assert.ok(!calls[0].includes("__truncated"));
  });
});

describe("capLogData()", () => {
  it("returns undefined when input is undefined", () => {
    assert.equal(capLogData(undefined), undefined);
  });

  it("returns the same object reference when under the cap", () => {
    const input = { hello: "world", count: 42 };
    const result = capLogData(input);
    assert.equal(result, input);
  });

  it("produces the truncation shape when over the cap", () => {
    const huge = "x".repeat(MAX_LOG_DATA_BYTES + 100);
    const result = capLogData({ payload: huge });
    assert.ok(result, "result should be defined");
    assert.equal(result.__truncated, true);
    assert.equal(typeof result.__originalBytes, "number");
    assert.ok((result.__originalBytes as number) > MAX_LOG_DATA_BYTES);
    assert.equal(typeof result.__preview, "string");
    assert.ok((result.__preview as string).length <= 512);
    assert.equal(result.payload, undefined);
  });
});

describe("parseServerLogIdCounter()", () => {
  it("extracts numeric counter from slog-NNN id", () => {
    assert.equal(parseServerLogIdCounter("slog-000000000042"), 42);
    assert.equal(parseServerLogIdCounter("slog-1"), 1);
  });

  it("returns null for malformed ids", () => {
    assert.equal(parseServerLogIdCounter(null), null);
    assert.equal(parseServerLogIdCounter(""), null);
    assert.equal(parseServerLogIdCounter("nope"), null);
    assert.equal(parseServerLogIdCounter("slog-"), null);
    assert.equal(parseServerLogIdCounter("slog-abc"), null);
    assert.equal(parseServerLogIdCounter("sbx-123"), null);
  });
});

describe("_resetLogBuffer()", () => {
  it("clears all entries", () => {
    log("info", "before reset");
    assert.equal(getServerLogs().length, 1);
    _resetLogBuffer();
    assert.equal(getServerLogs().length, 0);
  });

  it("resets id counter so new ids start fresh", () => {
    log("info", "first");
    const firstId = getServerLogs()[0].id;
    _resetLogBuffer();
    log("info", "after reset");
    const afterId = getServerLogs()[0].id;
    const firstNum = parseInt(firstId.split("-").pop()!, 10);
    const afterNum = parseInt(afterId.split("-").pop()!, 10);
    assert.ok(afterNum <= firstNum, "ID counter should reset");
  });
});
