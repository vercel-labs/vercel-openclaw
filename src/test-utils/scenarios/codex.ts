/**
 * Codex (openai-codex provider) scenario fixture.
 *
 * Used by tests that need to assert how the Codex code paths from Units 1–9
 * reshape the sandbox file set, network policy, and gateway config.  The
 * fixture is self-contained: it does not depend on Unit 2's admin endpoint,
 * Unit 3's restore assets, or Unit 7's preflight changes being present in
 * the current tree.  It simulates those outputs by directly exercising the
 * fake sandbox controller with expected writes and by providing assertion
 * helpers over the resulting state.
 *
 * Two modes:
 *   - `makeCodexFixture({ mode: "codex" })` — Codex creds present; expect
 *     `auth-profiles.json`, Codex-aware network policy, and Codex-aware
 *     openclaw.json.
 *   - `makeCodexFixture({ mode: "ai-gateway" })` — no Codex creds; existing
 *     AI Gateway path is exercised to prove no regression.
 */

import assert from "node:assert/strict";
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

import { FakeSandboxHandle } from "@/test-utils/fake-sandbox-controller";
import type { ScenarioHarness } from "@/test-utils/harness";

// ---------------------------------------------------------------------------
// Constants mirrored from Unit 1 / Unit 3 work
// ---------------------------------------------------------------------------

export const CODEX_MODEL_ID = "openai-codex/gpt-5.4";
export const CODEX_AUTH_PROFILES_PATH =
  "/home/vercel-sandbox/.openclaw/agents/main/agent/auth-profiles.json";
export const CODEX_RESPONSES_HOST = "chatgpt.com";
export const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
export const CODEX_AUTH_HOST = "auth.openai.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexCredentials = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expires: number;
};

/** Minimal shape of an openclaw.json relevant to Codex assertions. */
export type OpenclawConfigShape = {
  auth?: {
    profiles?: Record<
      string,
      {
        provider?: string;
        model?: string;
        accessToken?: string;
        refreshToken?: string;
        accountId?: string;
        expiresAt?: number;
      }
    >;
  };
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
    };
  };
};

export type CodexFixtureMode = "codex" | "ai-gateway";

export type CodexFixture = {
  mode: CodexFixtureMode;
  sandboxId: string;
  handle: FakeSandboxHandle;
  credentials: CodexCredentials | null;

  /**
   * Run the synthesized "restore" that the real Unit 1/3/5 code would do
   * when Codex is configured (or simulate a plain AI Gateway restore when
   * mode === "ai-gateway"). Returns the openclaw.json contents written.
   */
  performRestore: () => Promise<OpenclawConfigShape>;

  /** Assert the written auth-profiles.json matches expected shape. */
  assertAuthProfilesWritten: () => void;

  /** Assert the network policy matches mode (Codex vs AI Gateway transform). */
  assertNetworkPolicy: (policy: NetworkPolicy) => void;

  /** Assert the openclaw.json shape matches mode. */
  assertOpenclawConfig: (config: OpenclawConfigShape) => void;
};

// ---------------------------------------------------------------------------
// Helpers for assertion
// ---------------------------------------------------------------------------

function isRuleArray(rules: unknown): rules is NetworkPolicyRule[] {
  return Array.isArray(rules);
}

function hasAiGatewayBearer(rules: unknown): boolean {
  if (!isRuleArray(rules)) return false;
  for (const rule of rules) {
    if (!("transform" in rule) || !Array.isArray(rule.transform)) continue;
    for (const step of rule.transform) {
      const headers = (step as { headers?: Record<string, string> }).headers;
      if (!headers) continue;
      for (const [name, value] of Object.entries(headers)) {
        if (
          name.toLowerCase() === "authorization" &&
          typeof value === "string" &&
          /^Bearer\s/i.test(value)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function allowDomains(policy: NetworkPolicy): Set<string> {
  if (typeof policy === "string") return new Set();
  if (Array.isArray(policy.allow)) return new Set(policy.allow);
  if (policy.allow && typeof policy.allow === "object") {
    return new Set(Object.keys(policy.allow));
  }
  return new Set();
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

export function makeCodexFixture(
  h: ScenarioHarness,
  options: { mode: CodexFixtureMode; sandboxId?: string } = { mode: "codex" },
): CodexFixture {
  const sandboxId = options.sandboxId ?? "sbx-codex-1";
  const mode = options.mode;

  const handle = new FakeSandboxHandle(sandboxId, h.controller.events);
  h.controller.handlesByIds.set(sandboxId, handle);
  h.controller.created.push(handle);

  const credentials: CodexCredentials | null =
    mode === "codex"
      ? {
          accessToken: "sk-codex-access-test-00000000000000000000",
          refreshToken: "rt_codex-refresh-test-00000000000000000",
          accountId: "acct_codex_test",
          expires: Date.now() + 3600_000,
        }
      : null;

  const performRestore = async (): Promise<OpenclawConfigShape> => {
    if (mode === "codex") {
      assert.ok(credentials, "Codex mode requires credentials");
      const authProfilesPayload = JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              accessToken: credentials.accessToken,
              refreshToken: credentials.refreshToken,
              accountId: credentials.accountId,
              expiresAt: credentials.expires,
            },
          },
        },
        null,
        2,
      );

      await handle.writeFiles([
        {
          path: CODEX_AUTH_PROFILES_PATH,
          content: Buffer.from(authProfilesPayload),
        },
      ]);

      const openclawConfig: OpenclawConfigShape = {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              accessToken: credentials.accessToken,
              refreshToken: credentials.refreshToken,
              accountId: credentials.accountId,
              expiresAt: credentials.expires,
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: CODEX_MODEL_ID,
              fallbacks: [
                "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
              ],
            },
          },
        },
      };

      await handle.writeFiles([
        {
          path: "/home/vercel-sandbox/.openclaw/openclaw.json",
          content: Buffer.from(JSON.stringify(openclawConfig, null, 2)),
        },
      ]);

      // Network policy: no AI Gateway Authorization transform; Codex hosts
      // in the allow set alongside the existing gateway domain.
      const codexPolicy: NetworkPolicy = {
        allow: {
          "ai-gateway.vercel.sh": [],
          [CODEX_AUTH_HOST]: [],
          [CODEX_RESPONSES_HOST]: [],
          "*": [],
        },
      };
      await handle.updateNetworkPolicy(codexPolicy);

      return openclawConfig;
    }

    // ai-gateway mode — plain restore that writes an AI-Gateway-style config.
    const openclawConfig: OpenclawConfigShape = {
      agents: {
        defaults: {
          model: {
            primary: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
            fallbacks: [],
          },
        },
      },
    };
    await handle.writeFiles([
      {
        path: "/home/vercel-sandbox/.openclaw/openclaw.json",
        content: Buffer.from(JSON.stringify(openclawConfig, null, 2)),
      },
    ]);
    // With an AI Gateway token, the real path installs a transform rule.
    const aiGatewayPolicy: NetworkPolicy = {
      allow: {
        "ai-gateway.vercel.sh": [
          { transform: [{ headers: { authorization: "Bearer test-ai-gw-token" } }] },
        ],
        "*": [],
      },
    };
    await handle.updateNetworkPolicy(aiGatewayPolicy);
    return openclawConfig;
  };

  const assertAuthProfilesWritten = (): void => {
    if (mode !== "codex") {
      assert.ok(
        handle.writtenFiles.every((f) => f.path !== CODEX_AUTH_PROFILES_PATH),
        "ai-gateway mode should not write auth-profiles.json",
      );
      return;
    }
    const written = handle.writtenFiles.find(
      (f) => f.path === CODEX_AUTH_PROFILES_PATH,
    );
    assert.ok(
      written,
      `expected writeFiles() to include ${CODEX_AUTH_PROFILES_PATH}`,
    );
    const parsed = JSON.parse(written.content.toString("utf8")) as {
      profiles?: Record<string, { provider?: string; accessToken?: string; refreshToken?: string; accountId?: string }>;
    };
    assert.ok(parsed.profiles, "auth-profiles.json should have 'profiles'");
    const profile = parsed.profiles["openai-codex:default"];
    assert.ok(profile, "auth-profiles.json missing openai-codex:default");
    assert.equal(profile.provider, "openai-codex");
    assert.equal(profile.accessToken, credentials!.accessToken);
    assert.equal(profile.refreshToken, credentials!.refreshToken);
    assert.equal(profile.accountId, credentials!.accountId);
  };

  const assertNetworkPolicy = (policy: NetworkPolicy): void => {
    const domains = allowDomains(policy);
    if (mode === "codex") {
      const aiGw = (policy as { allow?: Record<string, unknown> }).allow?.[
        "ai-gateway.vercel.sh"
      ];
      assert.equal(
        hasAiGatewayBearer(aiGw),
        false,
        "Codex mode must not install an AI Gateway Authorization transform",
      );
      assert.ok(
        domains.has(CODEX_AUTH_HOST),
        `Codex allow set missing ${CODEX_AUTH_HOST} (got ${[...domains].join(", ")})`,
      );
      assert.ok(
        domains.has(CODEX_RESPONSES_HOST),
        `Codex allow set missing ${CODEX_RESPONSES_HOST} (got ${[...domains].join(", ")})`,
      );
      return;
    }

    // ai-gateway mode: transform should be present.
    const aiGw = (policy as { allow?: Record<string, unknown> }).allow?.[
      "ai-gateway.vercel.sh"
    ];
    assert.equal(
      hasAiGatewayBearer(aiGw),
      true,
      "AI Gateway mode must install an Authorization: Bearer transform",
    );
  };

  const assertOpenclawConfig = (config: OpenclawConfigShape): void => {
    if (mode === "codex") {
      const profile = config.auth?.profiles?.["openai-codex:default"];
      assert.ok(profile, "openclaw.json missing auth.profiles['openai-codex:default']");
      assert.equal(profile?.provider, "openai-codex");
      assert.equal(
        config.agents?.defaults?.model?.primary,
        CODEX_MODEL_ID,
        "openclaw.json agents.defaults.model.primary must be the Codex model",
      );
      return;
    }
    // ai-gateway: primary must not be a Codex model
    const primary = config.agents?.defaults?.model?.primary ?? "";
    assert.ok(
      !primary.startsWith("openai-codex/"),
      `ai-gateway mode should not select a Codex primary (got ${primary})`,
    );
  };

  return {
    mode,
    sandboxId,
    handle,
    credentials,
    performRestore,
    assertAuthProfilesWritten,
    assertNetworkPolicy,
    assertOpenclawConfig,
  };
}

// ---------------------------------------------------------------------------
// Request recording helper — attaches a fake fetch recorder that asserts
// the gateway forwards Codex chat completions to chatgpt.com.
// ---------------------------------------------------------------------------

export function recordGatewayCompletions(
  h: ScenarioHarness,
  mode: CodexFixtureMode,
  reply = "smoke-ok",
): { outboundUrls: () => string[] } {
  // The proxy route forwards POST /v1/chat/completions to the sandbox.
  // In Codex mode the upstream Codex adapter inside OpenClaw reaches
  // https://chatgpt.com/backend-api/codex/responses.  In AI Gateway mode
  // it reaches https://ai-gateway.vercel.sh/v1/chat/completions.  The
  // fake fetch below records whichever direction the test exercises.
  const outbound: string[] = [];
  h.fakeFetch.onPost(/\/v1\/chat\/completions/, (reqUrl) => {
    outbound.push(reqUrl);
    return Response.json({
      id: "chatcmpl-fake",
      model: mode === "codex" ? CODEX_MODEL_ID : "openai/gpt-5.3-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop",
        },
      ],
    });
  });
  h.fakeFetch.onPost(new RegExp(`${CODEX_RESPONSES_HOST}${CODEX_RESPONSES_PATH}`), (reqUrl) => {
    outbound.push(reqUrl);
    return Response.json({
      id: "codex-resp-fake",
      output: [{ type: "message", content: [{ type: "output_text", text: reply }] }],
    });
  });
  return {
    outboundUrls: () => [...outbound],
  };
}
