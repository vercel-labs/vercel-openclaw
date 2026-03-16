import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  _setAiGatewayTokenOverrideForTesting,
  getAiGatewayAuthMode,
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
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      assert.throws(
        () => getSessionSecret(),
        /SESSION_SECRET is required for deployed sign-in-with-vercel mode/,
      );
    },
  );
});

test("deployed sign-in-with-vercel with upstash token still throws without SESSION_SECRET", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      SESSION_SECRET: undefined,
      UPSTASH_REDIS_REST_TOKEN: "some-upstash-token",
    },
    () => {
      assert.throws(
        () => getSessionSecret(),
        /SESSION_SECRET is required for deployed sign-in-with-vercel mode/,
      );
    },
  );
});

test("admin-secret mode on Vercel can derive from upstash token", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      SESSION_SECRET: undefined,
      UPSTASH_REDIS_REST_TOKEN: "upstash-token-value",
    },
    () => {
      const secret = getSessionSecret();
      assert.ok(secret.includes("upstash-token-value"));
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
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_TOKEN: undefined,
      NODE_ENV: "development",
    },
    () => {
      const secret = getSessionSecret();
      assert.ok(secret.includes("change-me"));
    },
  );
});
