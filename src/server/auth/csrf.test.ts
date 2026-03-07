import assert from "node:assert/strict";
import test from "node:test";

import { verifyCsrf } from "@/server/auth/csrf";

// ---------------------------------------------------------------------------
// verifyCsrf – CSRF protection via Origin / X-Requested-With
// ---------------------------------------------------------------------------

test("verifyCsrf: allows GET requests without any headers", () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "GET",
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: allows HEAD requests without any headers", () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "HEAD",
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: allows OPTIONS requests without any headers", () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "OPTIONS",
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: allows POST with matching Origin header", () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: allows PUT with matching Origin header", () => {
  const req = new Request("http://localhost:3000/api/channels/slack", {
    method: "PUT",
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: allows DELETE with matching Origin header", () => {
  const req = new Request("http://localhost:3000/api/channels/slack", {
    method: "DELETE",
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: rejects POST with cross-origin Origin header", async () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { origin: "http://evil.com" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_ORIGIN_MISMATCH");
});

test("verifyCsrf: rejects PUT with cross-origin Origin header", async () => {
  const req = new Request("http://localhost:3000/api/firewall", {
    method: "PUT",
    headers: { origin: "https://attacker.example" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_ORIGIN_MISMATCH");
});

test("verifyCsrf: rejects DELETE with cross-origin Origin header", async () => {
  const req = new Request("http://localhost:3000/api/firewall/allowlist", {
    method: "DELETE",
    headers: { origin: "https://malicious.site" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_ORIGIN_MISMATCH");
});

test("verifyCsrf: rejects POST with no Origin and no X-Requested-With", async () => {
  const req = new Request("http://localhost:3000/api/admin/stop", {
    method: "POST",
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_HEADER_MISSING");
});

test("verifyCsrf: allows POST with X-Requested-With and no Origin", () => {
  const req = new Request("http://localhost:3000/api/admin/snapshot", {
    method: "POST",
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: rejects POST with wrong X-Requested-With value", async () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { "x-requested-with": "SomeOtherValue" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_HEADER_MISSING");
});

test("verifyCsrf: Origin check takes precedence over X-Requested-With", async () => {
  // Even with X-Requested-With, a cross-origin Origin header should fail
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: {
      origin: "http://evil.com",
      "x-requested-with": "XMLHttpRequest",
    },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "CSRF_ORIGIN_MISMATCH");
});

test("verifyCsrf: matching Origin with trailing slash is normalized", () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { origin: "http://localhost:3000/" },
  });
  // new URL("http://localhost:3000/").origin === "http://localhost:3000"
  assert.equal(verifyCsrf(req), null);
});

test("verifyCsrf: matching Origin with different port rejects", async () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { origin: "http://localhost:4000" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
});

test("verifyCsrf: matching Origin with https vs http rejects", async () => {
  const req = new Request("http://localhost:3000/api/admin/ensure", {
    method: "POST",
    headers: { origin: "https://localhost:3000" },
  });
  const response = verifyCsrf(req);
  assert.ok(response instanceof Response, "Expected a Response");
  assert.equal(response.status, 403);
});
