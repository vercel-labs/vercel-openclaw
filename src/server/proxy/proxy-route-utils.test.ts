import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeProxyHeaders,
  buildSandboxTargetUrl,
  isInvalidProxyTargetPath,
  sanitizeProxyQueryParams,
  stripProxyResponseHeaders,
} from "@/server/proxy/proxy-route-utils";

test("isInvalidProxyTargetPath blocks traversal and encoded slash attacks", () => {
  assert.equal(isInvalidProxyTargetPath("/ok/path"), false);
  assert.equal(isInvalidProxyTargetPath("/../secret"), true);
  assert.equal(isInvalidProxyTargetPath("/api/%2fetc/passwd"), true);
});

test("sanitizeProxyQueryParams strips internal and sensitive parameters", () => {
  const params = new URLSearchParams({
    token: "secret",
    authorization: "Bearer hi",
    keep: "yes",
    _internal: "nope",
  });

  assert.equal(sanitizeProxyQueryParams(params), "keep=yes");
});

test("buildSandboxTargetUrl swaps the path and query onto the sandbox origin", () => {
  const url = buildSandboxTargetUrl("https://sandbox.vercel.run", "/chat", "a=1");
  assert.equal(url.toString(), "https://sandbox.vercel.run/chat?a=1");
});

test("buildSafeProxyHeaders forwards only safe request headers", () => {
  const request = new Request("https://example.com/gateway/chat", {
    headers: {
      accept: "text/html",
      cookie: "nope=1",
      authorization: "Bearer blocked",
      "user-agent": "browser",
    },
  });

  const headers = buildSafeProxyHeaders(request, "https://sandbox.vercel.run/chat", {
    authorization: "Bearer sandbox-token",
  });

  assert.equal(headers.get("accept"), "text/html");
  assert.equal(headers.get("authorization"), "Bearer sandbox-token");
  assert.equal(headers.get("cookie"), null);
});

test("stripProxyResponseHeaders removes sensitive response headers", () => {
  const headers = new Headers({
    "content-type": "text/html",
    "set-cookie": "secret=1",
    "content-security-policy": "default-src 'self'",
  });

  const stripped = stripProxyResponseHeaders(headers, ["secret"]);
  assert.equal(stripped.get("content-type"), "text/html");
  assert.equal(stripped.get("set-cookie"), null);
  assert.equal(stripped.get("content-security-policy"), null);
});
