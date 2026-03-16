import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelPrerequisite,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import {
  _setChannelReadinessOverrideForTesting,
  getCurrentDeploymentId,
} from "@/server/launch-verify/state";
import type { ChannelReadiness } from "@/shared/launch-verification";

const ORIGINAL_ENV = { ...process.env };
const LOCAL_ORIGIN = "http://localhost:3000";
const PUBLIC_ORIGIN = "https://openclaw.example";

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

function makeReadyReadiness(): ChannelReadiness {
  return {
    deploymentId: getCurrentDeploymentId(),
    ready: true,
    verifiedAt: new Date().toISOString(),
    mode: "destructive",
    wakeFromSleepPassed: true,
    failingPhaseId: null,
    phases: [],
  };
}

function makeRequest(origin: string): Request {
  const host = origin.replace(/^https?:\/\//, "");
  return new Request(`${origin}/api/status`, {
    headers: {
      host,
      "x-forwarded-host": host,
      "x-forwarded-proto": origin.startsWith("https://") ? "https" : "http",
    },
  });
}

afterEach(() => {
  resetEnv();
  _setAiGatewayTokenOverrideForTesting(null);
  _setChannelReadinessOverrideForTesting(null);
});

test("fails when the webhook url is not public https", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const result = await buildChannelConnectability(
    "discord",
    makeRequest(LOCAL_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(result.status, "fail");
  const issue = result.issues.find((i) => i.id === "public-webhook-url");
  assert.ok(issue, "expected public-webhook-url issue");
  assert.equal(typeof issue.remediation, "string");
  assert.ok(issue.remediation.length > 0, "remediation should not be empty");
});

test("fails when deployment protection is active on Vercel without bypass secret", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "webhook-bypass");
  assert.ok(issue, "expected webhook-bypass issue");
  assert.equal(typeof issue.remediation, "string");
  assert.ok(
    issue.remediation.includes("Deployment Protection"),
    "remediation should mention Deployment Protection",
  );
});

test("passes with public origin, bypass, durable store, and OIDC", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  assert.equal(result.status, "pass");
  assert.equal(result.issues.length, 0);
});

test("does not warn about missing CRON_SECRET", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.CRON_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  const issueIds = result.issues.map((issue) => issue.id);
  assert.equal(
    issueIds.includes("drain-recovery" as never),
    false,
    "connectability should not include drain-recovery warning",
  );
});

test("warns when Upstash env vars are missing in non-Vercel environment", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true, "non-Vercel missing store should still allow connect");
  const issue = result.issues.find((i) => i.id === "store");
  assert.ok(issue, "expected store issue");
  assert.equal(issue.status, "warn");
});

test("fails when Upstash env vars are missing on Vercel deployment", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "store");
  assert.ok(issue, "expected store issue");
  assert.equal(issue.status, "fail");
});

test("fails with multiple issues when bypass, store, and OIDC are all missing on Vercel", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(result.status, "fail");
  const issueIds = result.issues.map((i) => i.id).sort();
  assert.deepEqual(issueIds, ["ai-gateway", "launch-verification", "openclaw-package-spec", "store", "webhook-bypass"]);
  assert.equal(
    result.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/slack/webhook`,
  );
});

test("webhook URL includes bypass query param when bypass secret is set", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  assert.ok(result.webhookUrl);
  const webhookUrl = new URL(result.webhookUrl!);
  assert.equal(webhookUrl.hostname, "openclaw.example");
  assert.equal(webhookUrl.pathname, "/api/channels/telegram/webhook");
  assert.equal(
    webhookUrl.searchParams.get("x-vercel-protection-bypass"),
    "bypass-secret",
  );
});

test("fails when isVercelDeployment() and auth is not oidc", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.AI_GATEWAY_API_KEY = "static-key";
  _setAiGatewayTokenOverrideForTesting("static-key");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "ai-gateway");
  assert.ok(issue, "expected ai-gateway issue");
  assert.equal(issue.status, "fail");
});

test("launch-verification blocker fires when readiness is missing", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  // No readiness override — defaults to ready: false
  _setChannelReadinessOverrideForTesting({
    deploymentId: getCurrentDeploymentId(),
    ready: false,
    verifiedAt: null,
    mode: null,
    wakeFromSleepPassed: false,
    failingPhaseId: null,
    phases: [],
  });

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "launch-verification");
  assert.ok(issue, "expected launch-verification issue");
  assert.equal(issue.status, "fail");
  assert.ok(
    issue.remediation.includes("destructive launch verification"),
    "remediation should mention destructive launch verification",
  );
  assert.ok(
    issue.remediation.includes('{"mode":"destructive"}') ||
    issue.remediation.includes("?mode=destructive"),
    "remediation should document how to invoke destructive mode",
  );
});

test("launch-verification blocker fires when readiness belongs to a different deploymentId", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting({
    deploymentId: "old-deployment-abc123",
    ready: true,
    verifiedAt: new Date().toISOString(),
    mode: "destructive",
    wakeFromSleepPassed: true,
    failingPhaseId: null,
    phases: [],
  });

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "launch-verification");
  assert.ok(issue, "expected launch-verification issue");
  assert.equal(issue.status, "fail");
  assert.ok(
    issue.message.includes("current deployment"),
    "message should mention current deployment",
  );
});

test("launch-verification blocker clears when readiness is valid for current deployment", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  const issue = result.issues.find((i) => i.id === "launch-verification");
  assert.equal(issue, undefined, "should have no launch-verification issue");
});

test("[regression] prerequisite excludes launch-verification; full connectability includes it", async () => {
  // Config is valid but launch-verification has not run.
  // This is the core regression: prerequisite (used by preflight) must pass,
  // while full connectability (used by channel PUT routes) must block.
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  // No readiness override → defaults to ready: false for current deployment
  _setChannelReadinessOverrideForTesting({
    deploymentId: getCurrentDeploymentId(),
    ready: false,
    verifiedAt: null,
    mode: null,
    wakeFromSleepPassed: false,
    failingPhaseId: null,
    phases: [],
  });

  const req = makeRequest(PUBLIC_ORIGIN);

  // Prerequisite (config-only): should pass
  const prereq = await buildChannelPrerequisite("slack", req);
  assert.equal(prereq.canConnect, true, "prerequisite should pass with valid config");
  assert.equal(
    prereq.issues.find((i) => i.id === "launch-verification"),
    undefined,
    "prerequisite must never include launch-verification issue",
  );

  // Full connectability: should block on launch-verification
  const full = await buildChannelConnectability("slack", req);
  assert.equal(full.canConnect, false, "full connectability should block without launch-verify");
  const launchIssue = full.issues.find((i) => i.id === "launch-verification");
  assert.ok(launchIssue, "full connectability must include launch-verification issue");
  assert.equal(launchIssue.status, "fail");
});

test("Vercel deployment missing OPENCLAW_PACKAGE_SPEC fails channel connectability", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "openclaw-package-spec");
  assert.ok(issue, "expected openclaw-package-spec issue");
  assert.equal(issue.status, "fail");
  assert.ok(
    issue.message.includes("OPENCLAW_PACKAGE_SPEC is required on Vercel deployments"),
    "message should use the same wording as deployment contract",
  );
});

test("Vercel deployment with pinned OPENCLAW_PACKAGE_SPEC passes channel connectability", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  const issue = result.issues.find((i) => i.id === "openclaw-package-spec");
  assert.equal(issue, undefined, "should have no openclaw-package-spec issue when pinned");
});

test("[regression] channel connectability blocks until launch-verify readiness is written for current deployment", async () => {
  // Simulates the full lifecycle: blocked → readiness written → unblocked
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const req = makeRequest(PUBLIC_ORIGIN);

  // Step 1: No readiness → blocked
  _setChannelReadinessOverrideForTesting({
    deploymentId: getCurrentDeploymentId(),
    ready: false,
    verifiedAt: null,
    mode: null,
    wakeFromSleepPassed: false,
    failingPhaseId: null,
    phases: [],
  });
  const blocked = await buildChannelConnectability("slack", req);
  assert.equal(blocked.canConnect, false, "should be blocked before launch-verify");

  // Step 2: Readiness written for current deployment → unblocked
  _setChannelReadinessOverrideForTesting(makeReadyReadiness());
  const unblocked = await buildChannelConnectability("slack", req);
  assert.equal(unblocked.canConnect, true, "should be unblocked after launch-verify passes");
  assert.equal(unblocked.issues.length, 0, "should have no issues after launch-verify passes");
});
