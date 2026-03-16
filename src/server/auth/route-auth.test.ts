/**
 * Tests for route-level auth: requireRouteAuth and sanitizeNextPath.
 *
 * Tests both auth modes:
 *   - admin-secret: always returns a synthetic session
 *   - sign-in-with-vercel: requires valid encrypted session cookie
 */

import assert from "node:assert/strict";
import test from "node:test";

import { requireRouteAuth, sanitizeNextPath } from "@/server/auth/vercel-auth";

// ---------------------------------------------------------------------------
// Set env for admin-secret mode (default)
// ---------------------------------------------------------------------------

const originalAuthMode = process.env.VERCEL_AUTH_MODE;

function setAuthMode(mode: string | undefined) {
  if (mode === undefined) {
    delete process.env.VERCEL_AUTH_MODE;
  } else {
    process.env.VERCEL_AUTH_MODE = mode;
  }
}

// ---------------------------------------------------------------------------
// requireRouteAuth — admin-secret mode
// ---------------------------------------------------------------------------

test("route-auth: admin-secret returns synthetic session", async () => {
  setAuthMode(undefined);
  try {
    const req = new Request("http://localhost:3000/admin");
    const result = await requireRouteAuth(req);
    // Should not be a Response (redirect/error) — it should be an AuthCheckResult
    assert.ok(!("status" in result && typeof (result as Response).status === "number" && (result as Response).headers !== undefined && result instanceof Response),
      "should return AuthCheckResult, not Response");
    const authResult = result as { session: { user: { sub: string } }; setCookieHeader: string | null };
    assert.equal(authResult.session.user.sub, "admin-secret");
    assert.equal(authResult.setCookieHeader, null);
  } finally {
    setAuthMode(originalAuthMode);
  }
});

test("route-auth: admin-secret ignores json mode option", async () => {
  setAuthMode(undefined);
  try {
    const req = new Request("http://localhost:3000/api/status");
    const result = await requireRouteAuth(req, { mode: "json" });
    assert.ok(!(result instanceof Response));
    const authResult = result as { session: { user: { sub: string } } };
    assert.equal(authResult.session.user.sub, "admin-secret");
  } finally {
    setAuthMode(originalAuthMode);
  }
});

// ---------------------------------------------------------------------------
// requireRouteAuth — sign-in-with-vercel without session
// ---------------------------------------------------------------------------

test("route-auth: sign-in-with-vercel without cookie returns redirect (default mode)", async () => {
  setAuthMode("sign-in-with-vercel");
  try {
    const req = new Request("http://localhost:3000/admin");
    const result = await requireRouteAuth(req);
    assert.ok(result instanceof Response, "should return a Response for unauthenticated");
    assert.equal(result.status, 302);
    const location = result.headers.get("Location");
    assert.ok(location, "should have Location header");
    assert.ok(location.includes("/api/auth/authorize"), "should redirect to authorize");
  } finally {
    setAuthMode(originalAuthMode);
  }
});

test("route-auth: sign-in-with-vercel without cookie returns 401 JSON", async () => {
  setAuthMode("sign-in-with-vercel");
  try {
    const req = new Request("http://localhost:3000/api/status");
    const result = await requireRouteAuth(req, { mode: "json" });
    assert.ok(result instanceof Response);
    assert.equal(result.status, 401);
    const body = await result.json() as { error: string; authorizeUrl: string };
    assert.equal(body.error, "UNAUTHORIZED");
    assert.ok(body.authorizeUrl.includes("/api/auth/authorize"));
  } finally {
    setAuthMode(originalAuthMode);
  }
});

// ---------------------------------------------------------------------------
// sanitizeNextPath
// ---------------------------------------------------------------------------

test("route-auth: sanitizeNextPath returns /admin for null", () => {
  assert.equal(sanitizeNextPath(null), "/admin");
});

test("route-auth: sanitizeNextPath returns /admin for empty string", () => {
  assert.equal(sanitizeNextPath(""), "/admin");
});

test("route-auth: sanitizeNextPath returns /admin for non-/ prefix", () => {
  assert.equal(sanitizeNextPath("https://evil.com"), "/admin");
});

test("route-auth: sanitizeNextPath accepts valid paths", () => {
  assert.equal(sanitizeNextPath("/admin"), "/admin");
  assert.equal(sanitizeNextPath("/gateway/foo"), "/gateway/foo");
  assert.equal(sanitizeNextPath("/api/status?x=1"), "/api/status?x=1");
});

test("route-auth: sanitizeNextPath rejects protocol-relative paths", () => {
  assert.equal(sanitizeNextPath("//evil.com"), "/admin");
  assert.equal(sanitizeNextPath("/\\evil.com"), "/admin");
});

test("route-auth: sanitizeNextPath rejects encoded protocol-relative paths", () => {
  assert.equal(sanitizeNextPath("/%2Fevil.com"), "/admin");
  assert.equal(sanitizeNextPath("/%5Cevil.com"), "/admin");
});

test("route-auth: sanitizeNextPath rejects control characters", () => {
  assert.equal(sanitizeNextPath("/admin\x00"), "/admin");
  assert.equal(sanitizeNextPath("/admin\t"), "/admin");
});
