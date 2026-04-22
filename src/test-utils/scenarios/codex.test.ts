/**
 * Tests for the Codex scenario fixture and the Codex remote-smoke phases.
 *
 * The fixture tests cover both modes:
 *   - "codex": auth-profiles.json is written, network policy has no AI Gateway
 *     Authorization transform, and openclaw.json selects the Codex model
 *   - "ai-gateway": baseline path preserves the AI Gateway transform
 *
 * The phase tests verify the new smoke phases gracefully handle the
 * "Codex not configured" case (skip, not fail), never leak tokens in
 * failure detail, and correctly use the Codex-specific endpoints.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  makeCodexFixture,
  recordGatewayCompletions,
  CODEX_MODEL_ID,
  CODEX_AUTH_PROFILES_PATH,
  CODEX_RESPONSES_HOST,
  CODEX_AUTH_HOST,
} from "@/test-utils/scenarios/codex";
import {
  codexStatus,
  codexChatCompletions,
  codexWakeFromSleep,
  sanitizeCodexBody,
} from "@/server/smoke/remote-phases";

// ---------------------------------------------------------------------------
// Scenario fixture — Codex mode
// ---------------------------------------------------------------------------

test("codex fixture: writes auth-profiles.json and Codex-aware openclaw.json", async () => {
  await withHarness(async (h) => {
    const fx = makeCodexFixture(h, { mode: "codex" });
    const config = await fx.performRestore();

    fx.assertAuthProfilesWritten();
    fx.assertOpenclawConfig(config);

    // Sanity: the openclaw.json content was also written to the sandbox.
    const openclawJson = fx.handle.writtenFiles.find(
      (f) => f.path === "/home/vercel-sandbox/.openclaw/openclaw.json",
    );
    assert.ok(openclawJson, "openclaw.json should be written in codex mode");
    const parsed = JSON.parse(openclawJson.content.toString("utf8")) as {
      auth?: { profiles?: Record<string, { provider?: string }> };
      agents?: { defaults?: { model?: { primary?: string } } };
    };
    assert.equal(
      parsed.auth?.profiles?.["openai-codex:default"]?.provider,
      "openai-codex",
    );
    assert.equal(parsed.agents?.defaults?.model?.primary, CODEX_MODEL_ID);
  });
});

test("codex fixture: network policy omits AI Gateway bearer, allows Codex hosts", async () => {
  await withHarness(async (h) => {
    const fx = makeCodexFixture(h, { mode: "codex" });
    await fx.performRestore();

    assert.equal(fx.handle.networkPolicies.length, 1);
    const policy = fx.handle.networkPolicies[0];
    fx.assertNetworkPolicy(policy);
  });
});

test("codex fixture: outbound chat completions route through chatgpt.com", async () => {
  await withHarness(async (h) => {
    const fx = makeCodexFixture(h, { mode: "codex" });
    await fx.performRestore();

    const recorder = recordGatewayCompletions(h, "codex");
    // Simulate the gateway issuing the Codex responses call.
    const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: CODEX_MODEL_ID, input: "hi" }),
    });
    assert.equal(res.ok, true);
    const urls = recorder.outboundUrls();
    assert.ok(
      urls.some((u) => u.includes(`${CODEX_RESPONSES_HOST}`)),
      `expected at least one outbound to ${CODEX_RESPONSES_HOST}; got ${urls.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario fixture — AI Gateway mode (regression)
// ---------------------------------------------------------------------------

test("codex fixture: ai-gateway mode preserves AI Gateway transform (no regression)", async () => {
  await withHarness(async (h) => {
    const fx = makeCodexFixture(h, { mode: "ai-gateway" });
    const config = await fx.performRestore();

    // auth-profiles.json must NOT be written in AI Gateway mode.
    fx.assertAuthProfilesWritten();
    assert.ok(
      !fx.handle.writtenFiles.some((f) => f.path === CODEX_AUTH_PROFILES_PATH),
      "ai-gateway mode must not write auth-profiles.json",
    );
    fx.assertOpenclawConfig(config);
    assert.equal(fx.handle.networkPolicies.length, 1);
    fx.assertNetworkPolicy(fx.handle.networkPolicies[0]);
  });
});

test("codex fixture: ai-gateway mode still allows Codex allow-set absence to fall through", async () => {
  await withHarness(async (h) => {
    const fx = makeCodexFixture(h, { mode: "ai-gateway" });
    await fx.performRestore();
    const policy = fx.handle.networkPolicies[0] as { allow?: Record<string, unknown> };
    assert.ok(
      !policy.allow?.[CODEX_AUTH_HOST],
      "ai-gateway mode should not pre-allow Codex hosts",
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke phase tests — codexStatus
// ---------------------------------------------------------------------------

function installMockFetch(
  routes: Array<{ pattern: RegExp; response: () => Response }>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const reqUrl = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (route.pattern.test(reqUrl)) {
        return route.response();
      }
    }
    return Response.json({ error: "no mock matched" }, { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const BASE = "https://codex-smoke.example.com";

test("codexStatus: passes with connected: false (skip)", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () => Response.json({ connected: false }),
    },
  ]);
  try {
    const r = await codexStatus(BASE);
    assert.equal(r.phase, "codexStatus");
    assert.equal(r.passed, true);
    assert.equal((r.detail as { connected?: boolean })?.connected, false);
  } finally {
    restore();
  }
});

test("codexStatus: passes and reports expiresIn when connected", async () => {
  const futureEpochSec = Math.floor(Date.now() / 1000) + 600;
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        Response.json({
          connected: true,
          expires: futureEpochSec,
          accountId: "acct_x",
          updatedAt: Date.now(),
        }),
    },
  ]);
  try {
    const r = await codexStatus(BASE);
    assert.equal(r.passed, true);
    const detail = r.detail as {
      connected: boolean;
      expired: boolean;
      expiresIn?: number;
    };
    assert.equal(detail.connected, true);
    assert.equal(detail.expired, false);
    assert.ok(typeof detail.expiresIn === "number" && detail.expiresIn > 0);
  } finally {
    restore();
  }
});

test("codexStatus: reports expired: true when expires is in the past", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        Response.json({
          connected: true,
          expires: Math.floor(Date.now() / 1000) - 600,
          accountId: "acct_x",
        }),
    },
  ]);
  try {
    const r = await codexStatus(BASE);
    assert.equal(r.passed, true);
    assert.equal((r.detail as { expired?: boolean })?.expired, true);
  } finally {
    restore();
  }
});

test("codexStatus: passes with skip when endpoint returns 404", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        new Response("not found", { status: 404 }),
    },
  ]);
  try {
    const r = await codexStatus(BASE);
    assert.equal(r.passed, true);
    assert.equal((r.detail as { skipped?: boolean })?.skipped, true);
  } finally {
    restore();
  }
});

test("codexStatus: does not include access or refresh tokens in detail", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () => Response.json({ connected: true, expires: Date.now() + 60_000 }),
    },
  ]);
  try {
    const r = await codexStatus(BASE);
    const detailStr = JSON.stringify(r);
    assert.ok(!/access/i.test(detailStr), "detail must not mention 'access'");
    assert.ok(!/refresh/i.test(detailStr), "detail must not mention 'refresh'");
    assert.ok(!/sk-/.test(detailStr), "detail must not leak sk- tokens");
    assert.ok(!/rt_/.test(detailStr), "detail must not leak rt_ tokens");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Smoke phase tests — codexChatCompletions
// ---------------------------------------------------------------------------

test("codexChatCompletions: skips when Codex not configured", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () => Response.json({ connected: false }),
    },
  ]);
  try {
    const r = await codexChatCompletions(BASE);
    assert.equal(r.passed, true);
    assert.equal((r.detail as { skipped?: boolean })?.skipped, true);
  } finally {
    restore();
  }
});

test("codexChatCompletions: passes when gateway returns non-empty content", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        Response.json({
          connected: true,
          expires: Math.floor(Date.now() / 1000) + 600,
        }),
    },
    {
      pattern: /\/api\/status/,
      response: () => Response.json({ status: "running", activeProvider: "codex" }),
    },
    {
      pattern: /\/gateway\/v1\/chat\/completions/,
      response: () =>
        Response.json({
          id: "chatcmpl-1",
          model: CODEX_MODEL_ID,
          choices: [
            { index: 0, message: { role: "assistant", content: "smoke-ok" } },
          ],
        }),
    },
  ]);
  try {
    const r = await codexChatCompletions(BASE);
    assert.equal(r.passed, true);
    const detail = r.detail as { model?: string; activeProvider?: string };
    assert.equal(detail.model, CODEX_MODEL_ID);
    assert.equal(detail.activeProvider, "codex");
  } finally {
    restore();
  }
});

test("codexChatCompletions: sanitizes tokens in failure detail", async () => {
  const leaky =
    "error sk-abcdefghijklmnopqrstuvwxyzABC rt_token_thatshouldberedacted123 " +
    "Authorization: Bearer secretbearertokenxyz";
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        Response.json({ connected: true, expires: Math.floor(Date.now() / 1000) + 600 }),
    },
    {
      pattern: /\/api\/status/,
      response: () => Response.json({ status: "running", activeProvider: "codex" }),
    },
    {
      pattern: /\/gateway\/v1\/chat\/completions/,
      response: () => new Response(leaky, { status: 500 }),
    },
  ]);
  try {
    const r = await codexChatCompletions(BASE);
    assert.equal(r.passed, false);
    const detailStr = JSON.stringify(r);
    assert.ok(!detailStr.includes("sk-abcdef"), "sk- token must be redacted");
    assert.ok(!detailStr.includes("rt_token_thatshould"), "rt_ token must be redacted");
    assert.ok(!detailStr.includes("secretbearertokenxyz"), "Bearer token must be redacted");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Smoke phase tests — codexWakeFromSleep
// ---------------------------------------------------------------------------

test("codexWakeFromSleep: skips when Codex not configured", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () => Response.json({ connected: false }),
    },
  ]);
  try {
    const r = await codexWakeFromSleep(BASE, 2_000);
    assert.equal(r.passed, true);
    assert.equal((r.detail as { skipped?: boolean })?.skipped, true);
  } finally {
    restore();
  }
});

test("codexWakeFromSleep: fails when post-wake activeProvider is not codex", async () => {
  let statusCallCount = 0;
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/auth\/codex/,
      response: () =>
        Response.json({ connected: true, expires: Math.floor(Date.now() / 1000) + 600 }),
    },
    {
      pattern: /\/api\/status/,
      response: () => {
        statusCallCount += 1;
        // First call in-phase: report stopped so ensure triggers.
        // Subsequent calls: report running but with the wrong provider.
        if (statusCallCount === 1) {
          return Response.json({ status: "stopped" });
        }
        return Response.json({ status: "running", activeProvider: "ai-gateway" });
      },
    },
    {
      pattern: /\/api\/admin\/ensure/,
      response: () => Response.json({ state: "running" }, { status: 202 }),
    },
  ]);
  try {
    const r = await codexWakeFromSleep(BASE, 5_000, { requestTimeoutMs: 500 });
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "WRONG_PROVIDER_AFTER_WAKE");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// sanitizeCodexBody unit tests
// ---------------------------------------------------------------------------

test("sanitizeCodexBody: redacts sk-, rt_, and Bearer tokens", () => {
  const input =
    "head sk-abcdef1234567890abcdef middle rt_aaabbbcccddd111222 tail Bearer xyz123abc.def foot";
  const out = sanitizeCodexBody(input);
  assert.ok(!out.includes("sk-abcdef1234567890"));
  assert.ok(!out.includes("rt_aaabbbccc"));
  assert.ok(!out.includes("xyz123abc.def"));
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitizeCodexBody: truncates to last 400 chars by default", () => {
  const input = "x".repeat(600) + "END";
  const out = sanitizeCodexBody(input);
  assert.ok(out.length <= 403);
  assert.ok(out.endsWith("END"));
});

test("sanitizeCodexBody: respects custom max length", () => {
  const out = sanitizeCodexBody("hello world", 5);
  assert.equal(out, "world");
});
