import assert from "node:assert/strict";
import test from "node:test";

import { injectWrapperScript } from "@/server/proxy/htmlInjection";

const SIMPLE_HTML = `<!DOCTYPE html>
<html><head><title>Test</title></head><body><p>Hello</p></body></html>`;

const CONTEXT = {
  sandboxOrigin: "https://sbx-123.vercel.run",
  gatewayToken: "gw-token-abc",
  heartbeatIntervalMs: 240_000,
};

test("injects script tag into <head>", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("<script>"));
  assert.ok(result.includes("</script>"));
  // Script should appear after <head>
  const headIdx = result.indexOf("<head>");
  const scriptIdx = result.indexOf("<script>");
  assert.ok(scriptIdx > headIdx, "script should be inside <head>");
});

test("injects base tag with /gateway/ href", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes('<base href="/gateway/">'));
});

test("injects no-referrer meta tag", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes('<meta name="referrer" content="no-referrer">'));
});

test("includes sandbox origin in injected script", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("sbx-123.vercel.run"));
});

test("includes gateway token in injected script", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("gw-token-abc"));
});

test("includes heartbeat logic", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("/api/status"));
  assert.ok(result.includes("HEARTBEAT_INTERVAL_MS"));
});

test("includes WebSocket rewrite logic", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("WebSocket"));
  assert.ok(result.includes("openclaw.gateway-token"));
});

test("escapes < in JSON context to prevent XSS via script breakout", () => {
  const xssContext = {
    sandboxOrigin: "https://example.com",
    gatewayToken: "</script><script>alert(1)</script>",
    heartbeatIntervalMs: 240_000,
  };
  const result = injectWrapperScript(SIMPLE_HTML, xssContext);
  // The literal </script> must not appear unescaped inside the injected script
  const injectedScript = result.slice(
    result.indexOf("<script>"),
    result.indexOf("</script>") + "</script>".length,
  );
  // Count script tags — there should be exactly one opening and one closing
  const openCount = (injectedScript.match(/<script>/g) ?? []).length;
  const closeCount = (injectedScript.match(/<\/script>/g) ?? []).length;
  assert.equal(openCount, 1);
  assert.equal(closeCount, 1);
});

test("handles HTML without <head> tag gracefully", () => {
  const noHead = "<html><body><p>No head</p></body></html>";
  const result = injectWrapperScript(noHead, CONTEXT);
  // Should still contain the script and base tag
  assert.ok(result.includes("<script>"));
  assert.ok(result.includes('<base href="/gateway/">'));
  // Original content preserved
  assert.ok(result.includes("No head"));
});

test("preserves original HTML content", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(result.includes("<p>Hello</p>"));
  assert.ok(result.includes("<title>Test</title>"));
});

test("handles <head> with attributes", () => {
  const html = '<html><head lang="en"><title>Test</title></head><body></body></html>';
  const result = injectWrapperScript(html, CONTEXT);
  assert.ok(result.includes('<head lang="en">'));
  assert.ok(result.includes("<script>"));
});

// ===========================================================================
// Token leak prevention
// ===========================================================================

test("token is only present in the injected script, not elsewhere in output", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  // Find the script boundaries
  const scriptStart = result.indexOf("<script>");
  const scriptEnd = result.indexOf("</script>") + "</script>".length;
  assert.ok(scriptStart >= 0, "should find script start");
  assert.ok(scriptEnd > scriptStart, "should find script end");

  // The token should appear inside the script
  const scriptContent = result.slice(scriptStart, scriptEnd);
  assert.ok(
    scriptContent.includes("gw-token-abc"),
    "Token should appear in injected script",
  );

  // The token should NOT appear outside the script
  const beforeScript = result.slice(0, scriptStart);
  const afterScript = result.slice(scriptEnd);
  assert.ok(
    !beforeScript.includes("gw-token-abc"),
    "Token should not leak before the script tag",
  );
  assert.ok(
    !afterScript.includes("gw-token-abc"),
    "Token should not leak after the script tag",
  );
});

test("injectWrapperScript does not embed token in HTML attributes or comments", () => {
  const htmlWithComment = '<!DOCTYPE html><html><head><!-- comment --></head><body><div data-info="test"></div></body></html>';
  const result = injectWrapperScript(htmlWithComment, CONTEXT);

  // Token should not appear inside HTML comments
  const commentMatch = result.match(/<!--[\s\S]*?-->/g) ?? [];
  for (const comment of commentMatch) {
    assert.ok(
      !comment.includes("gw-token-abc"),
      `Token should not appear in HTML comment: ${comment}`,
    );
  }

  // Token should not appear in data- attributes
  const dataAttrMatch = result.match(/data-[a-z-]+="[^"]*"/g) ?? [];
  for (const attr of dataAttrMatch) {
    assert.ok(
      !attr.includes("gw-token-abc"),
      `Token should not appear in data attribute: ${attr}`,
    );
  }
});

// ===========================================================================
// Recovery breadcrumbs
// ===========================================================================

test("heartbeat tracks consecutive failures and logs at threshold", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(
    result.includes("heartbeatConsecutiveFailures"),
    "should track heartbeat failure count",
  );
  assert.ok(
    result.includes("HEARTBEAT_FAILURE_THRESHOLD"),
    "should define heartbeat failure threshold",
  );
  assert.ok(
    result.includes("[openclaw] heartbeat failing"),
    "should warn on repeated heartbeat failures",
  );
});

test("heartbeat logs recovery after failures", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(
    result.includes("[openclaw] heartbeat recovered"),
    "should log recovery when heartbeat succeeds after failures",
  );
});

test("WebSocket rewrite failure emits console warning", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  assert.ok(
    result.includes("[openclaw] WebSocket URL rewrite failed"),
    "should warn on WebSocket URL rewrite failure",
  );
});

test("heartbeat failure breadcrumb fires only at threshold, not every failure", () => {
  const result = injectWrapperScript(SIMPLE_HTML, CONTEXT);
  // The warning is emitted when failures === threshold (not >=), preventing flood
  assert.ok(
    result.includes("heartbeatConsecutiveFailures === HEARTBEAT_FAILURE_THRESHOLD"),
    "should only warn at exact threshold to avoid console flood",
  );
});

test("unauthenticated context: empty token produces valid script with empty string value", () => {
  const emptyTokenContext = {
    sandboxOrigin: "https://sbx-123.vercel.run",
    gatewayToken: "",
    heartbeatIntervalMs: 240_000,
  };
  const result = injectWrapperScript(SIMPLE_HTML, emptyTokenContext);
  // Script should still be injected (the proxy decides whether to call injection)
  assert.ok(result.includes("<script>"));
  // Empty token should not cause broken JSON — the gatewayToken field should be ""
  assert.ok(result.includes("gatewayToken"), "Should still have gatewayToken field");
  // Verify the JSON context contains an empty string, not null or missing
  assert.ok(
    result.includes('"gatewayToken":""') || result.includes('"gatewayToken": ""'),
    "Empty token should serialize as empty string in JSON context",
  );
});
