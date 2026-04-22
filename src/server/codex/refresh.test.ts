import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta } from "@/shared/types";
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  CodexRefreshError,
  refreshCodexCredentials,
  refreshCodexCredentialsIfExpiring,
} from "@/server/codex/refresh";
import { withHarness } from "@/test-utils/harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type FakeResponseInit = {
  status?: number;
  body?: unknown;
  text?: string;
};

function jsonResponse(init: FakeResponseInit): Response {
  const status = init.status ?? 200;
  if (init.text !== undefined) {
    return new Response(init.text, { status });
  }
  return new Response(JSON.stringify(init.body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchCall = { url: string; method: string; body?: string };

type FakeFetchImpl = {
  fetch: typeof fetch;
  calls: FetchCall[];
};

/** Minimal fetch stub that records every call and delegates to a handler. */
function makeFakeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FakeFetchImpl {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call: FetchCall = { url, method, body };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Build a JWT with an `exp` claim and optional account_id claim.
 * Only the payload matters — signature verification is never performed.
 */
function buildJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function buildAccessToken(opts: {
  expSeconds: number;
  accountId?: string;
}): string {
  const claims: Record<string, unknown> = { exp: opts.expSeconds };
  if (opts.accountId) {
    claims["https://api.openai.com/auth.chatgpt_account_id"] = opts.accountId;
  }
  return buildJwt(claims);
}

async function seedCodexCredentials(
  harness: { mutateMeta: (fn: (m: SingleMeta) => void) => Promise<SingleMeta> },
  creds: {
    access: string;
    refresh: string;
    expires: number;
    accountId?: string | null;
    updatedAt?: number;
  },
): Promise<void> {
  await harness.mutateMeta((m) => {
    m.codexCredentials = {
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      accountId: creds.accountId ?? null,
      updatedAt: creds.updatedAt ?? Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// refreshCodexCredentials (network helper)
// ---------------------------------------------------------------------------

test("refreshCodexCredentials: posts correct body and parses success", async () => {
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const fake = makeFakeFetch(() =>
    jsonResponse({
      body: {
        access_token: buildAccessToken({ expSeconds, accountId: "acc_123" }),
        refresh_token: "rt_new",
        expires_in: 3600,
        id_token: "idt_new",
      },
    }),
  );

  const result = await refreshCodexCredentials("rt_old", fake.fetch);

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, CODEX_TOKEN_URL);
  assert.equal(fake.calls[0].method, "POST");
  const params = new URLSearchParams(fake.calls[0].body ?? "");
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(params.get("refresh_token"), "rt_old");

  assert.equal(result.refresh, "rt_new");
  assert.equal(result.idToken, "idt_new");
  assert.equal(result.accountId, "acc_123");
  assert.equal(result.expires, expSeconds * 1000);
});

test("refreshCodexCredentials: falls back to expires_in when JWT has no exp", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({
      body: {
        // Access token payload without an `exp` claim.
        access_token: "not-a-valid-jwt",
        refresh_token: "rt_new",
        expires_in: 120,
      },
    }),
  );

  const before = Date.now();
  const result = await refreshCodexCredentials("rt_old", fake.fetch);
  const after = Date.now();

  assert.ok(
    result.expires >= before + 120_000 - 5 && result.expires <= after + 120_000 + 5,
    `expected expires within expires_in window, got ${result.expires}`,
  );
});

test("refreshCodexCredentials: 401 throws CodexRefreshError (non-retryable)", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({ status: 401, text: `{"error":"invalid_grant"}` }),
  );
  await assert.rejects(
    () => refreshCodexCredentials("rt_bad", fake.fetch),
    (err: unknown) => {
      assert.ok(err instanceof CodexRefreshError);
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("refreshCodexCredentials: 500 throws CodexRefreshError (retryable)", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ status: 503, text: "upstream down" }));
  await assert.rejects(
    () => refreshCodexCredentials("rt_any", fake.fetch),
    (err: unknown) => {
      assert.ok(err instanceof CodexRefreshError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("refreshCodexCredentials: missing access_token throws non-retryable", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({ body: { refresh_token: "rt_new", expires_in: 60 } }),
  );
  await assert.rejects(
    () => refreshCodexCredentials("rt_any", fake.fetch),
    (err: unknown) => err instanceof CodexRefreshError && err.retryable === false,
  );
});

test("refreshCodexCredentials: missing expiry info throws non-retryable", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({
      body: {
        access_token: "not-a-valid-jwt",
        refresh_token: "rt_new",
      },
    }),
  );
  await assert.rejects(
    () => refreshCodexCredentials("rt_any", fake.fetch),
    (err: unknown) => err instanceof CodexRefreshError && err.retryable === false,
  );
});

// ---------------------------------------------------------------------------
// refreshCodexCredentialsIfExpiring (lazy refresh with lock + meta mutation)
// ---------------------------------------------------------------------------

test("refreshCodexCredentialsIfExpiring: skips when no codex credentials present", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const fake = makeFakeFetch(() => {
      throw new Error("fetch should not be called");
    });

    const result = await refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
    });

    assert.equal(result.refreshed, false);
    assert.equal(result.skippedReason, "no-codex-active");
    assert.equal(fake.calls.length, 0);
  });
});

test("refreshCodexCredentialsIfExpiring: skips when token is still valid", async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    // Token expires in 1 hour — well outside the default 10 min buffer.
    await seedCodexCredentials(h, {
      access: "at_old",
      refresh: "rt_old",
      expires: now + 60 * 60 * 1000,
    });
    const meta = await h.getMeta();
    const fake = makeFakeFetch(() => {
      throw new Error("fetch should not be called");
    });

    const result = await refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });

    assert.equal(result.refreshed, false);
    assert.equal(result.skippedReason, "still-valid");
    assert.equal(fake.calls.length, 0);
  });
});

test("refreshCodexCredentialsIfExpiring: refreshes when within buffer window", async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    await seedCodexCredentials(h, {
      access: "at_old",
      refresh: "rt_old",
      expires: now + 5 * 60 * 1000, // inside 10-minute buffer
      accountId: "acc_persist",
    });
    const meta = await h.getMeta();

    const newExpSeconds = Math.floor(now / 1000) + 3600;
    const fake = makeFakeFetch(() =>
      jsonResponse({
        body: {
          access_token: buildAccessToken({ expSeconds: newExpSeconds }),
          refresh_token: "rt_rotated",
          expires_in: 3600,
        },
      }),
    );

    const result = await refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });

    assert.equal(result.refreshed, true);
    assert.equal(fake.calls.length, 1);

    const after = await h.getMeta();
    const stored = after.codexCredentials;
    assert.ok(stored, "codex credentials should be persisted");
    assert.equal(stored.refresh, "rt_rotated");
    assert.equal(stored.expires, newExpSeconds * 1000);
    // accountId is preserved from prior state when response does not include a new one
    assert.equal(stored.accountId, "acc_persist");
    assert.equal(stored.updatedAt, now);
  });
});

test("refreshCodexCredentialsIfExpiring: 401 leaves existing creds untouched", async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    await seedCodexCredentials(h, {
      access: "at_old",
      refresh: "rt_old",
      expires: now + 5 * 60 * 1000,
      accountId: "acc_old",
    });
    const meta = await h.getMeta();
    const fake = makeFakeFetch(() => jsonResponse({ status: 401, text: "{}" }));

    const result = await refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });

    assert.equal(result.refreshed, false);
    assert.ok(result.error, "result should include error message on failure");
    assert.equal(fake.calls.length, 1);

    const after = await h.getMeta();
    const stored = after.codexCredentials;
    assert.ok(stored, "existing creds must not be deleted");
    assert.equal(stored.refresh, "rt_old");
    assert.equal(stored.accountId, "acc_old");
  });
});

test("refreshCodexCredentialsIfExpiring: 5xx leaves existing creds untouched", async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    await seedCodexCredentials(h, {
      access: "at_old",
      refresh: "rt_old",
      expires: now + 5 * 60 * 1000,
    });
    const meta = await h.getMeta();
    const fake = makeFakeFetch(() => jsonResponse({ status: 503, text: "down" }));

    const result = await refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });

    assert.equal(result.refreshed, false);
    assert.ok(result.error);

    const after = await h.getMeta();
    const stored = after.codexCredentials;
    assert.ok(stored);
    assert.equal(stored.refresh, "rt_old");
  });
});

test("refreshCodexCredentialsIfExpiring: concurrent calls only refresh once", async () => {
  await withHarness(async (h) => {
    const now = Date.now();
    await seedCodexCredentials(h, {
      access: "at_old",
      refresh: "rt_old",
      expires: now + 5 * 60 * 1000,
    });
    const meta = await h.getMeta();

    let resolveFetch: (() => void) = () => {
      throw new Error("fetch gate resolver not captured");
    };
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });

    const newExpSeconds = Math.floor(now / 1000) + 3600;
    const fake = makeFakeFetch(async () => {
      // Hold the first call until both callers have passed the lock check.
      await fetchGate;
      return jsonResponse({
        body: {
          access_token: buildAccessToken({ expSeconds: newExpSeconds }),
          refresh_token: "rt_rotated",
          expires_in: 3600,
        },
      });
    });

    const p1 = refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });
    const p2 = refreshCodexCredentialsIfExpiring({
      meta,
      fetchImpl: fake.fetch,
      now,
    });

    // Give the lock-contention wait a chance to observe the contention.
    // Both calls have already entered; release the fetch.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    resolveFetch();

    const [r1, r2] = await Promise.all([p1, p2]);

    const refreshed = [r1, r2].filter((r) => r.refreshed).length;
    const contended = [r1, r2].filter(
      (r) => !r.refreshed && r.skippedReason === "lock-contended",
    ).length;
    const validAfterLock = [r1, r2].filter(
      (r) => !r.refreshed && r.skippedReason === "still-valid-after-lock",
    ).length;

    assert.equal(refreshed, 1, "exactly one call should perform the refresh");
    assert.equal(
      contended + validAfterLock,
      1,
      "the other caller should short-circuit via lock contention or post-lock recheck",
    );
    assert.equal(fake.calls.length, 1, "fetch should be invoked exactly once");

    const after = await h.getMeta();
    const stored = after.codexCredentials;
    assert.ok(stored);
    assert.equal(stored.refresh, "rt_rotated");
  });
});
