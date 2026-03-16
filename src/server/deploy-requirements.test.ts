import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";

const ORIGINAL_ENV = { ...process.env };

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

afterEach(() => {
  resetEnv();
});

test("bypass is not required in sign-in-with-vercel mode", () => {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: false,
    reason: "sign-in-with-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook bypass is not required — the app handles auth via admin secret.",
  );
});

test("bypass is not required in admin-secret mode", () => {
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: false,
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook bypass is not required — the app handles auth via admin secret.",
  );
});

test("bypass is not required on Vercel in admin-secret mode", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: false,
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook bypass is not required — the app handles auth via admin secret.",
  );
});

test("bypass is not required but configured when secret is present", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "secret";

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: true,
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook URLs will include x-vercel-protection-bypass (opportunistic).",
  );
});
