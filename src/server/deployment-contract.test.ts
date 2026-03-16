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

test("vercel deployment without OPENCLAW_PACKAGE_SPEC fails contract", async () => {
  process.env.VERCEL = "1";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);

  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "fail");
  assert.ok(specReq.env.includes("OPENCLAW_PACKAGE_SPEC"));
});

test("vercel deployment with openclaw@latest fails as non-deterministic", async () => {
  process.env.VERCEL = "1";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@latest";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);

  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "fail");
  assert.ok(specReq.message.includes("openclaw@latest"));
});

test("vercel deployment with pinned openclaw version passes package-spec check", async () => {
  process.env.VERCEL = "1";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();

  const specReq = contract.requirements.find(
    (r) => r.id === "openclaw-package-spec",
  );
  assert.ok(specReq, "expected openclaw-package-spec requirement");
  assert.equal(specReq.status, "pass");
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
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, true);
  assert.equal(contract.authMode, "sign-in-with-vercel");

  for (const req of contract.requirements) {
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
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.ok, false);
  assert.ok(contract.requirements.some((r) => r.status === "fail"));
});

test("ok is true when all requirements pass", async () => {
  // Non-Vercel, deployment-protection mode — minimal requirements
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
// buildDeploymentContract — deployment-protection without bypass secret
// does NOT fail here (that is a connectability/preflight concern)
// ---------------------------------------------------------------------------

test("deployment-protection mode does not emit oauth requirements", async () => {
  delete process.env.VERCEL_AUTH_MODE;
  _setAiGatewayTokenOverrideForTesting("test-token");

  const contract = await buildDeploymentContract();
  assert.equal(contract.authMode, "deployment-protection");

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
    ["deployment-protection", "sign-in-with-vercel"].includes(
      contract.authMode,
    ),
  );
  assert.ok(["upstash", "memory"].includes(contract.storeBackend));
  assert.ok(
    ["oidc", "api-key", "unavailable"].includes(contract.aiGatewayAuth),
  );
  assert.equal(contract.openclawPackageSpec, "openclaw@3.1.0");
  assert.ok(Array.isArray(contract.requirements));
});
