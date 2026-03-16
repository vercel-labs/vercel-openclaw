import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelPrerequisite,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

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

test("admin-secret mode does not require webhook bypass secret", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  const issue = result.issues.find((i) => i.id === "webhook-bypass");
  assert.equal(issue, undefined, "webhook-bypass should not be an issue in admin-secret mode");
});

test("passes with public origin, bypass, durable store, and OIDC", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

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

test("fails with multiple issues when store and OIDC are missing on Vercel", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
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
  assert.deepEqual(issueIds, ["ai-gateway", "store"]);
  assert.equal(
    result.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/slack/webhook`,
  );
});

test("webhook URL includes bypass query param when bypass secret is set", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

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

test("fails when isVercelDeployment() and OIDC is unavailable", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "ai-gateway");
  assert.ok(issue, "expected ai-gateway issue");
  assert.equal(issue.status, "fail");
});

test("connectability delegates to prerequisite (no launch-verification gate)", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const req = makeRequest(PUBLIC_ORIGIN);

  const prereq = await buildChannelPrerequisite("slack", req);
  const full = await buildChannelConnectability("slack", req);

  assert.deepEqual(prereq.issues, full.issues);
  assert.equal(prereq.canConnect, full.canConnect);
  assert.equal(
    full.issues.find((i) => i.id === "launch-verification"),
    undefined,
    "connectability must not include launch-verification issue",
  );
});

test("Vercel deployment missing OPENCLAW_PACKAGE_SPEC does not block channels (check disabled)", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  const issue = result.issues.find((i) => i.id === "openclaw-package-spec");
  assert.equal(issue, undefined, "openclaw-package-spec check is disabled");
});

test("Vercel deployment with pinned OPENCLAW_PACKAGE_SPEC passes channel connectability (check disabled)", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  const issue = result.issues.find((i) => i.id === "openclaw-package-spec");
  assert.equal(issue, undefined, "should have no openclaw-package-spec issue");
});

