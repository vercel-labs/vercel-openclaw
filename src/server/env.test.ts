import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  _setAiGatewayTokenOverrideForTesting,
  getAiGatewayBearerTokenOptional,
  getAiGatewayAuthMode,
  getOpenclawPackageSpec,
  getOpenclawPackageSpecConfig,
  getSessionSecret,
  isVercelDeployment,
  requiresDurableStore,
} from "@/server/env";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

// --- getAiGatewayAuthMode ---

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("getAiGatewayAuthMode returns unavailable when no token source exists", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: undefined },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "unavailable");
    },
  );
});

test("getAiGatewayBearerTokenOptional skips OIDC in test mode and uses AI_GATEWAY_API_KEY when present", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: "1",
      AI_GATEWAY_API_KEY: "test-api-key",
    },
    async () => {
      const token = await getAiGatewayBearerTokenOptional();
      assert.equal(token, "test-api-key");
    },
  );
});

test("getAiGatewayBearerTokenOptional returns undefined in test mode without AI_GATEWAY_API_KEY", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: "1",
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      const token = await getAiGatewayBearerTokenOptional();
      assert.equal(token, undefined);
    },
  );
});

test("getAiGatewayAuthMode returns oidc when token is available even if AI_GATEWAY_API_KEY is set", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: "local-dev-key" },
    async () => {
      _setAiGatewayTokenOverrideForTesting("local-dev-key");
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "oidc");
    },
  );
});

test("getAiGatewayAuthMode returns oidc when resolved token differs from AI_GATEWAY_API_KEY", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: "local-dev-key" },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-runtime-token");
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "oidc");
    },
  );
});

// --- isVercelDeployment ---

test("isVercelDeployment returns false with no Vercel markers", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), false);
    },
  );
});

test("isVercelDeployment returns true when VERCEL_URL is set", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: "openclaw-example.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), true);
    },
  );
});

test("isVercelDeployment returns true when VERCEL is set", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), true);
    },
  );
});

// --- requiresDurableStore ---

test("requiresDurableStore returns false without Vercel markers", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NODE_ENV: "production",
    },
    () => {
      assert.equal(requiresDurableStore(), false);
    },
  );
});

test("requiresDurableStore returns true on Vercel deployments", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(requiresDurableStore(), true);
    },
  );
});

// --- getSessionSecret ---

test("deployed sign-in-with-vercel requires explicit session secret", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      SESSION_SECRET: undefined,
    },
    () => {
      assert.throws(
        () => getSessionSecret(),
        /SESSION_SECRET is required for deployed sign-in-with-vercel mode/,
      );
    },
  );
});

test("admin-secret mode on Vercel requires explicit SESSION_SECRET in production", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      SESSION_SECRET: undefined,
      NODE_ENV: "production",
    },
    () => {
      assert.throws(
        () => getSessionSecret(),
        /SESSION_SECRET is required in production/,
      );
    },
  );
});

test("local dev returns placeholder session secret", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_AUTH_MODE: undefined,
      SESSION_SECRET: undefined,
      NODE_ENV: "development",
    },
    () => {
      const secret = getSessionSecret();
      assert.ok(secret.includes("change-me"));
    },
  );
});

// --- getOpenclawPackageSpec / getOpenclawPackageSpecConfig ---

test("getOpenclawPackageSpec defaults to pinned version when env var is unset", () => {
  withEnv({ OPENCLAW_PACKAGE_SPEC: undefined }, () => {
    const spec = getOpenclawPackageSpec();
    assert.ok(spec.startsWith("openclaw@"), "should start with openclaw@");
    assert.notEqual(spec, "openclaw@latest", "default should no longer be @latest");
  });
});

test("getOpenclawPackageSpec returns explicit value when set", () => {
  withEnv({ OPENCLAW_PACKAGE_SPEC: "openclaw@1.2.3" }, () => {
    assert.equal(getOpenclawPackageSpec(), "openclaw@1.2.3");
  });
});

test("getOpenclawPackageSpecConfig returns fallback source when env var is unset", () => {
  withEnv({ OPENCLAW_PACKAGE_SPEC: undefined }, () => {
    const config = getOpenclawPackageSpecConfig();
    assert.equal(config.source, "fallback");
    assert.ok(config.value.startsWith("openclaw@"));
  });
});

test("getOpenclawPackageSpecConfig returns explicit source when env var is set", () => {
  withEnv({ OPENCLAW_PACKAGE_SPEC: "openclaw@1.2.3" }, () => {
    const config = getOpenclawPackageSpecConfig();
    assert.equal(config.source, "explicit");
    assert.equal(config.value, "openclaw@1.2.3");
  });
});

test("getOpenclawPackageSpec logs warning on Vercel when falling back to default", async () => {
  const { _resetLogBuffer, getServerLogs } = await import("@/server/log");
  _resetLogBuffer();
  withEnv(
    {
      OPENCLAW_PACKAGE_SPEC: undefined,
      VERCEL: "1",
    },
    () => {
      const spec = getOpenclawPackageSpec();
      assert.ok(spec.startsWith("openclaw@"), "should start with openclaw@");
      const warns = getServerLogs().filter(
        (e) => e.message === "env.openclaw_package_spec_fallback",
      );
      assert.equal(warns.length, 1, "expected one fallback warning log");
      const data = warns[0]!.data as Record<string, unknown>;
      assert.equal(data.resolved, spec);
    },
  );
});

test("getOpenclawPackageSpec does not log when spec is explicitly set", async () => {
  const { _resetLogBuffer, getServerLogs } = await import("@/server/log");
  _resetLogBuffer();
  withEnv(
    {
      OPENCLAW_PACKAGE_SPEC: "openclaw@2.0.0",
      VERCEL: "1",
    },
    () => {
      const spec = getOpenclawPackageSpec();
      assert.equal(spec, "openclaw@2.0.0");
      const warns = getServerLogs().filter(
        (e) => e.message === "env.openclaw_package_spec_fallback",
      );
      assert.equal(warns.length, 0, "should not log when spec is set");
    },
  );
});
