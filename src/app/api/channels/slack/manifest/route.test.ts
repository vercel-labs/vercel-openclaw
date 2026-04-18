/**
 * Tests for GET /api/channels/slack/manifest.
 *
 * Covers: auth enforcement in sign-in-with-vercel mode (401 without session),
 * happy path with host header, and happy path with NEXT_PUBLIC_BASE_DOMAIN env.
 *
 * Run: npm test src/app/api/channels/slack/manifest/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildGetRequest,
  buildAuthGetRequest,
  getSlackManifestRoute,
} from "@/test-utils/route-caller";

function withProjectIdentity<T>(
  scope: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prevScope = process.env.VCLAW_PROJECT_SCOPE;
  const prevName = process.env.VCLAW_PROJECT_NAME;
  process.env.VCLAW_PROJECT_SCOPE = scope;
  process.env.VCLAW_PROJECT_NAME = name;
  return Promise.resolve(fn()).finally(() => {
    if (prevScope === undefined) delete process.env.VCLAW_PROJECT_SCOPE;
    else process.env.VCLAW_PROJECT_SCOPE = prevScope;
    if (prevName === undefined) delete process.env.VCLAW_PROJECT_NAME;
    else process.env.VCLAW_PROJECT_NAME = prevName;
  });
}

// ===========================================================================
// Auth enforcement (sign-in-with-vercel mode)
// ===========================================================================

test("Slack manifest: GET without session in sign-in-with-vercel mode returns 401", async () => {
  await withHarness(async () => {
    const route = getSlackManifestRoute();
    const req = buildGetRequest("/api/channels/slack/manifest");
    const result = await callRoute(route.GET!, req);
    assert.equal(result.status, 401);
  }, { authMode: "sign-in-with-vercel" });
});

// ===========================================================================
// Happy path (admin-secret mode — no auth needed)
// ===========================================================================

test("Slack manifest: GET returns manifest scoped to the owning Vercel project", async () => {
  await withHarness(async () => {
    await withProjectIdentity("vercel-labs", "my-bot", async () => {
      const route = getSlackManifestRoute();
      const req = buildAuthGetRequest("/api/channels/slack/manifest");
      const result = await callRoute(route.GET!, req);

      assert.equal(result.status, 200);
      const body = result.json as {
        manifest: {
          display_information: { name: string; description: string };
          oauth_config: { scopes: { bot: string[] } };
          features: {
            bot_user: { display_name: string };
            slash_commands: Array<{ command: string; description: string }>;
          };
          settings: {
            event_subscriptions: { request_url: string; bot_events: string[] };
          };
        };
        createAppUrl: string;
      };

      assert.equal(body.manifest.display_information.name, "my-bot (vercel-labs)");
      assert.ok(
        body.manifest.display_information.description.length <= 140,
        "description must stay within Slack's 140-char cap",
      );
      assert.ok(
        body.manifest.display_information.description.includes(
          "scope=vercel-labs project=my-bot",
        ),
        "description must carry full scope+project for reverse lookup",
      );
      assert.equal(
        body.manifest.features.bot_user.display_name,
        "my-bot.vercel-labs",
      );
      assert.match(
        body.manifest.features.bot_user.display_name,
        /^[a-z0-9._-]+$/,
        "bot_user.display_name must satisfy Slack's [a-z0-9-_.] rule",
      );
      assert.equal(
        body.manifest.features.slash_commands[0].command,
        "/vercel-labs-my-bot",
      );
      assert.ok(body.manifest.oauth_config.scopes.bot.includes("chat:write"));
      assert.ok(
        body.manifest.settings.event_subscriptions.bot_events.includes(
          "message.im",
        ),
      );
      assert.ok(
        body.manifest.settings.event_subscriptions.request_url.includes(
          "/api/channels/slack/webhook",
        ),
      );
      assert.ok(body.createAppUrl.startsWith("https://api.slack.com/apps"));
    });
  });
});

test("Slack manifest: slash command stays ≤ 32 chars when scope+name are long", async () => {
  await withHarness(async () => {
    await withProjectIdentity(
      "some-really-long-org-slug",
      "a-very-very-long-project-name-indeed",
      async () => {
        const route = getSlackManifestRoute();
        const req = buildAuthGetRequest("/api/channels/slack/manifest");
        const result = await callRoute(route.GET!, req);

        assert.equal(result.status, 200);
        const body = result.json as {
          manifest: {
            features: { slash_commands: Array<{ command: string }> };
            display_information: { description: string };
          };
        };

        const command = body.manifest.features.slash_commands[0].command;
        assert.ok(command.startsWith("/"), "slash command must start with /");
        assert.ok(
          command.length <= 32,
          `slash command "${command}" (${command.length} chars) exceeds Slack's 32-char cap`,
        );
        // Full identity stays reachable via the description regardless of truncation.
        assert.ok(
          body.manifest.display_information.description.includes(
            "scope=some-really-long-org-slug project=a-very-very-long-project-name-indeed",
          ),
        );
      },
    );
  });
});

test("Slack manifest: display name never cuts mid-parens when scope is too long", async () => {
  // Repro of the production bug: "vercel-openclaw-3 (vercel-internal-"
  await withHarness(async () => {
    await withProjectIdentity(
      "vercel-internal-playground",
      "vercel-openclaw-3",
      async () => {
        const route = getSlackManifestRoute();
        const req = buildAuthGetRequest("/api/channels/slack/manifest");
        const result = await callRoute(route.GET!, req);

        assert.equal(result.status, 200);
        const body = result.json as {
          manifest: { display_information: { name: string } };
        };
        const name = body.manifest.display_information.name;
        assert.ok(
          name.length <= 35,
          `display_information.name "${name}" exceeds Slack's 35-char cap`,
        );
        assert.ok(
          !name.includes("(") || name.includes(")"),
          `display_information.name "${name}" was truncated mid-parens`,
        );
        assert.equal(name, "vercel-openclaw-3");
      },
    );
  });
});

test("Slack manifest: uses NEXT_PUBLIC_BASE_DOMAIN when set", async () => {
  await withHarness(async () => {
    await withProjectIdentity("vercel-labs", "my-bot", async () => {
      process.env.NEXT_PUBLIC_BASE_DOMAIN = "custom.example.com";
      try {
        const route = getSlackManifestRoute();
        const req = buildAuthGetRequest("/api/channels/slack/manifest");
        const result = await callRoute(route.GET!, req);

        assert.equal(result.status, 200);
        const body = result.json as {
          manifest: { settings: { event_subscriptions: { request_url: string } } };
        };
        assert.ok(
          body.manifest.settings.event_subscriptions.request_url.includes(
            "custom.example.com",
          ),
        );
      } finally {
        delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
      }
    });
  });
});
