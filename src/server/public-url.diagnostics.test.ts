import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  buildPublicUrl,
  getPublicUrlDiagnostics,
  resolvePublicOrigin,
} from "@/server/public-url";

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_AUTH_MODE",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_DOMAIN",
  "BASE_DOMAIN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) {
      delete env[key];
    } else {
      env[key] = original;
    }
  }

  env.NODE_ENV = "test";
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
});

test("getPublicUrlDiagnostics reports explicit source and redacts bypass secret", () => {
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "super-secret";

  const diagnostics = getPublicUrlDiagnostics(
    "/api/channels/discord/webhook?foo=bar",
  );

  assert.deepEqual(diagnostics, {
    path: "/api/channels/discord/webhook?foo=bar",
    url: "https://openclaw.example.com/api/channels/discord/webhook?foo=bar&x-vercel-protection-bypass=%5Bredacted%5D",
    source: "NEXT_PUBLIC_APP_URL",
    authMode: "deployment-protection",
    bypassEnabled: true,
    bypassApplied: true,
  });

  const actualUrl = buildPublicUrl("/api/channels/discord/webhook?foo=bar");
  assert.equal(
    actualUrl,
    "https://openclaw.example.com/api/channels/discord/webhook?foo=bar&x-vercel-protection-bypass=super-secret",
  );
});

test("resolvePublicOrigin prefers forwarded headers when no explicit origin is configured", () => {
  const request = new Request("http://127.0.0.1:3000/api/status", {
    headers: {
      "x-forwarded-host": "preview-openclaw.vercel.app",
      "x-forwarded-proto": "https",
    },
  });

  const resolution = resolvePublicOrigin(request);

  assert.equal(resolution.source, "x-forwarded-host");
  assert.equal(resolution.origin, "https://preview-openclaw.vercel.app");
  assert.equal(resolution.requestHost, "preview-openclaw.vercel.app");
  assert.equal(resolution.requestProto, "https");
  assert.equal(resolution.bypassEnabled, false);
});

test("getPublicUrlDiagnostics falls back to Vercel system env without a Request", () => {
  process.env.VERCEL_URL = "branch-openclaw.vercel.app";

  const diagnostics = getPublicUrlDiagnostics("/api/channels/slack/webhook");

  assert.equal(diagnostics.source, "VERCEL_URL");
  assert.equal(
    diagnostics.url,
    "https://branch-openclaw.vercel.app/api/channels/slack/webhook",
  );
  assert.equal(diagnostics.authMode, "deployment-protection");
  assert.equal(diagnostics.bypassEnabled, false);
  assert.equal(diagnostics.bypassApplied, false);
});
