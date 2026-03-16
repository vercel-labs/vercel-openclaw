/**
 * Vercel auth tests.
 *
 * Covers:
 * - sanitizeNextPath: open redirect prevention (all vectors)
 * - requireRouteAuth: admin-secret mode defaults
 * - requireRouteAuth: sign-in-with-vercel mode with valid/expired/missing sessions
 * - requireRouteAuth: refresh token success returns updated session + Set-Cookie
 * - requireRouteAuth: refresh failure clears session (401 + Max-Age=0)
 * - requireRouteAuth: json vs redirect response modes
 * - buildAuthorizeResponse: PKCE parameters and state/context cookies
 * - buildSignoutResponse: clears all auth cookies
 *
 * Run: npm test -- src/server/auth/vercel-auth.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeNextPath,
  requireRouteAuth,
  buildAuthorizeResponse,
  buildSignoutResponse,
} from "@/server/auth/vercel-auth";
import {
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_CONTEXT_COOKIE_NAME,
} from "@/server/auth/session";

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

const SIGN_IN_ENV: Record<string, string> = {
  VERCEL_AUTH_MODE: "sign-in-with-vercel",
  SESSION_SECRET: "test-session-secret-for-smoke-tests",
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "oac_test_client_id",
  VERCEL_APP_CLIENT_SECRET: "test_client_secret",
  NEXT_PUBLIC_BASE_DOMAIN: "http://localhost:3000",
};

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "SESSION_SECRET",
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
  "NEXT_PUBLIC_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
];

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key];
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
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

function withSignInEnv(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      ...SIGN_IN_ENV,
      NODE_ENV: "test",
      VERCEL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
    },
    fn,
  ) as Promise<void>;
}

function withDeploymentProtectionEnv(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      VERCEL_AUTH_MODE: undefined,
      SESSION_SECRET: undefined,
      NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: undefined,
      VERCEL_APP_CLIENT_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
    },
    fn,
  ) as Promise<void>;
}

/** Build a session cookie for test requests. */
async function buildTestCookie(opts?: {
  expiresAt?: number;
  refreshToken?: string | null;
}): Promise<string> {
  const setCookie = await serializeSessionCookie(
    {
      accessToken: "test-access-token",
      refreshToken: opts?.refreshToken ?? "test-refresh-token",
      expiresAt: opts?.expiresAt ?? Date.now() + 60 * 60 * 1000,
      user: { sub: "test-user-123", email: "dev@example.com" },
    },
    false,
  );
  // Extract just name=value for the Cookie header
  return setCookie.split(";")[0]!;
}

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
// requireRouteAuth – admin-secret mode
// ---------------------------------------------------------------------------

test("requireRouteAuth: returns admin-secret session by default", async () => {
  await withDeploymentProtectionEnv(async () => {
    const req = new Request("http://localhost/admin");
    const result = await requireRouteAuth(req);
    assert.ok(!("status" in result), "Expected AuthCheckResult, not Response");
    assert.equal(result.session.user.sub, "admin-secret");
    assert.equal(result.setCookieHeader, null, "No cookie for dp mode");
  });
});

test("requireRouteAuth: returns admin-secret session in development", async () => {
  await withEnv(
    { NODE_ENV: "development", VERCEL_AUTH_MODE: undefined },
    async () => {
      const req = new Request("http://localhost/admin");
      const result = await requireRouteAuth(req);
      assert.ok(!("status" in result), "Expected AuthCheckResult, not Response");
      assert.equal(result.session.user.sub, "admin-secret");
    },
  );
});

test("requireRouteAuth: admin-secret session has non-expired expiresAt", async () => {
  await withDeploymentProtectionEnv(async () => {
    const req = new Request("http://localhost/admin");
    const result = await requireRouteAuth(req);
    assert.ok(!("status" in result));
    assert.ok(result.session.expiresAt > Date.now(), "expiresAt should be in the future");
  });
});

// ---------------------------------------------------------------------------
// requireRouteAuth – sign-in-with-vercel mode: unauthenticated
// ---------------------------------------------------------------------------

test("requireRouteAuth: unauthenticated request in sign-in mode returns redirect (302)", async () => {
  await withSignInEnv(async () => {
    const req = new Request("http://localhost:3000/admin");
    const result = await requireRouteAuth(req);
    assert.ok("status" in result, "Expected a Response");
    assert.equal(result.status, 302);
    const location = result.headers.get("location") ?? "";
    assert.ok(location.includes("/api/auth/authorize"), "Should redirect to authorize");
  });
});

test("requireRouteAuth: unauthenticated request in json mode returns 401 with authorizeUrl", async () => {
  await withSignInEnv(async () => {
    const req = new Request("http://localhost:3000/api/status");
    const result = await requireRouteAuth(req, { mode: "json" });
    assert.ok("status" in result, "Expected a Response");
    assert.equal(result.status, 401);
    const body = await result.json();
    assert.equal(body.error, "UNAUTHORIZED");
    assert.ok(body.authorizeUrl.includes("/api/auth/authorize"));
  });
});

// ---------------------------------------------------------------------------
// requireRouteAuth – sign-in-with-vercel mode: valid session
// ---------------------------------------------------------------------------

test("requireRouteAuth: valid non-expired session passes through", async () => {
  await withSignInEnv(async () => {
    const cookie = await buildTestCookie();
    const req = new Request("http://localhost:3000/admin", {
      headers: { cookie },
    });
    const result = await requireRouteAuth(req);
    assert.ok(!("status" in result), "Expected AuthCheckResult");
    assert.equal(result.session.user.sub, "test-user-123");
    assert.equal(result.setCookieHeader, null, "No cookie refresh needed");
  });
});

// ---------------------------------------------------------------------------
// requireRouteAuth – sign-in-with-vercel mode: expired session, no refresh token
// ---------------------------------------------------------------------------

test("requireRouteAuth: expired session without refresh token returns 401", async () => {
  await withSignInEnv(async () => {
    const cookie = await buildTestCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: null,
    });
    const req = new Request("http://localhost:3000/api/status", {
      headers: { cookie },
    });
    const result = await requireRouteAuth(req, { mode: "json" });
    assert.ok("status" in result, "Expected a Response");
    assert.equal(result.status, 401);
  });
});

// ---------------------------------------------------------------------------
// requireRouteAuth – sign-in-with-vercel mode: expired session, refresh succeeds
// ---------------------------------------------------------------------------

test("requireRouteAuth: expired session with successful refresh returns updated session + Set-Cookie", async () => {
  await withSignInEnv(async () => {
    const cookie = await buildTestCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "valid-refresh-token",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
            // No id_token → will reuse previous session user
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const req = new Request("http://localhost:3000/admin", {
        headers: { cookie },
      });
      const result = await requireRouteAuth(req);
      assert.ok(!("status" in result), "Expected AuthCheckResult after refresh");
      assert.equal(result.session.accessToken, "new-access-token");
      assert.equal(result.session.refreshToken, "new-refresh-token");
      assert.ok(result.session.expiresAt > Date.now(), "New expiresAt in future");
      assert.equal(result.session.user.sub, "test-user-123", "User preserved");
      assert.ok(
        result.setCookieHeader !== null,
        "Should include Set-Cookie for refreshed session",
      );
      assert.ok(
        result.setCookieHeader!.includes(SESSION_COOKIE_NAME),
        "Set-Cookie should contain session cookie name",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// requireRouteAuth – sign-in-with-vercel mode: expired session, refresh fails
// ---------------------------------------------------------------------------

test("requireRouteAuth: expired session with failed refresh returns 302 with cleared cookie", async () => {
  await withSignInEnv(async () => {
    const cookie = await buildTestCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "bad-refresh-token",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const req = new Request("http://localhost:3000/gateway", {
        headers: { cookie },
      });
      const result = await requireRouteAuth(req);
      assert.ok("status" in result, "Expected a Response");
      assert.equal(result.status, 302);

      // Session cookie should be cleared
      const setCookieHeaders = result.headers.get("set-cookie") ?? "";
      assert.ok(
        setCookieHeaders.includes("Max-Age=0"),
        "Session should be cleared with Max-Age=0",
      );
      assert.ok(
        setCookieHeaders.includes(SESSION_COOKIE_NAME),
        "Should clear session cookie",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("requireRouteAuth: expired session with failed refresh in json mode returns 401", async () => {
  await withSignInEnv(async () => {
    const cookie = await buildTestCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "bad-refresh-token",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const req = new Request("http://localhost:3000/api/status", {
        headers: { cookie },
      });
      const result = await requireRouteAuth(req, { mode: "json" });
      assert.ok("status" in result, "Expected a Response");
      assert.equal(result.status, 401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeResponse
// ---------------------------------------------------------------------------

/**
 * Response.redirect() in Node.js creates an immutable response.
 * buildAuthorizeResponse appends Set-Cookie headers after redirect,
 * which works in Next.js runtime but not in bare Node.js tests.
 * We patch Response.redirect to return a mutable response for these tests.
 */
function withMutableRedirect<T>(fn: () => Promise<T>): Promise<T> {
  const original = Response.redirect;
  (Response as { redirect: typeof Response.redirect }).redirect = (
    url: string | URL,
    status?: number,
  ) => {
    return new Response(null, {
      status: status ?? 302,
      headers: { Location: typeof url === "string" ? url : url.toString() },
    });
  };
  return fn().finally(() => {
    (Response as { redirect: typeof Response.redirect }).redirect = original;
  });
}

test("buildAuthorizeResponse: redirects to Vercel OAuth with PKCE params", async () => {
  await withSignInEnv(async () => {
    await withMutableRedirect(async () => {
      const req = new Request("http://localhost:3000/api/auth/authorize?next=/gateway");
      const response = await buildAuthorizeResponse(req);

      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location")!);
      assert.equal(location.hostname, "vercel.com");
      assert.equal(location.pathname, "/oauth/authorize");

      // PKCE parameters
      assert.ok(location.searchParams.has("code_challenge"));
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("response_type"), "code");
      assert.ok(location.searchParams.get("scope")!.includes("openid"));
      assert.ok(location.searchParams.has("state"));
      assert.ok(location.searchParams.has("nonce"));

      // Should set state and context cookies
      const setCookies = response.headers.getSetCookie?.() ?? [];
      const cookieStr = setCookies.join("; ");
      assert.ok(
        cookieStr.includes(OAUTH_STATE_COOKIE_NAME),
        "Should set OAuth state cookie",
      );
      assert.ok(
        cookieStr.includes(OAUTH_CONTEXT_COOKIE_NAME),
        "Should set OAuth context cookie",
      );
    });
  });
});

test("buildAuthorizeResponse: in admin-secret mode, redirects to /admin", async () => {
  await withDeploymentProtectionEnv(async () => {
    await withMutableRedirect(async () => {
      const req = new Request("http://localhost:3000/api/auth/authorize");
      const response = await buildAuthorizeResponse(req);

      assert.equal(response.status, 302);
      const location = response.headers.get("location")!;
      assert.ok(location.includes("/admin"), "Should redirect to /admin in dp mode");
    });
  });
});

// ---------------------------------------------------------------------------
// buildSignoutResponse
// ---------------------------------------------------------------------------

test("buildSignoutResponse: clears all three auth cookies", async () => {
  await withSignInEnv(async () => {
    await withMutableRedirect(async () => {
      const req = new Request("http://localhost:3000/api/auth/signout");
      const response = await buildSignoutResponse(req);

      assert.equal(response.status, 302);
      const location = response.headers.get("location")!;
      assert.ok(location.endsWith("/"), "Should redirect to /");

      const setCookies = response.headers.getSetCookie?.() ?? [];
      const allCookies = setCookies.join(" ");
      assert.ok(allCookies.includes(SESSION_COOKIE_NAME), "Should clear session cookie");
      assert.ok(allCookies.includes(OAUTH_STATE_COOKIE_NAME), "Should clear OAuth state cookie");
      assert.ok(allCookies.includes(OAUTH_CONTEXT_COOKIE_NAME), "Should clear OAuth context cookie");

      // All should have Max-Age=0
      for (const sc of setCookies) {
        assert.ok(sc.includes("Max-Age=0"), `Cookie should be cleared: ${sc.slice(0, 40)}...`);
      }
    });
  });
});
