import assert from "node:assert/strict";
import test from "node:test";

import { buildDeployPreflight, getLaunchVerifyBlocking } from "@/server/deploy-preflight";
import { _setProbeResultForTesting, _resetProbeForTesting } from "@/server/deployment-protection-probe";
import { _setAiGatewayTokenOverrideForTesting, _setAiGatewayCredentialOverrideForTesting } from "@/server/env";
import { _resetStoreForTesting } from "@/server/store/store";

let envMutationQueue = Promise.resolve();

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const runWithPatchedEnv = async (): Promise<T> => {
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
    // Prevent real network calls from the deployment protection probe.
    _setProbeResultForTesting({ status: "skipped", probeError: null });

    const restore = () => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      _setAiGatewayTokenOverrideForTesting(null);
      _setAiGatewayCredentialOverrideForTesting(null);
      _resetStoreForTesting();
      _resetProbeForTesting();
    };

    return fn().finally(restore);
  };

  const queued = envMutationQueue.then(runWithPatchedEnv, runWithPatchedEnv);
  envMutationQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

test("preflight passes when bypass secret is absent in admin-secret mode", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(payload.storeBackend, "redis");
      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "pass",
      );
    },
  );
});

test("preflight passes when bypass secret is configured", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
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

test("preflight warns (not fails) bypass check in sign-in-with-vercel mode without secret", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "warn",
      );
    },
  );
});

test("preflight fails when AI Gateway auth and store are missing", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      AI_GATEWAY_API_KEY: undefined,
      CRON_SECRET: undefined,
      ADMIN_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.authMode, "admin-secret");
      assert.equal(payload.publicOrigin, "https://app.example.com");
      assert.equal(payload.webhookBypassEnabled, false);
      assert.equal(payload.storeBackend, "memory");
      assert.equal(payload.aiGatewayAuth, "unavailable");
      assert.equal(payload.cronSecretConfigured, false);
      assert.equal(payload.cronSecretExplicitlyConfigured, false);
      assert.equal(payload.cronSecretSource, "missing");

      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "pass",
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

test("preflight reports oidc when token is available even if AI_GATEWAY_API_KEY is set", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      AI_GATEWAY_API_KEY: "static-key",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("static-key");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(payload.ok, true);
    },
  );
});

test("preflight includes channels with discord connectability", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
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

test("preflight ok is true when Redis and OIDC are configured without bypass secret", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.channels.discord.canConnect, true);
      assert.equal(payload.ok, true);
    },
  );
});

test("preflight passes all checks with Redis, bypass, OIDC, and cron secret", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
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
      assert.equal(payload.authMode, "admin-secret");
      assert.equal(payload.publicOrigin, "https://app.example.com");
      assert.equal(payload.webhookBypassEnabled, true);
      assert.equal(payload.storeBackend, "redis");
      assert.equal(payload.aiGatewayAuth, "oidc");
      assert.equal(payload.cronSecretConfigured, true);
      assert.equal(payload.cronSecretExplicitlyConfigured, true);
      assert.equal(payload.cronSecretSource, "cron-secret");

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
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
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
      REDIS_URL: undefined,
      KV_URL: undefined,
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
          (a) => a.id === "configure-redis" && a.status === "required",
        ),
      );
    },
  );
});

test("preflight fails when a Vercel deployment has OIDC unavailable", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://app.invalid",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.invalid/api/admin/preflight"),
      );

      assert.equal(payload.ok, false);
      assert.equal(payload.storeBackend, "redis");
      assert.equal(payload.aiGatewayAuth, "unavailable");
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

test("preflight passes when Redis is configured and AI Gateway auth resolves to OIDC on Vercel", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.invalid",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.invalid/api/admin/preflight"),
      );

      // Checks must all pass — channels may fail for unrelated reasons
      // (e.g. missing channel credentials), so assert checks independently.
      assert.equal(payload.storeBackend, "redis");
      assert.equal(payload.aiGatewayAuth, "oidc");
      for (const check of payload.checks) {
        assert.notEqual(
          check.status,
          "fail",
          `check ${check.id} should not fail: ${check.message}`,
        );
      }
    },
  );
});

test("preflight actions include remediation text", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
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
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
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
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
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
        ["ai-gateway", "bootstrap-exposure", "cron-secret", "public-origin", "store", "webhook-bypass"],
        "preflight checks should be exactly the 6 config-only checks",
      );
    },
  );
});

test("preflight warns when OPENCLAW_PACKAGE_SPEC is missing on Vercel (fallback source)", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: undefined,
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      // Fallback source should warn even though the fallback value is pinned
      const specCheck = payload.checks.find(
        (c) => c.id === "openclaw-package-spec",
      );
      assert.ok(specCheck, "expected openclaw-package-spec check on Vercel");
      assert.equal(specCheck.status, "warn");

      // Preflight should still pass (warn does not block)
      assert.equal(payload.ok, true, "fallback package-spec warning should not block preflight");
    },
  );
});

test("preflight has no package-spec check when pinned on Vercel", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@2.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      // Pinned spec passes — check present with pass status
      const specCheck = payload.checks.find(
        (c) => c.id === "openclaw-package-spec",
      );
      assert.ok(specCheck, "expected openclaw-package-spec check on Vercel");
      assert.equal(specCheck.status, "pass");

      // No action needed
      const specAction = payload.actions.find(
        (a) => a.id === "configure-openclaw-package-spec",
      );
      assert.equal(specAction, undefined, "no action needed when pinned");

      assert.equal(payload.ok, true);
    },
  );
});

// ===========================================================================
// Cross-surface OPENCLAW_PACKAGE_SPEC consistency
// ===========================================================================

test("cross-surface: unpinned package-spec is a warning, not a blocker", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@latest",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const request = new Request(
        "https://app.example.com/api/admin/preflight",
      );

      const payload = await buildDeployPreflight(request);

      // Preflight should pass — unpinned spec is only a warning
      assert.equal(payload.ok, true, "preflight.ok should be true with unpinned spec (warn only)");

      const specCheck = payload.checks.find(
        (c) => c.id === "openclaw-package-spec",
      );
      assert.ok(specCheck, "expected openclaw-package-spec check");
      assert.equal(specCheck.status, "warn");
      assert.ok(
        specCheck.message.includes("not a pinned version"),
        "message should mention unpinned version",
      );

      // Channels should NOT be blocked by package-spec (it's excluded from channel blockers)
      for (const ch of Object.values(payload.channels)) {
        const specIssue = ch.issues.find(
          (i) => i.id === "openclaw-package-spec",
        );
        assert.equal(
          specIssue,
          undefined,
          `channel ${ch.channel} should not have openclaw-package-spec issue`,
        );
        assert.equal(
          ch.canConnect,
          true,
          `channel ${ch.channel} should be connectable despite unpinned spec`,
        );
      }

      // Action should be emitted as recommended (not required)
      const specAction = payload.actions.find(
        (a) => a.id === "configure-openclaw-package-spec",
      );
      assert.ok(specAction, "expected configure-openclaw-package-spec action");
      assert.equal(specAction.status, "recommended");
    },
  );
});

test("cross-surface: no surfaces emit package-spec blocker when non-Vercel", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: undefined,
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const request = new Request(
        "https://app.example.com/api/admin/preflight",
      );

      const payload = await buildDeployPreflight(request);

      // Non-Vercel: contract does not check package-spec
      assert.equal(payload.ok, true, "preflight.ok should be true without Vercel");

      const specCheck = payload.checks.find(
        (c) => c.id === "openclaw-package-spec",
      );
      assert.equal(
        specCheck,
        undefined,
        "no openclaw-package-spec check should be emitted on non-Vercel",
      );

      const specAction = payload.actions.find(
        (a) => a.id === "configure-openclaw-package-spec",
      );
      assert.equal(
        specAction,
        undefined,
        "no configure-openclaw-package-spec action should be emitted on non-Vercel",
      );

      // Channels should have no package-spec issue
      for (const ch of Object.values(payload.channels)) {
        const specIssue = ch.issues.find(
          (i) => i.id === "openclaw-package-spec",
        );
        assert.equal(
          specIssue,
          undefined,
          `channel ${ch.channel} should not have openclaw-package-spec issue on non-Vercel`,
        );
      }
    },
  );
});

// ===========================================================================
// Contract → Preflight parity matrix
// Ensures preflight derives status from contract, not its own inline logic.
// ===========================================================================

test("parity: local missing public-origin env vars is warn in contract (no request)", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      // Without a request, contract sees unresolvable origin → warn (not fail)
      const contract = await buildDeploymentContract();
      const contractOrigin = contract.requirements.find(
        (r) => r.id === "public-origin",
      );
      assert.equal(contractOrigin?.status, "warn");

      // With a request, contract resolves origin from request URL → pass.
      // This is correct: preflight always has a live request so can resolve.
      const payload = await buildDeployPreflight(
        new Request("http://localhost:3000/api/admin/preflight"),
      );
      const preflightOrigin = payload.checks.find(
        (c) => c.id === "public-origin",
      );
      assert.equal(preflightOrigin?.status, "pass");

      // All checks should be pass or warn (no fail) since this is non-Vercel
      for (const check of payload.checks) {
        assert.notEqual(
          check.status,
          "fail",
          `check ${check.id} should not fail on non-Vercel: ${check.message}`,
        );
      }
    },
  );
});

test("parity: Vercel missing public-origin is fail in contract (no request)", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      // Without a request, there is no host fallback, so origin fails
      const contract = await buildDeploymentContract();
      const contractOrigin = contract.requirements.find(
        (r) => r.id === "public-origin",
      );
      assert.equal(contractOrigin?.status, "fail");

      // When preflight receives a request, it passes it to the contract,
      // which resolves origin from the request URL's host. This is correct:
      // a live request can always resolve its own origin.
      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );
      const preflightOrigin = payload.checks.find(
        (c) => c.id === "public-origin",
      );
      // Preflight passes because the contract received the request
      assert.equal(preflightOrigin?.status, "pass");
    },
  );
});

test("parity: local missing OIDC is warn (not fail) in both contract and preflight", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: "https://local.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const contract = await buildDeploymentContract();
      const contractGw = contract.requirements.find(
        (r) => r.id === "ai-gateway",
      );
      assert.equal(contractGw?.status, "warn");

      const payload = await buildDeployPreflight(
        new Request("https://local.example.com/api/admin/preflight"),
      );
      const preflightGw = payload.checks.find(
        (c) => c.id === "ai-gateway",
      );
      assert.equal(
        preflightGw?.status,
        "warn",
        "preflight must derive ai-gateway warn from contract, not hard-fail",
      );
      assert.equal(payload.ok, true, "warn does not block ok");
    },
  );
});

test("parity: Vercel missing OIDC is fail in both contract and preflight", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const contract = await buildDeploymentContract();
      const contractGw = contract.requirements.find(
        (r) => r.id === "ai-gateway",
      );
      assert.equal(contractGw?.status, "fail");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );
      const preflightGw = payload.checks.find(
        (c) => c.id === "ai-gateway",
      );
      assert.equal(preflightGw?.status, "fail");
      assert.equal(payload.ok, false);
    },
  );
});

test("parity: local missing store is warn in both contract and preflight", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: "https://local.example.com",
      REDIS_URL: undefined,
      KV_URL: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const contract = await buildDeploymentContract();
      const contractStore = contract.requirements.find(
        (r) => r.id === "store",
      );
      assert.equal(contractStore?.status, "warn");

      const payload = await buildDeployPreflight(
        new Request("https://local.example.com/api/admin/preflight"),
      );
      const preflightStore = payload.checks.find(
        (c) => c.id === "store",
      );
      assert.equal(
        preflightStore?.status,
        "warn",
        "preflight must derive store warn from contract",
      );
      assert.equal(payload.ok, true, "warn does not block ok");
    },
  );
});

test("parity: Vercel missing store is fail in both contract and preflight", async () => {
  const { buildDeploymentContract } = await import(
    "@/server/deployment-contract"
  );
  await withEnv(
    {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const contract = await buildDeploymentContract();
      const contractStore = contract.requirements.find(
        (r) => r.id === "store",
      );
      assert.equal(contractStore?.status, "fail");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );
      const preflightStore = payload.checks.find(
        (c) => c.id === "store",
      );
      assert.equal(preflightStore?.status, "fail");
      assert.equal(payload.ok, false);
    },
  );
});

test("parity: local env action severity is recommended for store and ai-gateway", async () => {
  // Local environment with missing store and OIDC — both should be
  // "recommended" actions (warn in contract), not "required" (fail).
  // Public origin resolves from the request URL, so no origin action.
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("http://localhost:3000/api/admin/preflight"),
      );

      const storeAction = payload.actions.find(
        (a) => a.id === "configure-redis",
      );
      assert.ok(storeAction, "expected configure-redis action");
      assert.equal(
        storeAction.status,
        "recommended",
        "local missing store should be recommended, not required",
      );

      const gwAction = payload.actions.find(
        (a) => a.id === "configure-ai-gateway-auth",
      );
      assert.ok(gwAction, "expected configure-ai-gateway-auth action");
      assert.equal(
        gwAction.status,
        "recommended",
        "local missing OIDC should be recommended, not required",
      );

      // All preflight checks should be pass or warn — no hard-fail on non-Vercel
      for (const check of payload.checks) {
        assert.notEqual(
          check.status,
          "fail",
          `check ${check.id} should not fail on non-Vercel: ${check.message}`,
        );
      }
    },
  );
});

test("parity: Vercel env action severity is required for store and ai-gateway", async () => {
  await withEnv(
    {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: undefined,
      KV_URL: undefined,
      AI_GATEWAY_API_KEY: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      const storeAction = payload.actions.find(
        (a) => a.id === "configure-redis",
      );
      assert.ok(storeAction, "expected configure-redis action");
      assert.equal(
        storeAction.status,
        "required",
        "Vercel missing store should be required",
      );

      const gwAction = payload.actions.find(
        (a) => a.id === "configure-ai-gateway-auth",
      );
      assert.ok(gwAction, "expected configure-ai-gateway-auth action");
      assert.equal(
        gwAction.status,
        "required",
        "Vercel missing OIDC should be required",
      );

      assert.equal(payload.ok, false);
    },
  );
});

test("preflight is config-only: passes on a fresh deployment before launch-verify has ever run", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
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

// ===========================================================================
// getLaunchVerifyBlocking — canonical helper tests
// ===========================================================================

test("getLaunchVerifyBlocking returns not blocking when all checks pass", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      CRON_SECRET: "cron-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );
      const result = getLaunchVerifyBlocking(payload);
      assert.equal(result.blocking, false);
    },
  );
});

test("getLaunchVerifyBlocking returns blocking with skip phase IDs when checks fail", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: undefined,
      KV_URL: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );
      const result = getLaunchVerifyBlocking(payload);
      assert.equal(result.blocking, true);
      assert.ok(result.failingCheckIds.length > 0, "should have failing check IDs");
      assert.ok(result.errorMessage, "should have error message");
      assert.ok(result.errorMessage.length > 0, "error message should be non-empty");
      assert.deepEqual(
        [...result.skipPhaseIds],
        ["queuePing", "ensureRunning", "chatCompletions", "wakeFromSleep", "restorePrepared"],
        "skip phase IDs should match the canonical set",
      );
      // Error message should include at least one failing check ID
      for (const id of result.failingCheckIds) {
        assert.ok(
          result.errorMessage.includes(id),
          `errorMessage should include failing check ID '${id}'`,
        );
      }
      // New fields should be populated
      assert.ok(result.requiredActionIds.length > 0, "should have required action IDs");
      assert.ok(Array.isArray(result.recommendedActionIds), "should have recommendedActionIds array");
    },
  );
});

test("webhook-bypass check is never 'fail' — missing bypass is warn, not a blocker", async () => {
  // This test verifies the core contract: webhook-bypass is diagnostic-only.
  // Even though getWebhookBypassRequirement() currently always returns
  // required: false, the preflight check must use "warn" (not "fail") for the
  // required-but-missing branch so that payload.ok and getLaunchVerifyBlocking
  // never treat a missing bypass secret as a hard blocker.
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      const bypassCheck = payload.checks.find((c) => c.id === "webhook-bypass");
      assert.ok(bypassCheck, "expected webhook-bypass check");
      assert.notEqual(
        bypassCheck.status,
        "fail",
        "webhook-bypass must never be 'fail' — it is diagnostic-only",
      );

      // Verify this does not make preflight blocking
      assert.equal(payload.ok, true, "missing bypass must not make payload.ok false");
      const blocking = getLaunchVerifyBlocking(payload);
      assert.equal(
        blocking.blocking,
        false,
        "missing bypass must not block launch-verify runtime phases",
      );

      // Verify the action (if present) is recommended, not required
      const bypassAction = payload.actions.find(
        (a) => a.id === "configure-webhook-bypass",
      );
      if (bypassAction) {
        assert.equal(
          bypassAction.status,
          "recommended",
          "webhook-bypass action must be 'recommended', not 'required'",
        );
      }
    },
  );
});

test("getLaunchVerifyBlocking: synthetic webhook-bypass warn does not block", () => {
  // Direct unit test of the blocking helper with a payload that has
  // webhook-bypass as "warn" — proving the contract holds at the
  // getLaunchVerifyBlocking boundary regardless of how the payload was built.
  const syntheticPayload = {
    ok: true,
    authMode: "admin-secret" as const,
    publicOrigin: "https://app.example.com",
    webhookBypassEnabled: false,
    webhookBypassRecommended: true,
    deploymentProtectionDetected: false,
    storeBackend: "redis" as const,
    aiGatewayAuth: "oidc" as const,
    cronSecretConfigured: true,
    cronSecretExplicitlyConfigured: true,
    cronSecretSource: "cron-secret" as const,
    publicOriginResolution: null,
    webhookDiagnostics: { slack: null, telegram: null, discord: null },
    channels: {} as never,
    actions: [],
    checks: [
      { id: "public-origin" as const, status: "pass" as const, message: "ok" },
      { id: "webhook-bypass" as const, status: "warn" as const, message: "bypass not configured" },
      { id: "store" as const, status: "pass" as const, message: "ok" },
      { id: "ai-gateway" as const, status: "pass" as const, message: "ok" },
    ],
    nextSteps: [],
    dlq: {
      indexSize: 0,
      channelCounts: { slack: 0, telegram: 0, whatsapp: 0, discord: 0 },
      terminalCount: 0,
      oldestFailedAt: null,
      newestFailedAt: null,
    },
  };

  const result = getLaunchVerifyBlocking(syntheticPayload);
  assert.equal(result.blocking, false, "warn-level webhook-bypass must not block launch-verify");
});

test("preflight warns but does not fail when bypass is required and missing", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
      NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "client-id",
      VERCEL_APP_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: "session-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://openclaw.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);
      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "warn",
      );
      assert.ok(
        payload.actions.some(
          (action) =>
            action.id === "configure-webhook-bypass" &&
            action.status === "recommended",
        ),
      );
    },
  );
});

test("getLaunchVerifyBlocking treats warn-only checks as non-blocking", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://local.example.com",
      REDIS_URL: undefined,
      KV_URL: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);

      const payload = await buildDeployPreflight(
        new Request("https://local.example.com/api/admin/preflight"),
      );
      // On non-Vercel, store and ai-gateway are warn, not fail
      assert.equal(payload.ok, true);
      const result = getLaunchVerifyBlocking(payload);
      assert.equal(result.blocking, false, "warn-only checks should not block launch-verify");
    },
  );
});

// ===========================================================================
// Cron secret as a first-class preflight and launch-verify blocker
// ===========================================================================

test("preflight fails on Vercel when CRON_SECRET is missing", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      ADMIN_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, false, "preflight.ok should be false when CRON_SECRET is missing on Vercel");

      const cronCheck = payload.checks.find((c) => c.id === "cron-secret");
      assert.ok(cronCheck, "expected cron-secret check");
      assert.equal(cronCheck.status, "fail", "cron-secret check should fail on Vercel without CRON_SECRET");

      const cronAction = payload.actions.find((a) => a.id === "configure-cron-secret");
      assert.ok(cronAction, "expected configure-cron-secret action");
      assert.equal(cronAction.status, "required", "configure-cron-secret should be required on Vercel");
      assert.ok(cronAction.remediation.length > 0, "remediation should be non-empty");
      assert.ok(cronAction.env.includes("CRON_SECRET"), "env should include CRON_SECRET");
    },
  );
});

test("getLaunchVerifyBlocking blocks when cron-secret is failing on Vercel", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      ADMIN_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      const result = getLaunchVerifyBlocking(payload);
      assert.equal(result.blocking, true, "should block when cron-secret is failing");
      assert.ok(
        result.failingCheckIds.includes("cron-secret"),
        "failingCheckIds should include cron-secret",
      );
      assert.ok(
        result.requiredActionIds.includes("configure-cron-secret"),
        "requiredActionIds should include configure-cron-secret",
      );
      assert.ok(result.errorMessage, "should have an error message");
      assert.ok(
        result.errorMessage!.includes("cron-secret"),
        "error message should mention cron-secret",
      );
    },
  );
});

test("preflight does not hard-fail on cron-secret outside Vercel", async () => {
  await withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://local.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      CRON_SECRET: undefined,
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://local.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true, "preflight.ok should be true outside Vercel even without CRON_SECRET");

      const cronCheck = payload.checks.find((c) => c.id === "cron-secret");
      assert.ok(cronCheck, "expected cron-secret check");
      assert.notEqual(
        cronCheck.status,
        "fail",
        "cron-secret check should not fail outside Vercel",
      );

      const cronAction = payload.actions.find((a) => a.id === "configure-cron-secret");
      assert.equal(cronAction, undefined, "no configure-cron-secret action expected outside Vercel");

      const result = getLaunchVerifyBlocking(payload);
      assert.equal(result.blocking, false, "should not block outside Vercel without CRON_SECRET");
    },
  );
});

// ===========================================================================
// aiGatewayAuth: "api-key" static key path
// ===========================================================================

test("preflight reports api-key when AI_GATEWAY_API_KEY is used without OIDC", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      CRON_SECRET: "cron-secret",
      AI_GATEWAY_API_KEY: "static-api-key",
    },
    async () => {
      // No OIDC token — only the static API key is available
      _setAiGatewayTokenOverrideForTesting(undefined);
      _setAiGatewayCredentialOverrideForTesting({
        token: "static-api-key",
        source: "api-key",
        expiresAt: null,
      });

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.aiGatewayAuth, "api-key", "should report api-key when static key is the credential source");
      assert.equal(payload.ok, true, "api-key auth should satisfy preflight");

      const gwCheck = payload.checks.find((c) => c.id === "ai-gateway");
      assert.ok(gwCheck, "expected ai-gateway check");
      assert.equal(gwCheck.status, "pass", "ai-gateway check should pass with api-key");
    },
  );
});

// ===========================================================================
// Drift-resistant: webhook-bypass remediation copy and AI Gateway fallback
// ===========================================================================

test("preflight bypass remediation text mentions all channels", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "client-id",
      VERCEL_APP_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: "session-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      // Bypass check must be warn, never fail
      const bypassCheck = payload.checks.find((c) => c.id === "webhook-bypass");
      assert.ok(bypassCheck, "expected webhook-bypass check");
      assert.equal(bypassCheck.status, "warn", "missing bypass must be warn, not fail");

      // The action copy must mention all channel webhooks
      const bypassAction = payload.actions.find(
        (a) => a.id === "configure-webhook-bypass",
      );
      assert.ok(bypassAction, "expected configure-webhook-bypass action");
      assert.match(bypassAction.message, /Slack/i, "message must mention Slack");
      assert.match(bypassAction.message, /Telegram/i, "message must mention Telegram");
      assert.match(bypassAction.message, /Discord/i, "message must mention Discord");

      // Overall preflight must still pass (bypass is diagnostic-only)
      assert.equal(payload.ok, true, "missing bypass must not make preflight fail");
    },
  );
});

test("preflight accepts AI_GATEWAY_API_KEY fallback on Vercel when OIDC is unavailable", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "cron-secret",
      AI_GATEWAY_API_KEY: "static-key",
    },
    async () => {
      // No OIDC — only static API key
      _setAiGatewayTokenOverrideForTesting(undefined);
      _setAiGatewayCredentialOverrideForTesting({
        token: "static-key",
        source: "api-key",
        expiresAt: null,
      });

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.aiGatewayAuth, "api-key", "should report api-key on Vercel fallback");
      assert.equal(
        payload.checks.find((c) => c.id === "ai-gateway")?.status,
        "pass",
        "ai-gateway check should pass with api-key fallback on Vercel",
      );
      assert.equal(payload.ok, true, "preflight should pass with api-key fallback on Vercel");
    },
  );
});

test("preflight passes cron-secret check when CRON_SECRET is configured on Vercel", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: "my-secret",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.ok, true);

      const cronCheck = payload.checks.find((c) => c.id === "cron-secret");
      assert.ok(cronCheck, "expected cron-secret check");
      assert.equal(cronCheck.status, "pass", "cron-secret check should pass when configured");

      const cronAction = payload.actions.find((a) => a.id === "configure-cron-secret");
      assert.equal(cronAction, undefined, "no action needed when CRON_SECRET is configured");
    },
  );
});

test("preflight cron fields reflect ADMIN_SECRET fallback on Vercel", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "admin-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
      CRON_SECRET: undefined,
      ADMIN_SECRET: "admin-secret-for-fallback",
    },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const payload = await buildDeployPreflight(
        new Request("https://app.example.com/api/admin/preflight"),
      );

      assert.equal(payload.cronSecretConfigured, true, "cronSecretConfigured should be true with ADMIN_SECRET fallback");
      assert.equal(payload.cronSecretExplicitlyConfigured, false, "cronSecretExplicitlyConfigured should be false");
      assert.equal(payload.cronSecretSource, "admin-secret", "cronSecretSource should be admin-secret");

      const cronCheck = payload.checks.find((c) => c.id === "cron-secret");
      assert.ok(cronCheck, "expected cron-secret check");
      assert.equal(cronCheck.status, "warn", "cron-secret check should warn when falling back to ADMIN_SECRET on Vercel");
    },
  );
});

test("preflight treats missing webhook bypass as warning and mentions channels", async () => {
  await withEnv(
    {
      VERCEL: "1",
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      CRON_SECRET: "cron-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "client-id",
      VERCEL_APP_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: "session-secret-32-chars-minimum!",
    },
    async () => {
      _setAiGatewayCredentialOverrideForTesting({
        token: "static-key",
        source: "api-key",
        expiresAt: null,
      });

      const request = new Request("https://app.example.com/api/admin/preflight", {
        headers: {
          host: "app.example.com",
          "x-forwarded-proto": "https",
        },
      });

      const payload = await buildDeployPreflight(request);

      assert.equal(
        payload.checks.find((check) => check.id === "webhook-bypass")?.status,
        "warn",
      );

      const action = payload.actions.find(
        (item) => item.id === "configure-webhook-bypass",
      );
      assert.ok(action, "expected configure-webhook-bypass action");
      assert.match(action.message, /Slack/i);
      assert.match(action.message, /Telegram/i);
      assert.match(action.message, /Discord/i);
    },
  );
});

test("preflight accepts AI_GATEWAY_API_KEY fallback on Vercel", async () => {
  await withEnv(
    {
      VERCEL: "1",
      CRON_SECRET: "cron-secret",
      REDIS_URL: "redis://default:token@example.com:6379",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    async () => {
      _setAiGatewayCredentialOverrideForTesting({
        token: "static-key",
        source: "api-key",
        expiresAt: null,
      });

      const request = new Request("https://app.example.com/api/admin/preflight", {
        headers: {
          host: "app.example.com",
          "x-forwarded-proto": "https",
        },
      });

      const payload = await buildDeployPreflight(request);

      assert.equal(payload.aiGatewayAuth, "api-key");
      assert.equal(
        payload.checks.find((check) => check.id === "ai-gateway")?.status,
        "pass",
      );
    },
  );
});
