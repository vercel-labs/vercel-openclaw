import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeNextPath,
  requireRouteAuth,
  _resetProductionAuthCheck,
} from "@/server/auth/vercel-auth";

// ---------------------------------------------------------------------------
// sanitizeNextPath – open redirect prevention
// ---------------------------------------------------------------------------

test("sanitizeNextPath: allows normal absolute paths", () => {
  assert.equal(sanitizeNextPath("/admin"), "/admin");
  assert.equal(sanitizeNextPath("/admin?foo=bar"), "/admin?foo=bar");
  assert.equal(sanitizeNextPath("/gateway/some/path"), "/gateway/some/path");
});

test("sanitizeNextPath: rejects null and empty", () => {
  assert.equal(sanitizeNextPath(null), "/admin");
  assert.equal(sanitizeNextPath(""), "/admin");
});

test("sanitizeNextPath: rejects non-absolute paths", () => {
  assert.equal(sanitizeNextPath("http://evil.com"), "/admin");
  assert.equal(sanitizeNextPath("https://evil.com"), "/admin");
  assert.equal(sanitizeNextPath("evil.com"), "/admin");
});

test("sanitizeNextPath: rejects protocol-relative //evil.com", () => {
  assert.equal(sanitizeNextPath("//evil.com"), "/admin");
  assert.equal(sanitizeNextPath("//evil.com/steal"), "/admin");
});

test("sanitizeNextPath: rejects backslash variants", () => {
  assert.equal(sanitizeNextPath("/\\evil.com"), "/admin");
  assert.equal(sanitizeNextPath("/\\\\evil.com"), "/admin");
});

test("sanitizeNextPath: rejects percent-encoded protocol-relative", () => {
  // %2f = /
  assert.equal(sanitizeNextPath("/%2fevil.com"), "/admin");
  assert.equal(sanitizeNextPath("/%2Fevil.com"), "/admin");
});

test("sanitizeNextPath: rejects percent-encoded backslash", () => {
  // %5c = backslash
  assert.equal(sanitizeNextPath("/%5cevil.com"), "/admin");
  assert.equal(sanitizeNextPath("/%5Cevil.com"), "/admin");
});

test("sanitizeNextPath: rejects control characters", () => {
  assert.equal(sanitizeNextPath("/admin\x00"), "/admin");
  assert.equal(sanitizeNextPath("/admin\t"), "/admin");
  assert.equal(sanitizeNextPath("/admin\n"), "/admin");
});

test("sanitizeNextPath: rejects malformed percent encoding", () => {
  assert.equal(sanitizeNextPath("/%ZZbad"), "/admin");
});

// ---------------------------------------------------------------------------
// requireRouteAuth – production auth mode guard
// ---------------------------------------------------------------------------

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  const restore = () => {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetProductionAuthCheck();
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

test("requireRouteAuth: throws in production with deployment-protection and no opt-in", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      VERCEL_AUTH_MODE: undefined, // defaults to deployment-protection
      ALLOW_PLATFORM_ONLY_AUTH: undefined,
    },
    async () => {
      const req = new Request("http://localhost/admin");
      await assert.rejects(
        () => requireRouteAuth(req),
        /deployment-protection auth mode is unsafe for production/,
      );
    },
  );
});

test("requireRouteAuth: throws with VERCEL=1 and deployment-protection without opt-in", async () => {
  await withEnv(
    {
      NODE_ENV: "development",
      VERCEL: "1",
      VERCEL_AUTH_MODE: undefined,
      ALLOW_PLATFORM_ONLY_AUTH: undefined,
    },
    async () => {
      const req = new Request("http://localhost/admin");
      await assert.rejects(
        () => requireRouteAuth(req),
        /deployment-protection auth mode is unsafe for production/,
      );
    },
  );
});

test("requireRouteAuth: allows deployment-protection in production with ALLOW_PLATFORM_ONLY_AUTH=true", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      VERCEL_AUTH_MODE: undefined,
      ALLOW_PLATFORM_ONLY_AUTH: "true",
    },
    async () => {
      const req = new Request("http://localhost/admin");
      const result = await requireRouteAuth(req);
      // Should not throw and should return a session (not a Response redirect)
      assert.ok(!("status" in result), "Expected AuthCheckResult, not Response");
      assert.equal(result.session.user.sub, "deployment-protection");
    },
  );
});

test("requireRouteAuth: allows deployment-protection in development without opt-in", async () => {
  await withEnv(
    {
      NODE_ENV: "development",
      VERCEL: undefined,
      VERCEL_AUTH_MODE: undefined,
      ALLOW_PLATFORM_ONLY_AUTH: undefined,
    },
    async () => {
      const req = new Request("http://localhost/admin");
      const result = await requireRouteAuth(req);
      assert.ok(!("status" in result), "Expected AuthCheckResult, not Response");
      assert.equal(result.session.user.sub, "deployment-protection");
    },
  );
});
