/**
 * Smoke tests for GET /api/channels/summary.
 *
 * Covers auth-gated channel summary with queue depth and failed counts.
 *
 * Run: npm test src/app/api/channels/summary/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelSummaryResponse } from "@/shared/channel-summary";
import { createUnknownUserVisibleReply } from "@/shared/channels";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  buildGetRequest,
  getChannelsSummaryRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "REDIS_URL",
    "KV_URL",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
  }
}

// ===========================================================================
// GET /api/channels/summary
// ===========================================================================

test("GET /api/channels/summary: returns summary for all channels including whatsapp", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    // All channels disconnected by default
    assert.equal(body.slack.connected, false);
    assert.equal(body.slack.configured, false);
    assert.equal(body.telegram.connected, false);
    assert.equal(body.telegram.configured, false);
    assert.equal(body.discord.connected, false);
    assert.equal(body.discord.configured, false);
    assert.equal(body.whatsapp.connected, false);
    assert.equal(body.whatsapp.configured, false);
    assert.equal(body.whatsapp.linkState, "unconfigured");
    assert.equal(body.whatsapp.deliveryMode, "webhook-proxied");
    assert.equal(body.whatsapp.requiresRunningSandbox, false);
    assert.equal(body.whatsapp.connectionSemantics, "delivery-enabled");
    assert.equal(body.whatsapp.detailRoute, "/api/channels/whatsapp");
    assert.equal(body.slack.lastDeliveryState, null);
    assert.equal(body.telegram.lastDeliveryState, null);
    assert.equal(body.discord.lastDeliveryState, null);
    assert.equal(body.whatsapp.lastDeliveryState, null);
  });
});

test("GET /api/channels/summary: reflects connected channel state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        team: "Test Team",
        user: "U123",
        botId: "B123",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.connected, true);
    assert.equal(body.slack.configured, true);
    assert.equal(body.slack.lastError, null);
    assert.equal(body.telegram.connected, false);
    assert.equal(body.telegram.configured, false);
    assert.equal(body.discord.connected, false);
    assert.equal(body.discord.configured, false);
  });
});

test("GET /api/channels/summary: Slack credentials are not delivery-ready until live config sync is fresh", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        liveConfigSync: {
          outcome: "failed",
          reason: "Slack route did not become ready after config sync restart",
          liveConfigFresh: false,
          operatorMessage: "Config sync failed. The sandbox may be serving stale configuration.",
          checkedAt: 123456,
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.connected, true, "legacy connected still means credentials exist");
    assert.equal(body.slack.configured, true);
    assert.equal(body.slack.deliveryReady, false);
    assert.equal(body.slack.routeReady, false);
    assert.equal(body.slack.liveConfigFresh, false);
    assert.equal(body.slack.readiness.configSyncOutcome, "failed");
    assert.equal(body.slack.readiness.reason, "Slack route did not become ready after config sync restart");
    assert.equal(body.slack.readiness.checkedAt, 123456);
    assert.equal(body.slack.readiness.sandboxPath, "/slack/events");
  });
});

test("GET /api/channels/summary: Slack deliveryReady follows successful live config sync", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        liveConfigSync: {
          outcome: "applied",
          reason: "config_written_and_restarted",
          liveConfigFresh: true,
          operatorMessage: null,
          checkedAt: 123789,
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.connected, true);
    assert.equal(body.slack.configured, true);
    assert.equal(body.slack.deliveryReady, true);
    assert.equal(body.slack.routeReady, true);
    assert.equal(body.slack.liveConfigFresh, true);
    assert.equal(body.slack.readiness.configSyncOutcome, "applied");
  });
});

test("GET /api/channels/summary: whatsapp connected reflects enabled config", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "linked",
        linkedPhone: "+1234567890",
        dmPolicy: "pairing",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.configured, true);
    assert.equal(body.whatsapp.linkState, "linked");
    assert.equal(body.whatsapp.deliveryMode, "webhook-proxied");
    assert.equal(body.whatsapp.requiresRunningSandbox, false);
    assert.equal(body.whatsapp.lastError, null);
    assert.equal(body.whatsapp.connectionSemantics, "delivery-enabled");
    assert.equal(body.whatsapp.detailRoute, "/api/channels/whatsapp");
  });
});

test("GET /api/channels/summary: whatsapp response has no webhookUrl field", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as Record<string, Record<string, unknown>>;
    assert.equal(
      "webhookUrl" in body.whatsapp,
      false,
      "whatsapp summary must not contain webhookUrl",
    );
  });
});

test("GET /api/channels/summary: whatsapp disabled config reports configured false but preserves linkState", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: false,
        configuredAt: Date.now(),
        lastKnownLinkState: "linked",
        linkedPhone: "+1234567890",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.whatsapp.connected, false);
    assert.equal(body.whatsapp.configured, false);
    assert.equal(body.whatsapp.linkState, "linked");
    assert.equal(body.whatsapp.lastError, null);
    assert.equal(body.whatsapp.connectionSemantics, "delivery-enabled");
    assert.equal(body.whatsapp.detailRoute, "/api/channels/whatsapp");
    assert.equal(body.whatsapp.deliveryMode, "webhook-proxied");
    assert.equal(body.whatsapp.requiresRunningSandbox, false);
  });
});

test("GET /api/channels/summary: whatsapp needs-login exposes coarse and detailed state together", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "needs-login",
        lastError: "scan QR to continue",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.configured, true);
    assert.equal(body.whatsapp.linkState, "needs-login");
    assert.equal(body.whatsapp.lastError, "scan QR to continue");
    assert.equal(body.whatsapp.connectionSemantics, "delivery-enabled");
    assert.equal(body.whatsapp.detailRoute, "/api/channels/whatsapp");
  });
});

test("GET /api/channels/summary: whatsapp error exposes linkState and lastError", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "error",
        lastError: "connection timeout",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.configured, true);
    assert.equal(body.whatsapp.linkState, "error");
    assert.equal(body.whatsapp.lastError, "connection timeout");
    assert.equal(body.whatsapp.detailRoute, "/api/channels/whatsapp");
  });
});

test("GET /api/channels/summary: native accepted Slack forward keeps user-visible reply unknown", async () => {
  await withTestEnv(async () => {
    const completedAt = Date.now() - 1_000;
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        liveConfigSync: {
          outcome: "failed",
          reason: "stale-config-sync",
          liveConfigFresh: false,
          checkedAt: completedAt - 1_000,
        },
      };
      meta.channelDiagnostics = {
        slack: {
          lastForward: {
            ok: true,
            status: 200,
            classification: "accepted",
            attempts: 1,
            totalMs: 42,
            transport: "public",
            sandboxUrl: "https://sandbox.example.com",
            sandboxId: "sbx-test",
            finalReasonHead: null,
            startedAt: completedAt - 100,
            completedAt,
            deliveryId: "delivery-1",
            userVisibleReply: createUnknownUserVisibleReply(completedAt),
          },
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.deliveryReady, true, "existing native readiness behavior remains unchanged");
    assert.equal(body.slack.lastForward?.classification, "accepted");
    assert.equal(body.slack.lastDeliveryState?.state, "visibility-unknown");
    assert.equal(body.slack.lastDeliveryState?.source, "legacy-projection");
    assert.equal(body.slack.lastForward?.userVisibleReply.status, "unknown");
    assert.equal(body.slack.userVisibleReply?.status, "unknown");
    assert.equal(body.slack.readiness.userVisibleReply?.status, "unknown");
    assert.equal(body.slack.readiness.lastDeliveryState?.state, "visibility-unknown");
    assert.equal(body.slack.readiness.userVisibleReplyVerified, false);
  });
});

test("GET /api/channels/summary: stale broken Slack forward does not override fresh config sync", async () => {
  await withTestEnv(async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: now,
        liveConfigSync: {
          outcome: "applied",
          reason: "config-sync-ok",
          liveConfigFresh: true,
          checkedAt: now - 1_000,
        },
      };
      meta.channelDiagnostics = {
        slack: {
          lastForward: {
            ok: false,
            status: 502,
            classification: "sandbox-not-listening",
            attempts: 1,
            totalMs: 42,
            transport: "public",
            sandboxUrl: "https://sandbox.example.com",
            sandboxId: "sbx-test",
            finalReasonHead: "This sandbox is not listening",
            startedAt: now - 10 * 60 * 1000 - 100,
            completedAt: now - 10 * 60 * 1000,
            deliveryId: "delivery-old",
            userVisibleReply: createUnknownUserVisibleReply(now - 10 * 60 * 1000),
          },
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.deliveryReady, true);
    assert.equal(body.slack.readiness.reason, "config-sync-ok");
  });
});

test("GET /api/channels/summary: legacy lastDeliveryState age follows lastForward age", async () => {
  await withTestEnv(async () => {
    const now = Date.now();
    const completedAt = now - 20_000;
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: now,
      };
      meta.channelDiagnostics = {
        slack: {
          lastForward: {
            ok: true,
            status: 200,
            classification: "accepted",
            attempts: 1,
            totalMs: 42,
            transport: "public",
            sandboxUrl: "https://sandbox.example.com",
            sandboxId: "sbx-test",
            finalReasonHead: null,
            startedAt: completedAt - 100,
            completedAt,
            deliveryId: "delivery-legacy",
            userVisibleReply: createUnknownUserVisibleReply(completedAt),
          },
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.ok(body.slack.lastDeliveryState);
    assert.ok(body.slack.lastDeliveryState.ageMs >= 19_000);
  });
});

test("GET /api/channels/summary: observed user-visible reply projects as verified", async () => {
  await withTestEnv(async () => {
    const checkedAt = Date.now() - 500;
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
      };
      meta.channelDiagnostics = {
        slack: {
          lastForward: {
            ok: true,
            status: 200,
            classification: "accepted",
            attempts: 1,
            totalMs: 42,
            transport: "public",
            sandboxUrl: "https://sandbox.example.com",
            sandboxId: "sbx-test",
            finalReasonHead: null,
            startedAt: checkedAt - 100,
            completedAt: checkedAt,
            deliveryId: "delivery-1",
            userVisibleReply: {
              status: "observed",
              checkedAt,
              observedAt: checkedAt,
              timeoutMs: null,
              source: "manual",
              reason: "operator-confirmed",
              evidence: null,
            },
          },
        },
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as ChannelSummaryResponse;

    assert.equal(body.slack.lastForward?.userVisibleReply.status, "observed");
    assert.equal(body.slack.lastDeliveryState?.state, "reply-observed");
    assert.equal(body.slack.userVisibleReply?.status, "observed");
    assert.equal(body.slack.readiness.userVisibleReplyVerified, true);
  });
});

test("GET /api/channels/summary: works without CSRF headers when bearer token is present", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildGetRequest("/api/channels/summary", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.GET!, request);

    // Bearer token provides auth; CSRF headers not needed for GET
    assert.equal(result.status, 200);
  });
});
