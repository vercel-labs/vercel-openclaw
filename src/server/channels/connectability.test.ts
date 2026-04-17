import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectabilityMap,
  buildChannelConnectabilityReport,
  buildChannelPrerequisite,
  buildChannelPrerequisiteReport,
} from "@/server/channels/connectability";
import {
  buildChannelDisplayWebhookUrl,
  buildChannelWebhookUrl,
} from "@/server/channels/webhook-urls";
import { buildDeploymentContract } from "@/server/deployment-contract";
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
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
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
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  process.env.CRON_SECRET = "test-cron-secret";
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
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  delete process.env.CRON_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  // Channel connectability should have no issues in this setup
  assert.equal(result.canConnect, true);
});

test("warns when Redis env vars are missing in non-Vercel environment", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
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

test("fails when Redis env vars are missing on Vercel deployment", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
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
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
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

test("webhook URL never includes bypass secret even when bypass secret is set", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "admin-secret";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.0.0";
  process.env.CRON_SECRET = "test-cron-secret";
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
    webhookUrl.searchParams.has("x-vercel-protection-bypass"),
    false,
    "connectability webhookUrl must never expose the bypass secret",
  );
});

test("fails when isVercelDeployment() and OIDC is unavailable", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
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
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
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

test("Vercel deployment missing OPENCLAW_PACKAGE_SPEC does not block channels", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  const issue = result.issues.find((i) => i.id === "openclaw-package-spec");
  assert.equal(issue, undefined, "openclaw-package-spec is excluded from channel-blocking issues");
});

test("Vercel deployment with pinned OPENCLAW_PACKAGE_SPEC passes channel connectability (check disabled)", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@1.2.3";
  process.env.CRON_SECRET = "test-cron-secret";
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

// ---------------------------------------------------------------------------
// Parity matrix: deployment contract ↔ channel connectability
//
// For the same env matrix, deployment-level blockers (public-origin, store,
// ai-gateway) surfaced by channel connectability must match the canonical
// statuses from buildDeploymentContract(). Channel-only blockers like
// public-webhook-url must NOT appear in the contract.
// ---------------------------------------------------------------------------

/** IDs that the deployment contract owns and channels should mirror. */
const CONTRACT_CHANNEL_IDS = new Set(["public-origin", "store", "ai-gateway"]);

type ParityCase = {
  name: string;
  env: Record<string, string | undefined>;
  oidc: string | undefined;
};

const PARITY_MATRIX: ParityCase[] = [
  {
    name: "Vercel: all configured",
    env: {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: "redis://default:token@example.com:6379",
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    oidc: "oidc-token",
  },
  {
    name: "Vercel: missing store",
    env: {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    oidc: "oidc-token",
  },
  {
    name: "Vercel: missing OIDC",
    env: {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    oidc: undefined,
  },
  {
    name: "Vercel: missing store + OIDC",
    env: {
      VERCEL: "1",
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: undefined,
      KV_URL: undefined,
      AI_GATEWAY_API_KEY: undefined,
      OPENCLAW_PACKAGE_SPEC: "openclaw@1.0.0",
    },
    oidc: undefined,
  },
  {
    name: "non-Vercel: missing store (warn, not fail)",
    env: {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: undefined,
      KV_URL: undefined,
    },
    oidc: "oidc-token",
  },
  {
    name: "non-Vercel: missing OIDC (warn, not fail)",
    env: {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NEXT_PUBLIC_APP_URL: PUBLIC_ORIGIN,
      REDIS_URL: "redis://default:token@example.com:6379",
      AI_GATEWAY_API_KEY: undefined,
    },
    oidc: undefined,
  },
];

for (const { name, env, oidc } of PARITY_MATRIX) {
  test(`parity: ${name}`, async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    _setAiGatewayTokenOverrideForTesting(oidc ?? null);

    const request = makeRequest(PUBLIC_ORIGIN);
    const contract = await buildDeploymentContract({ request });
    const connectability = await buildChannelConnectability(
      "slack",
      request,
      undefined,
      { contract },
    );

    // Extract statuses for the shared IDs from each surface.
    const contractStatuses = new Map(
      contract.requirements
        .filter((r) => CONTRACT_CHANNEL_IDS.has(r.id))
        .map((r) => [r.id, r.status]),
    );

    const channelStatuses = new Map(
      connectability.issues
        .filter((i) => CONTRACT_CHANNEL_IDS.has(i.id))
        .map((i) => [i.id, i.status]),
    );

    // Every non-pass contract requirement in the shared set must appear in
    // channel issues with the same status.
    for (const [id, status] of contractStatuses) {
      if (status === "pass") {
        assert.equal(
          channelStatuses.has(id),
          false,
          `contract ${id}=pass should not appear as a channel issue`,
        );
      } else {
        assert.equal(
          channelStatuses.get(id),
          status,
          `contract ${id}=${status} must match channel issue status`,
        );
      }
    }

    // Channel-only issues must NOT appear in the contract.
    const channelOnlyIssues = connectability.issues.filter(
      (i) => i.id === "public-webhook-url" || i.id === "launch-verification",
    );
    for (const issue of channelOnlyIssues) {
      const inContract = contract.requirements.some((r) => r.id === issue.id);
      assert.equal(
        inContract,
        false,
        `channel-only issue ${issue.id} must not appear in deployment contract`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// buildChannelConnectabilityMap — shared map builder
// ---------------------------------------------------------------------------

test("buildChannelConnectabilityMap returns all four channels", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  const map = await buildChannelConnectabilityMap(request);

  assert.ok(map.slack, "map must include slack");
  assert.ok(map.telegram, "map must include telegram");
  assert.ok(map.discord, "map must include discord");
  assert.ok(map.whatsapp, "map must include whatsapp");
  assert.equal(map.slack.channel, "slack");
  assert.equal(map.telegram.channel, "telegram");
  assert.equal(map.discord.channel, "discord");
  assert.equal(map.whatsapp.channel, "whatsapp");
});

test("buildChannelConnectabilityMap reuses shared contract", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  const contract = await buildDeploymentContract({ request });
  const map = await buildChannelConnectabilityMap(request, {
    shared: { contract },
  });

  // All channels should reference the same contract-derived issues
  for (const channel of ["slack", "telegram", "discord", "whatsapp"] as const) {
    assert.equal(map[channel].channel, channel);
    assert.ok(typeof map[channel].canConnect === "boolean");
  }
});

test("telegram webhook URL stays on the display URL path", () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;

  const request = makeRequest(PUBLIC_ORIGIN);

  assert.equal(
    buildChannelDisplayWebhookUrl("telegram", request),
    `${PUBLIC_ORIGIN}/api/channels/telegram/webhook`,
  );
  assert.equal(
    buildChannelWebhookUrl("telegram", request),
    `${PUBLIC_ORIGIN}/api/channels/telegram/webhook`,
  );
});

test("prerequisite and connectability report wrappers are behaviorally identical", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  const contract = await buildDeploymentContract({ request });
  const shared = { contract };

  const prerequisite = await buildChannelPrerequisiteReport(request, shared);
  const connectability = await buildChannelConnectabilityReport(request, shared);

  assert.deepEqual(connectability, prerequisite);
  assert.equal(
    connectability.discord.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/discord/webhook`,
  );
});

test("buildChannelConnectabilityMap respects webhookUrlOverrides", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  const overrideUrl = "https://custom.example.com/api/channels/slack/webhook";
  const map = await buildChannelConnectabilityMap(request, {
    webhookUrlOverrides: { slack: overrideUrl },
  });

  assert.equal(map.slack.webhookUrl, overrideUrl);
  // Telegram and discord should still use the default display URLs
  assert.equal(
    map.telegram.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/telegram/webhook`,
  );
});

// ---------------------------------------------------------------------------
// WhatsApp — webhook-proxied channel
// ---------------------------------------------------------------------------

test("whatsapp connectability uses webhook-proxied mode with a webhook URL", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "whatsapp",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.channel, "whatsapp");
  assert.equal(result.mode, "webhook-proxied");
  assert.equal(
    result.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/whatsapp/webhook`,
  );
  assert.equal(result.canConnect, true, "whatsapp should be connectable when prerequisites pass");
  assert.equal(result.status, "pass");
  assert.equal(result.issues.length, 0);
});

test("whatsapp connectability requires a public webhook URL", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "whatsapp",
    makeRequest(LOCAL_ORIGIN),
  );

  assert.equal(result.canConnect, false, "whatsapp should fail for missing public URL");
  const webhookIssue = result.issues.find((i) => i.id === "public-webhook-url");
  assert.ok(webhookIssue, "whatsapp must have public-webhook-url issue");
});

test("whatsapp surfaces contract issues (store, ai-gateway)", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const result = await buildChannelConnectability(
    "whatsapp",
    makeRequest(PUBLIC_ORIGIN),
  );

  const storeIssue = result.issues.find((i) => i.id === "store");
  assert.ok(storeIssue, "whatsapp must surface store contract issue");
  const aiGatewayIssue = result.issues.find((i) => i.id === "ai-gateway");
  assert.ok(aiGatewayIssue, "whatsapp must surface ai-gateway contract issue");
});

// ---------------------------------------------------------------------------
// Guardrails: WhatsApp uses webhook-proxied ingress like other channels
// ---------------------------------------------------------------------------

test("whatsapp appears in webhook URL builders", () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;

  const displayUrl = buildChannelDisplayWebhookUrl("whatsapp");
  const deliveryUrl = buildChannelWebhookUrl("whatsapp");

  assert.ok(displayUrl?.includes("/api/channels/whatsapp/webhook"));
  assert.ok(deliveryUrl?.includes("/api/channels/whatsapp/webhook"));
});

test("whatsapp connectability report includes webhookUrl in full report", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  const report = await buildChannelConnectabilityReport(request);

  assert.equal(
    report.whatsapp.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/whatsapp/webhook`,
  );
  assert.equal(report.whatsapp.mode, "webhook-proxied");
  assert.ok(report.slack.webhookUrl, "slack must have a webhookUrl in report");
  assert.ok(report.telegram.webhookUrl, "telegram must have a webhookUrl in report");
  assert.ok(report.discord.webhookUrl, "discord must have a webhookUrl in report");
});

test("webhook-proxied channels include mode field", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const request = makeRequest(PUBLIC_ORIGIN);
  for (const channel of ["slack", "telegram", "discord", "whatsapp"] as const) {
    const result = await buildChannelConnectability(channel, request);
    assert.equal(result.mode, "webhook-proxied", `${channel} should be webhook-proxied`);
  }
});
