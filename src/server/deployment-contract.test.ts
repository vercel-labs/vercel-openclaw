import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildDeploymentContract,
  isPinnedPackageSpec,
} from "@/server/deployment-contract";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  resetEnv();
  _setAiGatewayTokenOverrideForTesting(null);
});

// ---------------------------------------------------------------------------
// isPinnedPackageSpec
// ---------------------------------------------------------------------------

test("isPinnedPackageSpec returns true for exact versions", () => {
  assert.equal(isPinnedPackageSpec("openclaw@1.2.3"), true);
  assert.equal(isPinnedPackageSpec("openclaw@0.0.1"), true);
  assert.equal(isPinnedPackageSpec("openclaw@1.0.0-beta.1"), true);
});

test("isPinnedPackageSpec returns false for non-pinned specs", () => {
  assert.equal(isPinnedPackageSpec("openclaw@latest"), false);
  assert.equal(isPinnedPackageSpec("openclaw@^1.0.0"), false);
  assert.equal(isPinnedPackageSpec("openclaw@~1.0.0"), false);
  assert.equal(isPinnedPackageSpec("openclaw@>=1.0.0"), false);
  assert.equal(isPinnedPackageSpec(null), false);
  assert.equal(isPinnedPackageSpec(undefined), false);
  assert.equal(isPinnedPackageSpec(""), false);
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — local dev
// ---------------------------------------------------------------------------

test("local dev without OPENCLAW_PACKAGE_SPEC does not fail contract", async () => {
  // Ensure not on Vercel
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  // In local dev, no package-spec requirement is emitted at all
  assert.equal(specReq, undefined);
  assert.equal(contract.ok, true);
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — Vercel deployment
// ---------------------------------------------------------------------------

test("vercel deployment without OPENCLAW_PACKAGE_SPEC warns when using fallback", async () => {
  process.env.VERCEL = "1";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "warn");
  assert.ok(specReq.message.includes("not set"));
  assert.ok(specReq.env.includes("OPENCLAW_PACKAGE_SPEC"));
  assert.equal(contract.openclawPackageSpecSource, "fallback");
});

test("vercel deployment with openclaw@latest warns but does not fail contract", async () => {
  process.env.VERCEL = "1";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@latest";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "warn");
  assert.ok(specReq.message.includes("not a pinned version"));
  // contract.ok may still be false due to other requirements (e.g. missing Redis),
  // but the package-spec requirement itself should only be a warning.
});

test("vercel deployment with pinned openclaw version passes", async () => {
  process.env.VERCEL = "1";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "pass");
  assert.equal(contract.openclawPackageSpecSource, "explicit");
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — sign-in-with-vercel auth config
// ---------------------------------------------------------------------------

test("sign-in-with-vercel without client ID fails contract", async () => {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  delete process.env.VERCEL_APP_CLIENT_SECRET;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);

  const clientIdReq = contract.requirements.find(
    (r) => r.id === "oauth-client-id",
  );
  assert.ok(clientIdReq, "expected oauth-client-id requirement");
  assert.equal(clientIdReq.status, "fail");
});

test("sign-in-with-vercel without client secret fails contract", async () => {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
  delete process.env.VERCEL_APP_CLIENT_SECRET;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);

  const secretReq = contract.requirements.find(
    (r) => r.id === "oauth-client-secret",
  );
  assert.ok(secretReq, "expected oauth-client-secret requirement");
  assert.equal(secretReq.status, "fail");
});

test("sign-in-with-vercel on Vercel without SESSION_SECRET fails contract", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
  process.env.VERCEL_APP_CLIENT_SECRET = "test-secret";
  delete process.env.SESSION_SECRET;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);

  const sessionReq = contract.requirements.find(
    (r) => r.id === "session-secret",
  );
  assert.ok(sessionReq, "expected session-secret requirement");
  assert.equal(sessionReq.status, "fail");
  assert.ok(sessionReq.env.includes("SESSION_SECRET"));
});

test("sign-in-with-vercel on Vercel with all config passes", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
  process.env.VERCEL_APP_CLIENT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "a-good-random-secret-value";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@2.0.0";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com";
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  process.env.CRON_SECRET = "test-cron-secret";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, true);
  assert.equal(contract.authMode, "sign-in-with-vercel");

  // Codex is opt-in — warn is expected when codex creds are not configured.
  // All other requirements must pass.
  for (const req of contract.requirements) {
    if (req.id === "codex-credentials") {
      assert.equal(req.status, "warn");
      continue;
    }
    assert.equal(
      req.status,
      "pass",
      `requirement ${req.id} should pass, got ${req.status}: ${req.message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — ok aggregation
// ---------------------------------------------------------------------------

test("ok is false when any requirement has status fail", async () => {
  process.env.VERCEL = "1";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);
  assert.ok(contract.requirements.some((r) => r.status === "fail"));
});

test("ok is true when all requirements pass", async () => {
  // Non-Vercel, admin-secret mode — minimal requirements
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_AUTH_MODE;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, true);
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — admin-secret without bypass secret
// does NOT fail here (that is a connectability/preflight concern)
// ---------------------------------------------------------------------------

test("admin-secret mode does not emit oauth requirements", async () => {
  delete process.env.VERCEL_AUTH_MODE;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.authMode, "admin-secret");

  const oauthReqs = contract.requirements.filter(
    (r) =>
      r.id === "oauth-client-id" ||
      r.id === "oauth-client-secret" ||
      r.id === "session-secret",
  );
  assert.equal(oauthReqs.length, 0);
});

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

test("contract exposes expected metadata fields", async () => {
  process.env.VERCEL = "1";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@3.1.0";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(typeof contract.ok, "boolean");
  assert.ok(
    ["admin-secret", "sign-in-with-vercel"].includes(
      contract.authMode,
    ),
  );
  assert.ok(["redis", "memory"].includes(contract.storeBackend));
  assert.ok(
    ["oidc", "api-key", "unavailable"].includes(contract.aiGatewayAuth),
  );
  assert.equal(contract.openclawPackageSpec, "openclaw@3.1.0");
  assert.equal(contract.openclawPackageSpecSource, "explicit");
  assert.ok(Array.isArray(contract.requirements));
});

// ---------------------------------------------------------------------------
// buildDeploymentContract — public-origin, webhook-bypass, store, ai-gateway
// ---------------------------------------------------------------------------

test("deployed protected env fails store when missing (pinned spec passes)", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://public-host.test";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.CRON_SECRET = "test-cron-secret";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract();
  const failedIds = contract.requirements
    .filter((r) => r.status === "fail")
    .map((r) => r.id)
    .sort();

  assert.deepEqual(failedIds, ["store"]);
  assert.equal(contract.ok, false);
});

test("public-origin passes when NEXT_PUBLIC_APP_URL is set", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://example.com";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const originReq = contract.requirements.find((r) => r.id === "public-origin");
  assert.ok(originReq, "expected public-origin requirement");
  assert.equal(originReq.status, "pass");
});

test("public-origin warns on non-Vercel when unresolvable", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
  delete process.env.BASE_DOMAIN;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const originReq = contract.requirements.find((r) => r.id === "public-origin");
  assert.ok(originReq, "expected public-origin requirement");
  assert.equal(originReq.status, "warn");
});

test("public-origin fails on Vercel when unresolvable", async () => {
  process.env.VERCEL = "1";
  // Clear all origin sources
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
  delete process.env.BASE_DOMAIN;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract();
  const originReq = contract.requirements.find((r) => r.id === "public-origin");
  assert.ok(originReq, "expected public-origin requirement");
  assert.equal(originReq.status, "fail");
});

test("store warns on non-Vercel when missing", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const storeReq = contract.requirements.find((r) => r.id === "store");
  assert.ok(storeReq, "expected store requirement");
  assert.equal(storeReq.status, "warn");
});

test("store fails on Vercel when missing", async () => {
  process.env.VERCEL = "1";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract();
  const storeReq = contract.requirements.find((r) => r.id === "store");
  assert.ok(storeReq, "expected store requirement");
  assert.equal(storeReq.status, "fail");
});

test("ai-gateway fails on Vercel when OIDC is unavailable", async () => {
  process.env.VERCEL = "1";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const contract = await buildDeploymentContract();
  const gwReq = contract.requirements.find((r) => r.id === "ai-gateway");
  assert.ok(gwReq, "expected ai-gateway requirement");
  assert.equal(gwReq.status, "fail");
});

test("ai-gateway warns on non-Vercel when unavailable", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const contract = await buildDeploymentContract();
  const gwReq = contract.requirements.find((r) => r.id === "ai-gateway");
  assert.ok(gwReq, "expected ai-gateway requirement");
  assert.equal(gwReq.status, "warn");
});

test("webhook-bypass warns when bypass secret is not configured", async () => {
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const bypassReq = contract.requirements.find((r) => r.id === "webhook-bypass");
  assert.ok(bypassReq, "webhook-bypass requirement should be present");
  assert.equal(bypassReq.status, "warn");
});

test("webhook-bypass warns in non-Vercel environments without bypass secret", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  const bypassReq = contract.requirements.find((r) => r.id === "webhook-bypass");
  assert.ok(bypassReq, "webhook-bypass requirement should be present");
  assert.equal(bypassReq.status, "warn");
});

test("webhook-bypass passes when bypass secret is configured", async () => {
  process.env.VERCEL = "1";
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret-value";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract();
  const bypassReq = contract.requirements.find((r) => r.id === "webhook-bypass");
  assert.ok(bypassReq, "webhook-bypass requirement should be present");
  assert.equal(bypassReq.status, "pass");
});

// ---------------------------------------------------------------------------
// Codex provider quadrant matrix
// ---------------------------------------------------------------------------

import type { SingleMeta } from "@/shared/types";

function metaWithCodex(hasCreds: boolean): SingleMeta {
  const base = {
    codexCredentials: hasCreds
      ? {
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 3_600_000,
          updatedAt: Date.now(),
        }
      : null,
  };
  // Return via `as` — contract only looks at meta.codexCredentials, so a
  // partial stub is sufficient.
  return base as unknown as SingleMeta;
}

test("quadrant: Codex off, AI Gateway on — gateway passes, codex warns", async () => {
  process.env.VERCEL = "1";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract({ meta: metaWithCodex(false) });
  assert.equal(contract.activeProvider, "ai-gateway");
  assert.equal(contract.codexAuth, "unavailable");
  assert.equal(
    contract.requirements.find((r) => r.id === "ai-gateway")?.status,
    "pass",
  );
  assert.equal(
    contract.requirements.find((r) => r.id === "codex-credentials")?.status,
    "warn",
  );
});

test("quadrant: Codex off, AI Gateway off — gateway fails on Vercel", async () => {
  process.env.VERCEL = "1";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const contract = await buildDeploymentContract({ meta: metaWithCodex(false) });
  assert.equal(contract.activeProvider, "ai-gateway");
  assert.equal(
    contract.requirements.find((r) => r.id === "ai-gateway")?.status,
    "fail",
  );
  assert.equal(
    contract.requirements.find((r) => r.id === "codex-credentials")?.status,
    "warn",
  );
});

test("quadrant: Codex on, AI Gateway on — both pass, activeProvider is codex", async () => {
  process.env.VERCEL = "1";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract({ meta: metaWithCodex(true) });
  assert.equal(contract.activeProvider, "codex");
  assert.equal(contract.codexAuth, "configured");
  assert.equal(
    contract.requirements.find((r) => r.id === "ai-gateway")?.status,
    "pass",
  );
  assert.equal(
    contract.requirements.find((r) => r.id === "codex-credentials")?.status,
    "pass",
  );
});

test("quadrant: Codex on, AI Gateway off — gateway downgraded to pass because codex active", async () => {
  process.env.VERCEL = "1";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const contract = await buildDeploymentContract({ meta: metaWithCodex(true) });
  assert.equal(contract.activeProvider, "codex");
  assert.equal(contract.codexAuth, "configured");

  const gw = contract.requirements.find((r) => r.id === "ai-gateway");
  assert.ok(gw);
  assert.equal(
    gw.status,
    "pass",
    "AI Gateway must be downgraded to pass when Codex is the active provider",
  );
  assert.match(gw.message, /Codex/i);

  assert.equal(
    contract.requirements.find((r) => r.id === "codex-credentials")?.status,
    "pass",
  );
  // Codex opt-in warn should never fail contract; and gateway is downgraded,
  // so provider readiness should not push contract.ok to false (other blockers
  // like missing store may still fail — assert gateway itself doesn't).
  const gwFailing = contract.requirements
    .filter((r) => r.status === "fail")
    .some((r) => r.id === "ai-gateway");
  assert.equal(gwFailing, false);
});

test("codex expired creds still make Codex the active provider", async () => {
  process.env.VERCEL = "1";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const expiredMeta = {
    codexCredentials: {
      access: "expired-access",
      refresh: "refresh",
      expires: Date.now() - 1_000_000,
      updatedAt: Date.now() - 1_000_000,
    },
  } as unknown as SingleMeta;

  const contract = await buildDeploymentContract({ meta: expiredMeta });
  assert.equal(contract.activeProvider, "codex");
  assert.equal(contract.codexAuth, "configured");
});

test("codex-credentials is never fail — opt-in is warn at worst", async () => {
  process.env.VERCEL = "1";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const contract = await buildDeploymentContract({ meta: metaWithCodex(false) });
  const codexReq = contract.requirements.find((r) => r.id === "codex-credentials");
  assert.ok(codexReq);
  assert.notEqual(codexReq.status, "fail");
});
