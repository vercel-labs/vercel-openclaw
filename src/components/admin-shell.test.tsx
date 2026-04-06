import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { AdminActionEvent } from "@/components/admin-types";
import { requestJsonCore, type RequestJsonDeps } from "./admin-shell";

// ---------------------------------------------------------------------------
// Minimal window shim for CustomEvent dispatch in Node
// ---------------------------------------------------------------------------
type Listener = (event: { detail: AdminActionEvent }) => void;
const listeners: Listener[] = [];

before(() => {
  (globalThis as Record<string, unknown>).window = {
    dispatchEvent(event: { detail: AdminActionEvent }) {
      for (const fn of listeners) fn(event);
      return true;
    },
    addEventListener(_: string, fn: Listener) {
      listeners.push(fn);
    },
    removeEventListener(_: string, fn: Listener) {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
  (globalThis as Record<string, unknown>).CustomEvent = class CustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init: { detail: T }) {
      super(type);
      this.detail = init.detail;
    }
  };
});

after(() => {
  delete (globalThis as Record<string, unknown>).window;
  listeners.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listenForAdminActionEvents() {
  const events: AdminActionEvent[] = [];
  const handler = (event: { detail: AdminActionEvent }) => {
    events.push(event.detail);
  };
  listeners.push(handler);
  return {
    events,
    stop() {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
}

function makeDeps(overrides: Partial<RequestJsonDeps> = {}): RequestJsonDeps {
  return {
    setPendingAction: () => {},
    setStatus: () => {},
    refreshPassive: async () => {},
    toastSuccess: () => {},
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requestJsonCore", () => {
  test("401 response produces { ok: false, meta.code: 'unauthorized' }", async () => {
    const result = await requestJsonCore("/api/test", {
      label: "Test action",
      method: "POST",
    }, makeDeps({ fetchFn: mockFetch(401) }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.meta.code, "unauthorized");
    assert.equal(result.meta.status, 401);
    assert.equal(result.meta.retryable, false);
    assert.equal(result.error, "Session expired. Sign in again.");
  });

  test("401 response calls setStatus(null)", async () => {
    let statusCleared = false;
    await requestJsonCore("/api/test", {
      label: "Test action",
      method: "POST",
    }, makeDeps({
      fetchFn: mockFetch(401),
      setStatus: () => { statusCleared = true; },
    }));

    assert.ok(statusCleared);
  });

  test("500 response produces { ok: false, meta.code: 'http-error', retryable: true }", async () => {
    const result = await requestJsonCore("/api/test", {
      label: "Server action",
      method: "POST",
    }, makeDeps({
      fetchFn: mockFetch(500, { message: "Internal error" }),
    }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.meta.code, "http-error");
    assert.equal(result.meta.status, 500);
    assert.equal(result.meta.retryable, true);
  });

  test("400 response produces { ok: false, meta.code: 'http-error', retryable: false }", async () => {
    const result = await requestJsonCore("/api/test", {
      label: "Bad request",
      method: "POST",
    }, makeDeps({
      fetchFn: mockFetch(400, { error: { message: "Invalid input" } }),
    }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.meta.code, "http-error");
    assert.equal(result.meta.status, 400);
    assert.equal(result.meta.retryable, false);
    assert.ok(result.error.includes("Invalid input"));
  });

  test("thrown fetch error produces { ok: false, meta.code: 'network-error' }", async () => {
    const result = await requestJsonCore("/api/test", {
      label: "Network action",
      method: "POST",
    }, makeDeps({
      fetchFn: throwingFetch(new Error("Failed to fetch")),
    }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.meta.code, "network-error");
    assert.equal(result.meta.status, null);
    assert.equal(result.meta.retryable, true);
    assert.equal(result.error, "Failed to fetch");
  });

  test("thrown fetch error toasts the network error message", async () => {
    const errors: string[] = [];
    await requestJsonCore("/api/test", {
      label: "Network action",
      method: "POST",
    }, makeDeps({
      fetchFn: throwingFetch(new Error("Failed to fetch")),
      toastError: (message) => errors.push(message),
    }));

    assert.deepEqual(errors, ["Failed to fetch"]);
  });

  test("successful request with refreshAfter: false produces meta.refreshed === false", async () => {
    let refreshCalled = false;
    const result = await requestJsonCore("/api/test", {
      label: "No-refresh action",
      method: "POST",
      refreshAfter: false,
    }, makeDeps({
      fetchFn: mockFetch(200, { value: 42 }),
      refreshPassive: async () => { refreshCalled = true; },
    }));

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.meta.refreshed, false);
    assert.equal(refreshCalled, false);
  });

  test("successful request with default refreshAfter produces meta.refreshed === true", async () => {
    let refreshCalled = false;
    const result = await requestJsonCore("/api/test", {
      label: "Refresh action",
      method: "POST",
    }, makeDeps({
      fetchFn: mockFetch(200, { ok: true }),
      refreshPassive: async () => { refreshCalled = true; },
    }));

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.meta.refreshed, true);
    assert.equal(refreshCalled, true);
  });

  test("successful request returns parsed data", async () => {
    const result = await requestJsonCore<{ count: number }>("/api/test", {
      label: "Data action",
      method: "GET",
    }, makeDeps({
      fetchFn: mockFetch(200, { count: 7 }),
    }));

    assert.ok(result.ok);
    assert.deepEqual(result.data, { count: 7 });
  });

  test("setPendingAction set on start and cleared on completion", async () => {
    const calls: Array<string | null> = [];
    await requestJsonCore("/api/test", {
      label: "Pending test",
      method: "POST",
    }, makeDeps({
      fetchFn: mockFetch(200, null),
      setPendingAction: (v) => calls.push(v),
    }));

    assert.equal(calls[0], "Pending test");
    assert.equal(calls[calls.length - 1], null);
  });

  test("setPendingAction cleared even on failure", async () => {
    const calls: Array<string | null> = [];
    await requestJsonCore("/api/test", {
      label: "Failing test",
      method: "POST",
    }, makeDeps({
      fetchFn: throwingFetch(new Error("boom")),
      setPendingAction: (v) => calls.push(v),
    }));

    assert.equal(calls[0], "Failing test");
    assert.equal(calls[calls.length - 1], null);
  });
});

describe("openclaw:admin-action events", () => {
  test("success path emits start then success events in order", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Event test",
        method: "POST",
      }, makeDeps({
        fetchFn: mockFetch(200, null),
      }));

      assert.equal(events.length, 2);
      assert.equal(events[0].event, "admin.action.start");
      assert.equal(events[1].event, "admin.action.success");
      assert.equal(events[0].requestId, events[1].requestId);
      assert.equal(events[0].source, "admin-shell");
      assert.equal(events[1].source, "admin-shell");

      // Start event fields
      const start = events[0] as Extract<AdminActionEvent, { event: "admin.action.start" }>;
      assert.equal(start.action, "/api/test");
      assert.equal(start.label, "Event test");
      assert.equal(start.method, "POST");

      // Success event fields
      const success = events[1] as Extract<AdminActionEvent, { event: "admin.action.success" }>;
      assert.equal(success.status, 200);
      assert.equal(success.refreshed, true);
    } finally {
      stop();
    }
  });

  test("error path emits start then error events in order", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Error event test",
        method: "POST",
      }, makeDeps({
        fetchFn: mockFetch(500, null),
      }));

      assert.equal(events.length, 2);
      assert.equal(events[0].event, "admin.action.start");
      assert.equal(events[1].event, "admin.action.error");
      assert.equal(events[0].requestId, events[1].requestId);

      const error = events[1] as Extract<AdminActionEvent, { event: "admin.action.error" }>;
      assert.equal(error.code, "http-error");
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
    } finally {
      stop();
    }
  });

  test("network error path emits start then error events", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Network event test",
        method: "POST",
      }, makeDeps({
        fetchFn: throwingFetch(new Error("Connection refused")),
      }));

      assert.equal(events.length, 2);
      assert.equal(events[0].event, "admin.action.start");
      assert.equal(events[1].event, "admin.action.error");

      const error = events[1] as Extract<AdminActionEvent, { event: "admin.action.error" }>;
      assert.equal(error.code, "network-error");
      assert.equal(error.status, null);
      assert.equal(error.error, "Connection refused");
    } finally {
      stop();
    }
  });

  test("401 path emits start then error with unauthorized code", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Auth event test",
        method: "POST",
      }, makeDeps({
        fetchFn: mockFetch(401),
      }));

      assert.equal(events.length, 2);
      assert.equal(events[0].event, "admin.action.start");
      assert.equal(events[1].event, "admin.action.error");

      const error = events[1] as Extract<AdminActionEvent, { event: "admin.action.error" }>;
      assert.equal(error.code, "unauthorized");
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
    } finally {
      stop();
    }
  });

  test("all events carry valid ISO timestamps", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Timestamp test",
        method: "POST",
      }, makeDeps({
        fetchFn: mockFetch(200, null),
      }));

      for (const event of events) {
        assert.ok(event.ts);
        assert.ok(!Number.isNaN(Date.parse(event.ts)), `Invalid timestamp: ${event.ts}`);
      }
    } finally {
      stop();
    }
  });

  test("requestId starts with admin- prefix", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      await requestJsonCore("/api/test", {
        label: "Prefix test",
        method: "POST",
      }, makeDeps({
        fetchFn: mockFetch(200, null),
      }));

      for (const event of events) {
        assert.ok(event.requestId.startsWith("admin-"), `Expected admin- prefix: ${event.requestId}`);
      }
    } finally {
      stop();
    }
  });
});

describe("requestJsonCore live-config-sync header detection", () => {
  function mockFetchWithHeaders(
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): typeof fetch {
    return async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
  }

  test("degraded sync header shows warning toast", async () => {
    const toasts: { type: string; message: string }[] = [];
    let refreshCalled = false;
    const result = await requestJsonCore("/api/channels/slack", {
      label: "Save Slack",
      method: "PUT",
    }, makeDeps({
      fetchFn: mockFetchWithHeaders(200, { configured: true }, {
        "x-openclaw-live-config-sync-outcome": "degraded",
        "x-openclaw-live-config-sync-message": "Sandbox did not restart cleanly.",
      }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
      refreshPassive: async () => { refreshCalled = true; },
    }));

    assert.ok(result.ok);
    assert.equal(toasts.length, 1, "exactly one toast");
    assert.equal(toasts[0].type, "error");
    assert.equal(toasts[0].message, "Sandbox did not restart cleanly.");
    assert.ok(refreshCalled, "status must be refreshed on degraded sync");
  });

  test("failed sync header shows error toast", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/channels/slack", {
      label: "Save Slack",
      method: "PUT",
    }, makeDeps({
      fetchFn: mockFetchWithHeaders(200, { configured: true }, {
        "x-openclaw-live-config-sync-outcome": "failed",
        "x-openclaw-live-config-sync-message": "Config sync failed.",
      }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.ok(result.ok);
    assert.equal(toasts.length, 1, "exactly one toast");
    assert.equal(toasts[0].type, "error");
    assert.equal(toasts[0].message, "Config sync failed.");
  });

  test("applied sync header does not toast", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/channels/slack", {
      label: "Save Slack",
      toastSuccess: false,
      method: "PUT",
    }, makeDeps({
      fetchFn: mockFetchWithHeaders(200, { configured: true }, {
        "x-openclaw-live-config-sync-outcome": "applied",
      }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.ok(result.ok);
    assert.deepEqual(toasts, [], "no toast when success toasts suppressed");
  });

  test("skipped sync header does not toast", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/channels/slack", {
      label: "Save Slack",
      toastSuccess: false,
      method: "PUT",
    }, makeDeps({
      fetchFn: mockFetchWithHeaders(200, { configured: true }, {
        "x-openclaw-live-config-sync-outcome": "skipped",
      }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.ok(result.ok);
    assert.deepEqual(toasts, [], "no toast when success toasts suppressed");
  });

  test("no sync header does not toast when success suppressed", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/status", {
      label: "Check status",
      toastSuccess: false,
      method: "GET",
    }, makeDeps({
      fetchFn: mockFetch(200, { ok: true }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.ok(result.ok);
    assert.deepEqual(toasts, [], "no toast when success toasts suppressed");
  });

  test("degraded liveConfigSync in body is preserved on meta and emits live-config-warning event", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      const syncPayload = {
        outcome: "degraded",
        reason: "config_written_restart_failed",
        liveConfigFresh: false,
        operatorMessage: "Sandbox did not restart cleanly.",
      };
      const result = await requestJsonCore("/api/channels/slack", {
        label: "Save Slack",
        method: "PUT",
      }, makeDeps({
        fetchFn: mockFetchWithHeaders(200, { configured: true, liveConfigSync: syncPayload }, {
          "x-openclaw-live-config-sync-outcome": "degraded",
          "x-openclaw-live-config-sync-message": "Sandbox did not restart cleanly.",
        }),
      }));

      assert.ok(result.ok);
      assert.ok(result.ok && result.meta.liveConfigSync, "meta must include liveConfigSync");
      if (result.ok && result.meta.liveConfigSync) {
        assert.equal(result.meta.liveConfigSync.outcome, "degraded");
        assert.equal(result.meta.liveConfigSync.reason, "config_written_restart_failed");
        assert.equal(result.meta.liveConfigSync.liveConfigFresh, false);
        assert.equal(result.meta.liveConfigSync.operatorMessage, "Sandbox did not restart cleanly.");
      }

      const warningEvents = events.filter((e) => e.event === "admin.action.live-config-warning");
      assert.equal(warningEvents.length, 1, "exactly one live-config-warning event");
      const warning = warningEvents[0] as Extract<AdminActionEvent, { event: "admin.action.live-config-warning" }>;
      assert.equal(warning.outcome, "degraded");
      assert.equal(warning.reason, "config_written_restart_failed");
      assert.equal(warning.action, "/api/channels/slack");
    } finally {
      stop();
    }
  });

  test("failed liveConfigSync in body emits live-config-warning event", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      const syncPayload = {
        outcome: "failed",
        reason: "Gateway did not become ready",
        liveConfigFresh: false,
        operatorMessage: "Config sync failed.",
      };
      const result = await requestJsonCore("/api/channels/slack", {
        label: "Save Slack",
        method: "PUT",
      }, makeDeps({
        fetchFn: mockFetchWithHeaders(200, { configured: true, liveConfigSync: syncPayload }, {
          "x-openclaw-live-config-sync-outcome": "failed",
          "x-openclaw-live-config-sync-message": "Config sync failed.",
        }),
      }));

      assert.ok(result.ok);
      const warningEvents = events.filter((e) => e.event === "admin.action.live-config-warning");
      assert.equal(warningEvents.length, 1);
      const warning = warningEvents[0] as Extract<AdminActionEvent, { event: "admin.action.live-config-warning" }>;
      assert.equal(warning.outcome, "failed");
    } finally {
      stop();
    }
  });

  test("applied liveConfigSync in body does not emit live-config-warning event", async () => {
    const { events, stop } = listenForAdminActionEvents();
    try {
      const syncPayload = {
        outcome: "applied",
        reason: "config_written_and_restarted",
        liveConfigFresh: true,
        operatorMessage: null,
      };
      await requestJsonCore("/api/channels/slack", {
        label: "Save Slack",
        method: "PUT",
      }, makeDeps({
        fetchFn: mockFetchWithHeaders(200, { configured: true, liveConfigSync: syncPayload }, {
          "x-openclaw-live-config-sync-outcome": "applied",
        }),
      }));

      const warningEvents = events.filter((e) => e.event === "admin.action.live-config-warning");
      assert.equal(warningEvents.length, 0, "no live-config-warning for applied outcome");
    } finally {
      stop();
    }
  });
});

describe("requestJsonCore CSRF header injection", () => {
  function capturingFetchFactory(): { getHeaders: () => Headers; fetchFn: typeof fetch } {
    let captured: Headers | undefined;
    return {
      getHeaders: () => {
        assert.ok(captured, "fetch should have been called");
        return captured;
      },
      fetchFn: async (_input, init) => {
        captured = new Headers(init?.headers as HeadersInit);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
  }

  test("POST requests include x-requested-with: XMLHttpRequest", async () => {
    const { getHeaders, fetchFn } = capturingFetchFactory();
    await requestJsonCore("/api/admin/reset", {
      label: "Reset",
      method: "POST",
    }, makeDeps({ fetchFn }));

    assert.equal(getHeaders().get("x-requested-with"), "XMLHttpRequest");
  });

  test("PUT requests include x-requested-with: XMLHttpRequest", async () => {
    const { getHeaders, fetchFn } = capturingFetchFactory();
    await requestJsonCore("/api/channels/slack", {
      label: "Save Slack",
      method: "PUT",
    }, makeDeps({ fetchFn }));

    assert.equal(getHeaders().get("x-requested-with"), "XMLHttpRequest");
  });

  test("GET requests do not include x-requested-with", async () => {
    const { getHeaders, fetchFn } = capturingFetchFactory();
    await requestJsonCore("/api/status", {
      label: "Status",
      method: "GET",
    }, makeDeps({ fetchFn }));

    assert.equal(getHeaders().get("x-requested-with"), null);
  });

  test("explicit x-requested-with is not overwritten", async () => {
    const { getHeaders, fetchFn } = capturingFetchFactory();
    await requestJsonCore("/api/test", {
      label: "Custom header",
      method: "POST",
      headers: { "x-requested-with": "CustomValue" },
    }, makeDeps({ fetchFn }));

    assert.equal(getHeaders().get("x-requested-with"), "CustomValue");
  });
});

describe("requestJsonCore background/quiet mode", () => {
  test("toastSuccess: false suppresses success toast", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/test", {
      label: "Quiet action",
      method: "POST",
      toastSuccess: false,
    }, makeDeps({
      fetchFn: mockFetch(200, { ok: true }),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.ok(result.ok);
    assert.deepEqual(toasts, []);
  });

  test("toastError: false suppresses error toast on failure", async () => {
    const toasts: { type: string; message: string }[] = [];
    const result = await requestJsonCore("/api/test", {
      label: "Quiet action",
      method: "POST",
      toastError: false,
    }, makeDeps({
      fetchFn: mockFetch(500, null),
      toastSuccess: (m) => toasts.push({ type: "success", message: m }),
      toastError: (m) => toasts.push({ type: "error", message: m }),
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(toasts, []);
  });

  test("toastError: false suppresses toast on 401 but still clears auth", async () => {
    const toasts: string[] = [];
    let statusCleared = false;
    const result = await requestJsonCore("/api/test", {
      label: "Quiet action",
      method: "POST",
      toastError: false,
    }, makeDeps({
      fetchFn: mockFetch(401),
      toastError: (m) => toasts.push(m),
      setStatus: () => { statusCleared = true; },
    }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.meta.code === "unauthorized");
    assert.ok(statusCleared, "auth must still be cleared");
    assert.deepEqual(toasts, [], "no toast in quiet mode");
  });

  test("toastError: false suppresses toast on network error", async () => {
    const toasts: string[] = [];
    const result = await requestJsonCore("/api/test", {
      label: "Quiet action",
      method: "POST",
      toastError: false,
    }, makeDeps({
      fetchFn: throwingFetch(new Error("Connection refused")),
      toastError: (m) => toasts.push(m),
    }));

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.meta.code === "network-error");
    assert.deepEqual(toasts, [], "no toast in quiet mode");
  });

  test("trackPending: false skips setPendingAction calls", async () => {
    const calls: Array<string | null> = [];
    await requestJsonCore("/api/test", {
      label: "Background action",
      method: "POST",
      trackPending: false,
    }, makeDeps({
      fetchFn: mockFetch(200, null),
      setPendingAction: (v) => calls.push(v),
    }));

    assert.deepEqual(calls, [], "setPendingAction should not be called");
  });

  test("trackPending: false skips setPendingAction even on failure", async () => {
    const calls: Array<string | null> = [];
    await requestJsonCore("/api/test", {
      label: "Background action",
      method: "POST",
      trackPending: false,
    }, makeDeps({
      fetchFn: throwingFetch(new Error("fail")),
      setPendingAction: (v) => calls.push(v),
    }));

    assert.deepEqual(calls, [], "setPendingAction should not be called");
  });

  test("all quiet options together: no toasts, no pending, still emits events", async () => {
    const { events, stop } = listenForAdminActionEvents();
    const toasts: string[] = [];
    const pending: Array<string | null> = [];

    try {
      const result = await requestJsonCore("/api/firewall/ingest", {
        label: "Ingest firewall learning",
        method: "POST",
        refreshAfter: false,
        toastSuccess: false,
        toastError: false,
        trackPending: false,
      }, makeDeps({
        fetchFn: mockFetch(200, null),
        toastSuccess: (m) => toasts.push(m),
        toastError: (m) => toasts.push(m),
        setPendingAction: (v) => pending.push(v),
      }));

      assert.ok(result.ok);
      assert.deepEqual(toasts, []);
      assert.deepEqual(pending, []);

      // Events still fire
      assert.equal(events.length, 2);
      assert.equal(events[0].event, "admin.action.start");
      assert.equal(events[1].event, "admin.action.success");
    } finally {
      stop();
    }
  });
});
