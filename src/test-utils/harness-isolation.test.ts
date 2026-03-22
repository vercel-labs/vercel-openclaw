/**
 * Harness isolation tests.
 *
 * Verifies that sequential harness instances share zero state:
 * store, env vars, fetch handlers, controller, and after() callbacks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import { createFakeFetch } from "@/test-utils/fake-fetch";
import {
  capturedAfter,
  drainAfterCallbacks,
  pendingAfterCount,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { getSandboxController } from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Sequential harness instances share zero state
// ---------------------------------------------------------------------------

test("harness isolation: two sequential instances share no store state", async () => {
  // First harness — write some state
  const h1 = createScenarioHarness();
  await h1.mutateMeta((m) => {
    m.status = "running";
    m.sandboxId = "sbx-isolation-1";
  });
  const meta1 = await h1.getMeta();
  assert.equal(meta1.status, "running");
  assert.equal(meta1.sandboxId, "sbx-isolation-1");
  h1.teardown();

  // Second harness — should start completely fresh
  const h2 = createScenarioHarness();
  const meta2 = await h2.getMeta();
  assert.equal(meta2.status, "uninitialized");
  assert.equal(meta2.sandboxId, null);
  h2.teardown();
});

test("harness isolation: two sequential instances have independent controllers", async () => {
  const h1 = createScenarioHarness();
  await h1.controller.create({ ports: [3000] });
  assert.equal(h1.controller.created.length, 1);
  h1.teardown();

  const h2 = createScenarioHarness();
  assert.equal(h2.controller.created.length, 0);
  assert.equal(h2.controller.events.length, 0);
  h2.teardown();
});

test("harness isolation: controller is unset after teardown (throws without active controller)", () => {
  const h = createScenarioHarness();
  const fakeController = h.controller;

  // During harness, getSandboxController returns the fake
  assert.equal(getSandboxController(), fakeController);

  h.teardown();

  // After teardown, getSandboxController should throw (no active controller in test mode)
  assert.throws(
    () => getSandboxController(),
    { message: /not initialized for testing/ },
  );
});

// ---------------------------------------------------------------------------
// fakeFetch.reset() clears all handlers and captured requests
// ---------------------------------------------------------------------------

test("fakeFetch.reset: clears all handlers and captured requests", async () => {
  const fake = createFakeFetch();

  // Register handlers for various methods
  fake.onGet("/probe", () => new Response("ok"));
  fake.onPost("/send", () => new Response("sent"));
  fake.onPatch("/update", () => new Response("patched"));
  fake.otherwise(() => new Response("fallback"));

  // Make some requests to populate captured list
  await fake.fetch("http://localhost/probe");
  await fake.fetch("http://localhost/send", { method: "POST" });
  assert.equal(fake.requests().length, 2);

  // Reset
  fake.reset();

  // Captured requests should be empty
  assert.equal(fake.requests().length, 0);

  // All handlers should be gone — requests should get the default 599
  const r1 = await fake.fetch("http://localhost/probe");
  assert.equal(r1.status, 599);

  const r2 = await fake.fetch("http://localhost/send", { method: "POST" });
  assert.equal(r2.status, 599);

  // Fallback should also be gone
  const r3 = await fake.fetch("http://localhost/unknown");
  assert.equal(r3.status, 599);
});

test("fakeFetch.reset: subsequent registrations work after reset", async () => {
  const fake = createFakeFetch();

  fake.onGet("/old", () => new Response("old-handler"));
  fake.reset();

  // Old handler is gone
  const r1 = await fake.fetch("http://localhost/old");
  assert.equal(r1.status, 599);

  // New handler works
  fake.onGet("/new", () => new Response("new-handler"));
  const r2 = await fake.fetch("http://localhost/new");
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), "new-handler");
});

// ---------------------------------------------------------------------------
// Teardown restores all env vars to pre-harness values
// ---------------------------------------------------------------------------

test("harness teardown: restores env vars to pre-harness values", () => {
  // Set a sentinel env var before harness
  const sentinelKey = "TEST_HARNESS_SENTINEL";
  process.env[sentinelKey] = "before-harness";

  // Capture pre-harness state of vars the harness overrides
  const preNodeEnv = process.env.NODE_ENV;
  const preAiGateway = process.env.AI_GATEWAY_API_KEY;

  const h = createScenarioHarness();

  // Harness sets NODE_ENV=test and AI_GATEWAY_API_KEY=test-ai-gateway-key
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.AI_GATEWAY_API_KEY, "test-ai-gateway-key");

  // Sentinel should be untouched (harness doesn't override it)
  assert.equal(process.env[sentinelKey], "before-harness");

  h.teardown();

  // After teardown, env vars should be restored to pre-harness values
  assert.equal(process.env.NODE_ENV, preNodeEnv);
  assert.equal(process.env.AI_GATEWAY_API_KEY, preAiGateway);

  // Sentinel still untouched
  assert.equal(process.env[sentinelKey], "before-harness");

  // Clean up sentinel
  delete process.env[sentinelKey];
});

test("harness teardown: vars that were undefined before are undefined after", () => {
  // Ensure these are unset before harness
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const h = createScenarioHarness();

  // Harness deletes them (they map to undefined in ENV_OVERRIDES)
  assert.equal(process.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(process.env.UPSTASH_REDIS_REST_TOKEN, undefined);

  h.teardown();

  // Should still be undefined after teardown
  assert.equal(process.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(process.env.UPSTASH_REDIS_REST_TOKEN, undefined);
});

test("harness installs fakeFetch for the full harness lifetime and restores it on teardown", async () => {
  const originalFetch = globalThis.fetch;
  const h = createScenarioHarness();

  assert.equal(globalThis.fetch, h.fakeFetch.fetch);

  const unhandledFetch = h.fakeFetch.fetch("https://example.com/unmocked");
  await assert.rejects(
    unhandledFetch,
    /Unhandled fetch in test: https:\/\/example\.com\/unmocked/,
  );

  h.fakeFetch.onGet("example.com/handled", () => new Response("ok"));
  const handledResponse = await globalThis.fetch("https://example.com/handled");
  assert.equal(await handledResponse.text(), "ok");

  h.teardown();

  assert.equal(globalThis.fetch, originalFetch);
});

test("harness clears Vercel deployment marker env vars during its lifetime", () => {
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_URL = "branch-openclaw.vercel.app";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "openclaw.vercel.app";

  const h = createScenarioHarness();

  assert.equal(process.env.VERCEL_ENV, undefined);
  assert.equal(process.env.VERCEL_URL, undefined);
  assert.equal(process.env.VERCEL_PROJECT_PRODUCTION_URL, undefined);

  h.teardown();

  assert.equal(process.env.VERCEL_ENV, "preview");
  assert.equal(process.env.VERCEL_URL, "branch-openclaw.vercel.app");
  assert.equal(process.env.VERCEL_PROJECT_PRODUCTION_URL, "openclaw.vercel.app");

  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
});

// ---------------------------------------------------------------------------
// after() callback queue is empty after drainAfterCallbacks()
// ---------------------------------------------------------------------------

test("after callbacks: drainAfterCallbacks empties the queue", async () => {
  resetAfterCallbacks();

  // Schedule some callbacks
  let callCount = 0;
  capturedAfter(() => { callCount += 1; });
  capturedAfter(() => { callCount += 1; });
  capturedAfter(() => { callCount += 1; });

  assert.equal(pendingAfterCount(), 3);

  await drainAfterCallbacks();

  assert.equal(callCount, 3);
  assert.equal(pendingAfterCount(), 0);

  // Draining again should be a no-op
  await drainAfterCallbacks();
  assert.equal(callCount, 3);
  assert.equal(pendingAfterCount(), 0);
});

test("after callbacks: resetAfterCallbacks discards without executing", () => {
  let executed = false;
  capturedAfter(() => { executed = true; });

  assert.equal(pendingAfterCount(), 1);

  resetAfterCallbacks();

  assert.equal(pendingAfterCount(), 0);
  assert.equal(executed, false);
});

test("after callbacks: harness creation clears pending callbacks from prior test", () => {
  // Simulate a prior test leaving stale callbacks
  capturedAfter(() => { throw new Error("stale callback should not run"); });
  assert.equal(pendingAfterCount(), 1);

  // Creating a harness should clear them
  const h = createScenarioHarness();
  assert.equal(pendingAfterCount(), 0);
  h.teardown();

  // Teardown also clears any accumulated during the harness
  assert.equal(pendingAfterCount(), 0);
});

// ---------------------------------------------------------------------------
// Route module cache — verify harness doesn't carry over route state
// ---------------------------------------------------------------------------

test("harness isolation: store is independent between instances (write/read cycle)", async () => {
  const h1 = createScenarioHarness();
  const store1 = h1.getStore();

  // Write a side key
  await store1.setValue("test-key", "harness-1-value");
  const val1 = await store1.getValue("test-key");
  assert.equal(val1, "harness-1-value");
  h1.teardown();

  // New harness — store should be a fresh memory store
  const h2 = createScenarioHarness();
  const store2 = h2.getStore();
  const val2 = await store2.getValue("test-key");
  assert.equal(val2, null);
  h2.teardown();
});

// ---------------------------------------------------------------------------
// Double teardown is safe
// ---------------------------------------------------------------------------

test("harness teardown: calling teardown twice is safe", () => {
  const h = createScenarioHarness();
  h.teardown();
  // Second call should be a no-op, not throw
  h.teardown();
});

// ---------------------------------------------------------------------------
// Auth mode switching between harnesses
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fakeFetch extracts method/headers/body from Request objects
// ---------------------------------------------------------------------------

test("fakeFetch: extracts method from Request when init.method is absent", async () => {
  const fake = createFakeFetch();
  fake.onPost("/api", () => new Response("ok"));

  const req = new Request("http://localhost/api", { method: "POST" });
  const res = await fake.fetch(req);
  assert.equal(res.status, 200);

  const captured = fake.requests();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "POST");
});

test("fakeFetch: extracts headers from Request when init.headers is absent", async () => {
  const fake = createFakeFetch();
  fake.onGet("/api", () => new Response("ok"));

  const req = new Request("http://localhost/api", {
    headers: { "x-custom": "from-request" },
  });
  const res = await fake.fetch(req);
  assert.equal(res.status, 200);

  const captured = fake.requests();
  assert.equal(captured[0].headers?.["x-custom"], "from-request");
});

test("fakeFetch: extracts body from Request when init.body is absent", async () => {
  const fake = createFakeFetch();
  fake.onPost("/api", () => new Response("ok"));

  const req = new Request("http://localhost/api", {
    method: "POST",
    body: "request-body",
  });
  const res = await fake.fetch(req);
  assert.equal(res.status, 200);

  const captured = fake.requests();
  assert.equal(captured[0].body, "request-body");
});

test("fakeFetch: init overrides Request method/headers", async () => {
  const fake = createFakeFetch();
  fake.on("PATCH", "/api", () => new Response("patched"));

  const req = new Request("http://localhost/api", {
    method: "POST",
    headers: { "x-from": "request" },
  });
  // init overrides method and headers
  const res = await fake.fetch(req, {
    method: "PATCH",
    headers: { "x-from": "init" },
  });
  assert.equal(res.status, 200);

  const captured = fake.requests();
  assert.equal(captured[0].method, "PATCH");
  assert.equal(captured[0].headers?.["x-from"], "init");
});

test("fakeFetch: URL string + init still works as before", async () => {
  const fake = createFakeFetch();
  fake.onPost("/send", () => new Response("sent"));

  const res = await fake.fetch("http://localhost/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"msg":"hi"}',
  });
  assert.equal(res.status, 200);

  const captured = fake.requests();
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers?.["content-type"], "application/json");
  assert.equal(captured[0].body, '{"msg":"hi"}');
});

// ---------------------------------------------------------------------------
// Auth mode switching between harnesses
// ---------------------------------------------------------------------------

test("harness isolation: auth mode env vars switch correctly between instances", () => {
  // sign-in-with-vercel mode
  const h1 = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  assert.equal(process.env.VERCEL_AUTH_MODE, "sign-in-with-vercel");
  assert.ok(process.env.SESSION_SECRET);
  h1.teardown();

  // admin-secret mode (default) — SESSION_SECRET is set for admin cookie encryption
  const h2 = createScenarioHarness();
  assert.equal(process.env.VERCEL_AUTH_MODE, undefined);
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET should be set for admin auth");
  h2.teardown();
});
