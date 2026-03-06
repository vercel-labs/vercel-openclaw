import assert from "node:assert/strict";
import test from "node:test";

import {
  readOAuthContextFromRequest,
  readSessionFromRequest,
  serializeOAuthContextCookie,
  serializeSessionCookie,
} from "@/server/auth/session";

test("serializeSessionCookie round-trips through readSessionFromRequest", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      user: {
        sub: "user-123",
        email: "dev@example.com",
      },
    },
    false,
  );

  const request = new Request("https://example.com/api/status", {
    headers: {
      cookie,
    },
  });

  const session = await readSessionFromRequest(request);
  assert.ok(session);
  assert.equal(session.accessToken, "access-token");
  assert.equal(session.refreshToken, "refresh-token");
  assert.equal(session.user.email, "dev@example.com");
});

test("serializeOAuthContextCookie round-trips through readOAuthContextFromRequest", async () => {
  const cookie = await serializeOAuthContextCookie(
    {
      codeVerifier: "verifier-123",
      nonce: "nonce-123",
      next: "/admin",
    },
    false,
  );

  const request = new Request("https://example.com/api/auth/callback", {
    headers: {
      cookie,
    },
  });

  const context = await readOAuthContextFromRequest(request);
  assert.deepEqual(context, {
    codeVerifier: "verifier-123",
    nonce: "nonce-123",
    next: "/admin",
  });
});
