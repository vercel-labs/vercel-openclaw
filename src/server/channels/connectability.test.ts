import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { buildChannelConnectability } from "@/server/channels/connectability";

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
});

test("fails when the webhook url is not public https", () => {
  const result = buildChannelConnectability(
    "discord",
    makeRequest(LOCAL_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(result.status, "fail");
  assert.equal(
    result.issues.some((issue) => issue.id === "public-webhook-url"),
    true,
  );
});

test("fails when deployment protection is active on Vercel without bypass secret", () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const result = buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(
    result.issues.some((issue) => issue.id === "webhook-bypass"),
    true,
  );
});

test("passes with public origin, bypass, durable store, and cron", () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.CRON_SECRET = "cron";

  const result = buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  assert.equal(result.status, "pass");
  assert.equal(result.issues.length, 0);
});
