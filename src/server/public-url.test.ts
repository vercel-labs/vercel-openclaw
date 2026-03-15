import assert from "node:assert/strict";
import test from "node:test";

import { buildPublicUrl, getPublicOrigin } from "@/server/public-url";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("getPublicOrigin uses request headers when no override is set", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      const request = new Request("https://ignored.example/admin", {
        headers: {
          host: "openclaw.example.com",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(getPublicOrigin(request), "https://openclaw.example.com");
    },
  );
});

test("getPublicOrigin prefers NEXT_PUBLIC_APP_URL over request headers", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://custom.example.com",
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
    },
    () => {
      const request = new Request("https://ignored.example/admin", {
        headers: { host: "other.example.com" },
      });

      assert.equal(getPublicOrigin(request), "https://custom.example.com");
    },
  );
});

test("getPublicOrigin falls back to VERCEL_URL", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: "my-app-abc123.vercel.app",
    },
    () => {
      assert.equal(getPublicOrigin(), "https://my-app-abc123.vercel.app");
    },
  );
});

test("getPublicOrigin throws when no env vars and no request", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert.throws(() => getPublicOrigin(), /Unable to determine public origin/);
    },
  );
});

test("getPublicOrigin handles bare hostname in BASE_DOMAIN", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: "myapp.example.com",
    },
    () => {
      assert.equal(getPublicOrigin(), "https://myapp.example.com");
    },
  );
});

test("buildPublicUrl appends protection bypass secret in deployment-protection mode", () => {
  withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
    },
    () => {
      assert.equal(
        buildPublicUrl("/api/channels/slack/webhook"),
        "https://openclaw.example.com/api/channels/slack/webhook?x-vercel-protection-bypass=bypass-secret",
      );
    },
  );
});

test("buildPublicUrl leaves webhook URL unchanged in sign-in-with-vercel mode", () => {
  withEnv(
    {
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
    },
    () => {
      assert.equal(
        buildPublicUrl("/api/channels/telegram/webhook"),
        "https://openclaw.example.com/api/channels/telegram/webhook",
      );
    },
  );
});

test("buildPublicUrl does not append bypass when secret is missing", () => {
  withEnv(
    {
      VERCEL_AUTH_MODE: "deployment-protection",
      VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      NEXT_PUBLIC_APP_URL: "https://openclaw.example.com",
    },
    () => {
      assert.equal(
        buildPublicUrl("/api/channels/discord/webhook"),
        "https://openclaw.example.com/api/channels/discord/webhook",
      );
    },
  );
});

test("getPublicOrigin falls back to VERCEL_PROJECT_PRODUCTION_URL", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: "prod.example.com",
      VERCEL_BRANCH_URL: "branch.example.com",
      VERCEL_URL: "random.example.com",
    },
    () => {
      assert.equal(getPublicOrigin(), "https://prod.example.com");
    },
  );
});

test("getPublicOrigin falls back to x-forwarded-host header", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      const request = new Request("https://ignored.example.com/admin", {
        headers: {
          "x-forwarded-host": "preview.example.com",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(getPublicOrigin(request), "https://preview.example.com");
    },
  );
});
