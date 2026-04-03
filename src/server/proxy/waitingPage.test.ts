import assert from "node:assert/strict";
import test from "node:test";

import { getWaitingPageHtml } from "@/server/proxy/waitingPage";

test("renders known status labels", () => {
  const cases: Array<[string, string]> = [
    ["creating", "Creating sandbox"],
    ["setup", "Installing OpenClaw"],
    ["restoring", "Restoring snapshot"],
    ["booting", "Waiting for gateway"],
    ["starting", "Starting"],
  ];

  for (const [status, label] of cases) {
    const html = getWaitingPageHtml("/gateway", status);
    assert.ok(html.includes(label), `Expected "${label}" for status "${status}"`);
  }
});

test("falls back to Starting for unknown status", () => {
  const html = getWaitingPageHtml("/gateway", "whatever");
  assert.ok(html.includes("Starting"));
});

test("includes status polling script", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  assert.ok(html.includes("/api/status?health=1"));
  assert.ok(html.includes("setInterval"));
});

test("includes return path in data attribute", () => {
  const html = getWaitingPageHtml("/gateway/some/path", "booting");
  assert.ok(html.includes('data-return-path="/gateway/some/path"'));
});

test("polling script checks for running + gatewayReady", () => {
  const html = getWaitingPageHtml("/gateway", "setup");
  assert.ok(html.includes("payload.status === 'running'"));
  assert.ok(html.includes("payload.gatewayReady"));
});

test("escapes HTML special characters in return path", () => {
  const html = getWaitingPageHtml('/gateway?a=1&b="<img>', "creating");
  // The data attribute should contain escaped values
  assert.ok(html.includes("&amp;"), "& should be escaped");
  assert.ok(html.includes("&lt;"), "< should be escaped");
  assert.ok(html.includes("&quot;"), '" should be escaped');
  // Raw dangerous chars should not appear in the data-return-path attribute
  assert.ok(
    !html.includes('data-return-path="/gateway?a=1&b="<img>"'),
    "unescaped path should not appear",
  );
});

test("escapes HTML special characters in status label", () => {
  // Unknown status falls back to "Starting" so this tests that the
  // fallback is used rather than injecting raw HTML
  const html = getWaitingPageHtml("/gateway", '<img src=x onerror="alert(1)">');
  assert.ok(html.includes("Starting"));
  assert.ok(!html.includes('onerror="alert(1)"'));
});

test("renders valid HTML document structure", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("<html"));
  assert.ok(html.includes("<head>"));
  assert.ok(html.includes("</head>"));
  assert.ok(html.includes("<body>"));
  assert.ok(html.includes("</body>"));
  assert.ok(html.includes("</html>"));
});

test("includes polling interval hint text", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  assert.ok(html.includes("Polling /api/status every 2s"));
});

test("tracks consecutive poll failures and updates hint element", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  assert.ok(
    html.includes("consecutiveFailures"),
    "should track consecutive failures",
  );
  assert.ok(
    html.includes("FAILURE_THRESHOLD"),
    "should define a failure threshold",
  );
  assert.ok(
    html.includes("Status poll failing"),
    "should show failure breadcrumb text",
  );
  assert.ok(
    html.includes("Still retrying"),
    "should indicate retries continue",
  );
});

test("resets failure state on successful poll", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  // On successful response, consecutiveFailures is reset to 0
  assert.ok(
    html.includes("consecutiveFailures = 0"),
    "should reset failure counter on success",
  );
  assert.ok(
    html.includes("updateHint(0)"),
    "should clear hint on success",
  );
});

test("increments failure counter on non-OK response", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  // The non-OK branch increments and updates hint
  assert.ok(
    html.includes("consecutiveFailures += 1"),
    "should increment on failure",
  );
});

test("increments failure counter on fetch exception", () => {
  const html = getWaitingPageHtml("/gateway", "creating");
  // The catch branch also increments and updates
  const catchIndex = html.indexOf("catch (error)");
  assert.ok(catchIndex > 0, "should have catch block");
  const afterCatch = html.slice(catchIndex);
  assert.ok(
    afterCatch.includes("consecutiveFailures += 1"),
    "catch block should increment failure counter",
  );
});
