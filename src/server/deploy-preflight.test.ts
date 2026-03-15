import assert from "node:assert/strict";
import test from "node:test";

import { buildDeployPreflight } from "@/server/deploy-preflight";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    _setAiGatewayTokenOverrideForTesting(null);
  };

  return fn().finally(restore);
}

test("preflight fails when deployment protection would block channel webhooks", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(payload.storeBackend, "upstash");
      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "fail",
      );
    },
  );
});

test("preflight passes when bypass secret is configured", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);
      assert.equal(payload.webhookBypassEnabled, true);
      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "pass",
      );
    },
  );
});

test("preflight passes bypass check in sign-in-with-vercel mode without secret", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "pass",
      );
    },
  );
});

test("preflight fails when both webhook bypass and AI Gateway auth are missing", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
      AI_GATEWAY_API_KEY: undefined,
      CRON_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.authMode, "deployment-protection");
      assert.equal(payload.publicOrigin, "https://app.example.com");
      assert.equal(payload.webhookBypassEnabled, false);
      assert.equal(payload.storeBackend, "memory");
      assert.equal(payload.aiGatewayAuth, "unavailable");
      assert.equal(payload.cronSecretConfigured, false);

      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "fail",
      );
      assert.equal(
        payload.checks.find((check) => check.id === "ai-gateway")?.status,
        "fail",
      );
      assert.equal(
        payload.checks.find((check) => check.id === "store")?.status,
        "warn",
      );
    },
  );
});

test("preflight reports api-key auth when static AI_GATEWAY_API_KEY is used", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      AI_GATEWAY_API_KEY: "static-key",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("static-key");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.aiGatewayAuth, "api-key");
      assert.equal(payload.ok, true);
    },
  );
});

test("preflight includes channels with discord connectability", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
      AI_GATEWAY_API_KEY: undefined,
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.ok(payload.channels, "payload missing channels");
      assert.ok(payload.channels.discord, "payload missing channels.discord");
      assert.equal(typeof payload.channels.discord.canConnect, "boolean");
      assert.ok(payload.channels.slack, "payload missing channels.slack");
      assert.ok(payload.channels.telegram, "payload missing channels.telegram");
    },
  );
});

test("preflight ok is false when channel connectability has failures", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "deployment-protection",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      // Channel connectability fails because VERCEL=1 + deployment-protection
      // without bypass secret
      assert.equal(payload.channels.discord.status, "fail");
      assert.equal(payload.channels.discord.canConnect, false);
      assert.equal(payload.ok, false);
    },
  );
});

test("preflight passes all checks with Upstash, bypass, OIDC, and cron secret", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      CRON_SECRET: "cron-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);
      assert.equal(payload.authMode, "deployment-protection");
      assert.equal(payload.publicOrigin, "https://app.example.com");
      assert.equal(payload.webhookBypassEnabled, true);
      assert.equal(payload.storeBackend, "upstash");
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(payload.cronSecretConfigured, true);

      for (const check of payload.checks) {
        assert.notEqual(check.status, "fail");
      }

      // Channels should also be present and passing
      assert.ok(payload.channels.slack);
      assert.ok(payload.channels.telegram);
      assert.ok(payload.channels.discord);
      assert.equal(payload.channels.slack.canConnect, true);
    },
  );
});
