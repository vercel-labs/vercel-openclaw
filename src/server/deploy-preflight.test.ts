import assert from "node:assert/strict";
import test from "node:test";

import { buildDeployPreflight } from "@/server/deploy-preflight";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { _resetStoreForTesting } from "@/server/store/store";

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

  _resetStoreForTesting();

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    _setAiGatewayTokenOverrideForTesting(null);
    _resetStoreForTesting();
  };

  return fn().finally(restore);
}

test("preflight fails when deployment protection would block channel webhooks", async () => {
  await withEnv(
    {
      VERCEL: "1",
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
      VERCEL: "1",
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
        "fail",
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

      // nextSteps should include channel setup guidance when ok
      assert.ok(Array.isArray(payload.nextSteps));
      assert.ok(payload.nextSteps.length > 0, "should have next steps when ok");
      assert.ok(
        payload.nextSteps.some((s) => s.id === "connect-channels"),
        "should suggest connecting channels",
      );
    },
  );
});

test("preflight nextSteps includes resolve-blockers when not ok", async () => {
  await withEnv(
    {
      VERCEL: "1",
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

      assert.equal(payload.ok, false);
      assert.ok(Array.isArray(payload.nextSteps));
      assert.ok(
        payload.nextSteps.some((s) => s.id === "resolve-blockers"),
        "should suggest resolving blockers when not ok",
      );
    },
  );
});

test("preflight fails when durable store is missing", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://app.invalid",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.invalid/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.storeBackend, "memory");
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(
        payload.checks.find((c) => c.id === "store")?.status,
        "fail",
      );
      assert.ok(
        payload.actions.some(
          (a) => a.id === "configure-upstash" && a.status === "required",
        ),
      );
    },
  );
});

test("preflight fails when a Vercel deployment uses API key auth instead of OIDC", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://app.invalid",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      UPSTASH_REDIS_REST_URL: "redis-url",
      UPSTASH_REDIS_REST_TOKEN: "redis-token",
      AI_GATEWAY_API_KEY: "static-key",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("static-key");

      const payload = await buildDeployPreflight(
        new Request("https://app.invalid/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.storeBackend, "upstash");
      assert.equal(payload.aiGatewayAuth, "api-key");
      assert.equal(
        payload.checks.find((c) => c.id === "ai-gateway")?.status,
        "fail",
      );
      assert.ok(
        payload.actions.some(
          (a) =>
            a.id === "configure-ai-gateway-auth" && a.status === "required",
        ),
      );
    },
  );
});

test("preflight passes when Upstash is configured and AI Gateway auth resolves to OIDC on Vercel", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://app.invalid",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      UPSTASH_REDIS_REST_URL: "redis-url",
      UPSTASH_REDIS_REST_TOKEN: "redis-token",
      AI_GATEWAY_API_KEY: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.invalid/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);
      assert.equal(payload.storeBackend, "upstash");
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(
        payload.checks.find((c) => c.id === "store")?.status,
        "pass",
      );
      assert.equal(
        payload.checks.find((c) => c.id === "ai-gateway")?.status,
        "pass",
      );
    },
  );
});

test("preflight actions include remediation text", async () => {
  await withEnv(
    {
      VERCEL: "1",
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

      for (const action of payload.actions) {
        assert.equal(typeof action.remediation, "string", `action ${action.id} should have remediation`);
        assert.ok(action.remediation.length > 0, `action ${action.id} remediation should not be empty`);
      }
    },
  );
});

test("preflight actions do not contain launch-verification remediation items", async () => {
  await withEnv(
    {
      VERCEL: "1",
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

      // preflight.ok is false due to missing config, but the actions array
      // must only contain config-level remediations — never launch-verification.
      assert.equal(payload.ok, false);
      const actionIds = payload.actions.map((a) => a.id);
      assert.equal(
        actionIds.includes("launch-verification" as never),
        false,
        `preflight actions must not include launch-verification; got: ${actionIds.join(", ")}`,
      );

      // Also verify no action mentions "launch-verify" in its remediation text
      for (const action of payload.actions) {
        assert.equal(
          action.remediation.toLowerCase().includes("launch-verify"),
          false,
          `action ${action.id} remediation must not reference launch-verify`,
        );
      }
    },
  );
});

test("preflight checks do not include launch-verification (config-only guarantee for launch-verify POST)", async () => {
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

      // The launch-verify POST route aborts only when preflight.checks has failures.
      // Since preflight checks are config-only (no launch-verification check ID),
      // launch-verify POST can always proceed when config is valid —
      // regardless of prior channel readiness state.
      const checkIds = payload.checks.map((c) => c.id);
      assert.equal(
        checkIds.includes("launch-verification" as never),
        false,
        `preflight checks must not include launch-verification; got: ${checkIds.join(", ")}`,
      );

      // Verify the canonical set of config-only check IDs
      assert.deepEqual(
        checkIds.sort(),
        ["ai-gateway", "drain-recovery", "public-origin", "store", "webhook-bypass"],
        "preflight checks should be exactly the 5 config-only checks",
      );
    },
  );
});

test("preflight is config-only: passes on a fresh deployment before launch-verify has ever run", async () => {
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
      // OIDC token available but NO channel readiness override —
      // simulates a fresh deployment where launch-verify has never run.
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      // Preflight should pass purely on config checks
      assert.equal(payload.ok, true, "preflight.ok should be true without launch-verify");

      // Channel prerequisites should pass (config is correct)
      assert.equal(payload.channels.slack.canConnect, true);
      assert.equal(payload.channels.telegram.canConnect, true);
      assert.equal(payload.channels.discord.canConnect, true);

      // No launch-verification issue should appear in channel prerequisites
      for (const ch of Object.values(payload.channels)) {
        const launchIssue = ch.issues.find((i) => i.id === "launch-verification");
        assert.equal(
          launchIssue,
          undefined,
          `preflight channel ${ch.channel} should not have launch-verification issue`,
        );
      }
    },
  );
});
