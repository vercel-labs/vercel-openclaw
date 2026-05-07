import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFastPathException,
  classifyFastPathHttpResult,
  type FastPathClassifierPolicy,
} from "@/server/channels/core/fast-path-classifier";

const telegramPolicy: FastPathClassifierPolicy = {
  channel: "telegram",
  nativeResponsePolicy: "non-ok-starts-workflow",
  classifySuspiciousEmpty200: true,
  stalePortOnSandboxNotListening: 8787,
};

const slackPolicy: FastPathClassifierPolicy = {
  channel: "slack",
  nativeResponsePolicy: "non-ok-starts-workflow",
  stalePortOnSandboxNotListening: 3000,
};

const whatsappPolicy: FastPathClassifierPolicy = {
  channel: "whatsapp",
  nativeResponsePolicy: "gateway-errors-start-workflow-non-gateway-handled",
  stalePortOnSandboxNotListening: 3000,
};

test("fast-path classifier: 2xx response is accepted", () => {
  const outcome = classifyFastPathHttpResult({
    policy: telegramPolicy,
    status: 200,
    ok: true,
    bodyHead: "ok",
    bodyLength: 2,
    durationMs: 500,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.classification, "accepted");
});

test("fast-path classifier: Telegram suspicious empty 200 falls back to workflow", () => {
  const outcome = classifyFastPathHttpResult({
    policy: telegramPolicy,
    status: 200,
    ok: true,
    bodyHead: "",
    bodyLength: 0,
    durationMs: 42,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "suspicious-empty-200");
  assert.equal(outcome.classification, "swallowed-by-base-server");
});

test("fast-path classifier: sandbox-not-listening marks stale port and reconciles", () => {
  const outcome = classifyFastPathHttpResult({
    policy: telegramPolicy,
    status: 502,
    ok: false,
    bodyHead: "This sandbox is not listening on the requested port.",
    bodyLength: 55,
    durationMs: 25,
    transport: "public",
    sandboxUrl: "https://stale.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "sandbox-not-listening");
  assert.equal(outcome.classification, "sandbox-not-listening");
  assert.equal(outcome.shouldReconcile, true);
  assert.equal(outcome.stalePort, 8787);
  assert.equal(outcome.stalePortReason, "fast-path-not-listening");
});

test("fast-path classifier: generic 502 is proxy-error", () => {
  const outcome = classifyFastPathHttpResult({
    policy: slackPolicy,
    status: 502,
    ok: false,
    bodyHead: "bad gateway",
    bodyLength: 11,
    durationMs: 30,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "proxy-error");
  assert.equal(outcome.classification, "proxy-error");
});

test("fast-path classifier: 404 is handler-not-ready", () => {
  const outcome = classifyFastPathHttpResult({
    policy: slackPolicy,
    status: 404,
    ok: false,
    bodyHead: "Not Found",
    bodyLength: 9,
    durationMs: 30,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "handler-not-ready");
  assert.equal(outcome.classification, "handler-not-ready");
});

test("fast-path classifier: Telegram 500 starts workflow as handler error", () => {
  const outcome = classifyFastPathHttpResult({
    policy: telegramPolicy,
    status: 500,
    ok: false,
    bodyHead: "native handler failed",
    bodyLength: 21,
    durationMs: 35,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "handler-error-policy-start-workflow");
  assert.equal(outcome.classification, "handler-error");
});

test("fast-path classifier: WhatsApp non-gateway handler error is handled without workflow", () => {
  const outcome = classifyFastPathHttpResult({
    policy: whatsappPolicy,
    status: 500,
    ok: false,
    bodyHead: "handler saw payload and errored",
    bodyLength: 30,
    durationMs: 40,
    transport: "public",
    sandboxUrl: "https://sbx.example",
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "handled-no-workflow");
  assert.equal(outcome.reason, "non-gateway-handler-response");
  assert.equal(outcome.classification, "handler-error");
});

test("fast-path classifier: fetch exception falls back to workflow", () => {
  const outcome = classifyFastPathException({
    policy: telegramPolicy,
    error: new TypeError("fetch failed"),
    durationMs: 17,
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "fetch-exception");
  assert.equal(outcome.classification, "fetch-exception");
  assert.equal(outcome.shouldReconcile, true);
});

test("fast-path classifier: timeout is an indeterminate fetch exception", () => {
  const error = new Error("operation timed out");
  error.name = "TimeoutError";

  const outcome = classifyFastPathException({
    policy: telegramPolicy,
    error,
    durationMs: 600000,
    sandboxId: "sbx",
  });

  assert.equal(outcome.kind, "fallback-to-workflow");
  assert.equal(outcome.reason, "fast-path-timeout");
  assert.equal(outcome.classification, "fetch-exception");
  assert.equal(outcome.indeterminateDelivery, true);
});
