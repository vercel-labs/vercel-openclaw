import assert from "node:assert/strict";
import test from "node:test";

import { fetchAdminJsonCore, type ReadJsonDeps } from "./admin-request-core";

function makeDeps(overrides: Partial<ReadJsonDeps> = {}): ReadJsonDeps {
  return {
    setStatus: () => {},
    toastError: () => {},
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown = null): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function throwingFetch(error: Error): typeof fetch {
  return async () => {
    throw error;
  };
}

/** Capture console.info and console.warn calls, returning parsed JSON lines. */
function captureConsoleLogs(): {
  infos: Record<string, unknown>[];
  warns: Record<string, unknown>[];
  restore: () => void;
} {
  const infos: Record<string, unknown>[] = [];
  const warns: Record<string, unknown>[] = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = (line: string) => {
    try {
      infos.push(JSON.parse(line));
    } catch {
      origInfo(line);
    }
  };
  console.warn = (line: string) => {
    try {
      warns.push(JSON.parse(line));
    } catch {
      origWarn(line);
    }
  };
  return {
    infos,
    warns,
    restore() {
      console.info = origInfo;
      console.warn = origWarn;
    },
  };
}

test("200: returns data and emits start + success logs", async () => {
  const logs = captureConsoleLogs();
  try {
    const result = await fetchAdminJsonCore<{ items: number[] }>(
      "/api/admin/logs",
      makeDeps({ fetchFn: mockFetch(200, { items: [1, 2] }) }),
    );

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.data.items.length === 2);

    // start log via console.info
    const start = logs.infos.find((l) => l.event === "admin.read.start");
    assert.ok(start, "expected admin.read.start log");
    assert.equal(start!.action, "/api/admin/logs");

    // success log via console.info
    const success = logs.infos.find((l) => l.event === "admin.read.success");
    assert.ok(success, "expected admin.read.success log");
    assert.equal(success!.action, "/api/admin/logs");
    assert.equal(success!.status, 200);

    // no error logs
    assert.equal(
      logs.warns.filter((l) => l.event === "admin.read.error").length,
      0,
    );
  } finally {
    logs.restore();
  }
});

test("401: clears auth state, toasts, and emits start + error logs", async () => {
  const errors: string[] = [];
  let statusCleared = false;
  const logs = captureConsoleLogs();

  try {
    const result = await fetchAdminJsonCore(
      "/api/admin/snapshots",
      makeDeps({
        fetchFn: mockFetch(401),
        toastError: (msg) => errors.push(msg),
        setStatus: () => {
          statusCleared = true;
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.status === 401);
    assert.ok(statusCleared, "expected setStatus(null) to be called");
    assert.deepEqual(errors, ["Session expired. Sign in again."]);

    // start log
    const start = logs.infos.find((l) => l.event === "admin.read.start");
    assert.ok(start);

    // error log via console.warn
    const errLog = logs.warns.find((l) => l.event === "admin.read.error");
    assert.ok(errLog, "expected admin.read.error log");
    assert.equal(errLog!.status, 401);
    assert.equal(errLog!.code, "unauthorized");
  } finally {
    logs.restore();
  }
});

test("500: toasts HTTP error and emits start + error logs", async () => {
  const errors: string[] = [];
  const logs = captureConsoleLogs();

  try {
    const result = await fetchAdminJsonCore(
      "/api/admin/logs",
      makeDeps({
        fetchFn: mockFetch(500, { message: "nope" }),
        toastError: (msg) => errors.push(msg),
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.status === 500);
    assert.deepEqual(errors, ["Request failed (HTTP 500)"]);

    const start = logs.infos.find((l) => l.event === "admin.read.start");
    assert.ok(start);

    const errLog = logs.warns.find((l) => l.event === "admin.read.error");
    assert.ok(errLog, "expected admin.read.error log");
    assert.equal(errLog!.status, 500);
    assert.equal(errLog!.code, "http-error");
  } finally {
    logs.restore();
  }
});

test("network error: toasts, returns status null, and emits start + error logs", async () => {
  const errors: string[] = [];
  const logs = captureConsoleLogs();

  try {
    const result = await fetchAdminJsonCore(
      "/api/admin/logs",
      makeDeps({
        fetchFn: throwingFetch(new Error("Failed to fetch")),
        toastError: (msg) => errors.push(msg),
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.status === null);
    assert.deepEqual(errors, ["Failed to fetch"]);

    const start = logs.infos.find((l) => l.event === "admin.read.start");
    assert.ok(start);

    const errLog = logs.warns.find((l) => l.event === "admin.read.error");
    assert.ok(errLog, "expected admin.read.error log");
    assert.equal(errLog!.status, null);
    assert.equal(errLog!.code, "network-error");
  } finally {
    logs.restore();
  }
});
