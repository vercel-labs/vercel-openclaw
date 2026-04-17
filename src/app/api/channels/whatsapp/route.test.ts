/**
 * Tests for GET/PUT/DELETE /api/channels/whatsapp.
 *
 * Run: npm test src/app/api/channels/whatsapp/route.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { mutateMeta } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthGetRequest,
  buildAuthPutRequest,
  buildAuthDeleteRequest,
  callRoute,
  getWhatsAppChannelRoute,
} from "@/test-utils/route-caller";

const VALID_WHATSAPP_CONFIG = {
  enabled: true,
  phoneNumberId: "123456789",
  accessToken: "wa-access-token",
  verifyToken: "wa-verify-token",
  appSecret: "wa-app-secret",
};

async function withConnectableEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NEXT_PUBLIC_APP_URL",
    "REDIS_URL",
    "KV_URL",
    "VERCEL",
  ];
  const originals = new Map<string, string | undefined>();

  for (const key of keys) {
    originals.set(key, process.env[key]);
  }

  process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
  process.env.REDIS_URL = "redis://default:token@example.com:6379";
  process.env.VERCEL = "1";

  try {
    await fn();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

// ---------------------------------------------------------------------------
// GET — returns unconfigured state by default
// ---------------------------------------------------------------------------

test("whatsapp GET returns unconfigured public state", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const route = getWhatsAppChannelRoute();
    const request = buildAuthGetRequest("/api/channels/whatsapp");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      configured: boolean;
      mode: string;
      status: string;
      requiresRunningSandbox: boolean;
      loginVia: string;
      webhookUrl: string | null;
    };

    assert.equal(body.configured, false);
    assert.equal(body.mode, "webhook-proxied");
    assert.equal(body.status, "unconfigured");
    assert.equal(body.requiresRunningSandbox, false);
    assert.equal(body.loginVia, "/gateway/chat?session=main");
    assert.equal(body.webhookUrl, null);
  });
});

// ---------------------------------------------------------------------------
// PUT — config-only, no bot token required
// ---------------------------------------------------------------------------

test("whatsapp PUT enables with config-only body", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          enabled: true,
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
          dmPolicy: "pairing",
        }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        configured: boolean;
        mode: string;
        requiresRunningSandbox: boolean;
        webhookUrl: string | null;
      };

      assert.equal(body.configured, true);
      assert.equal(body.mode, "webhook-proxied");
      assert.equal(body.requiresRunningSandbox, false);
      assert.equal(
        body.webhookUrl,
        "https://openclaw.example/api/channels/whatsapp/webhook",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE — removes config
// ---------------------------------------------------------------------------

test("whatsapp DELETE removes config", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();

      const putRequest = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify(VALID_WHATSAPP_CONFIG),
      );
      await callRoute(route.PUT!, putRequest);

      const deleteRequest = buildAuthDeleteRequest(
        "/api/channels/whatsapp",
        "{}",
      );
      const result = await callRoute(route.DELETE!, deleteRequest);

      assert.equal(result.status, 200);
      const body = result.json as { configured: boolean; status: string };
      assert.equal(body.configured, false);
      assert.equal(body.status, "unconfigured");
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — config merge preserves auth state fields
// ---------------------------------------------------------------------------

test("whatsapp PUT preserves auth state fields across config updates", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      await mutateMeta((meta) => {
        meta.channels.whatsapp = {
          enabled: true,
          configuredAt: 1000,
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
          lastKnownLinkState: "linked",
          linkedPhone: "+1234567890",
          displayName: "My Phone",
          lastError: undefined,
          dmPolicy: "pairing",
        };
      });

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
          dmPolicy: "allowlist",
          allowFrom: ["+9876543210"],
        }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        configured: boolean;
        status: string;
        displayName: string | null;
        linkedPhone: string | null;
      };

      assert.equal(body.configured, true);
      assert.equal(body.status, "linked", "lastKnownLinkState must be preserved");
      assert.equal(body.displayName, "My Phone", "displayName must be preserved");
      assert.equal(body.linkedPhone, "+1234567890", "linkedPhone must be preserved");
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — response never contains a webhook URL
// ---------------------------------------------------------------------------

test("whatsapp PUT response includes webhookUrl", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          enabled: true,
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
        }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 200);
      const body = result.json as Record<string, unknown>;
      assert.equal(
        body.webhookUrl,
        "https://openclaw.example/api/channels/whatsapp/webhook",
      );
      assert.equal(body.mode, "webhook-proxied");
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — configuredAt is preserved across updates
// ---------------------------------------------------------------------------

test("whatsapp PUT preserves original configuredAt timestamp", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();

      const firstPut = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          enabled: true,
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
        }),
      );
      const firstResult = await callRoute(route.PUT!, firstPut);
      const firstBody = firstResult.json as { configuredAt: number };
      const originalTimestamp = firstBody.configuredAt;
      assert.ok(originalTimestamp > 0);

      const secondPut = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          phoneNumberId: "123456789",
          accessToken: "wa-access-token",
          verifyToken: "wa-verify-token",
          appSecret: "wa-app-secret",
          dmPolicy: "open",
        }),
      );
      const secondResult = await callRoute(route.PUT!, secondPut);
      const secondBody = secondResult.json as { configuredAt: number };
      assert.equal(secondBody.configuredAt, originalTimestamp, "configuredAt must not change on update");
    });
  });
});

// ---------------------------------------------------------------------------
// Guardrail: no fake webhook path for WhatsApp
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET — detailed endpoint exposes link-state that summary omits
// ---------------------------------------------------------------------------

test("whatsapp GET returns needs-login status verbatim when configured", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      await mutateMeta((meta) => {
        meta.channels.whatsapp = {
          ...VALID_WHATSAPP_CONFIG,
          configuredAt: Date.now(),
          lastKnownLinkState: "needs-login",
          lastError: "scan QR to continue",
        };
      });

      const route = getWhatsAppChannelRoute();
      const request = buildAuthGetRequest("/api/channels/whatsapp");
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        configured: boolean;
        status: string;
        lastError: string | null;
        mode: string;
        requiresRunningSandbox: boolean;
        webhookUrl: string | null;
      };

      // Detailed endpoint preserves the exact link state — not a coarse boolean.
      assert.equal(body.configured, true);
      assert.equal(body.status, "needs-login");
      assert.equal(body.lastError, "scan QR to continue");
      assert.equal(body.mode, "webhook-proxied");
      assert.equal(body.requiresRunningSandbox, false);
      assert.equal(
        body.webhookUrl,
        "https://openclaw.example/api/channels/whatsapp/webhook",
      );
    });
  });
});

test("whatsapp GET returns error status with lastError detail", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        ...VALID_WHATSAPP_CONFIG,
        configuredAt: Date.now(),
        lastKnownLinkState: "error",
        lastError: "connection timeout",
      };
    });

    const route = getWhatsAppChannelRoute();
    const request = buildAuthGetRequest("/api/channels/whatsapp");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      configured: boolean;
      status: string;
      lastError: string | null;
    };

    // Detailed endpoint returns "error" — summary would still say connected: true.
    assert.equal(body.configured, true);
    assert.equal(body.status, "error");
    assert.equal(body.lastError, "connection timeout");
  });
});

test("whatsapp GET returns disconnected status when link was lost", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        ...VALID_WHATSAPP_CONFIG,
        configuredAt: Date.now(),
        lastKnownLinkState: "disconnected",
        linkedPhone: "+1234567890",
        lastError: "session expired",
      };
    });

    const route = getWhatsAppChannelRoute();
    const request = buildAuthGetRequest("/api/channels/whatsapp");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      configured: boolean;
      status: string;
      linkedPhone: string | null;
      lastError: string | null;
    };

    assert.equal(body.configured, true);
    assert.equal(body.status, "disconnected");
    assert.equal(body.linkedPhone, "+1234567890");
    assert.equal(body.lastError, "session expired");
  });
});

test("whatsapp GET returns needs-plugin status verbatim", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        ...VALID_WHATSAPP_CONFIG,
        configuredAt: Date.now(),
        lastKnownLinkState: "needs-plugin",
      };
    });

    const route = getWhatsAppChannelRoute();
    const request = buildAuthGetRequest("/api/channels/whatsapp");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      configured: boolean;
      status: string;
      lastError: string | null;
    };

    assert.equal(body.configured, true);
    assert.equal(body.status, "needs-plugin");
    assert.equal(body.lastError, null);
  });
});

// ---------------------------------------------------------------------------
// Guardrail: no fake webhook path for WhatsApp
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PUT — validation: rejects invalid dmPolicy
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects invalid dmPolicy with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, dmPolicy: "bogus" }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_DMPOLICY/);
      assert.match(bodyText, /pairing, allowlist, open, disabled/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects invalid groupPolicy
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects invalid groupPolicy with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, groupPolicy: "nope" }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_GROUPPOLICY/);
      assert.match(bodyText, /open, allowlist, disabled/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects malformed allowFrom
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects invalid allowFrom arrays with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, allowFrom: ["+15551234567", 123] }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_ALLOWFROM/);
      assert.match(bodyText, /array of non-empty strings/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects non-array allowFrom
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects non-array allowFrom with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, allowFrom: "not-an-array" }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_ALLOWFROM/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects non-boolean enabled
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects non-boolean enabled with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, enabled: "yes" }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_ENABLED/);
      assert.match(bodyText, /boolean/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects non-object JSON bodies
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects non-object JSON bodies with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        "null",
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_JSON/);
      assert.match(bodyText, /JSON object/);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT — validation: rejects malformed groupAllowFrom
// ---------------------------------------------------------------------------

test("whatsapp PUT rejects malformed groupAllowFrom with actionable 400", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({ ...VALID_WHATSAPP_CONFIG, groupAllowFrom: [null] }),
      );
      const result = await callRoute(route.PUT!, request);

      assert.equal(result.status, 400);
      const bodyText = JSON.stringify(result.json);
      assert.match(bodyText, /INVALID_GROUPALLOWFROM/);
    });
  });
});

// ---------------------------------------------------------------------------
// Guardrail: no fake webhook path for WhatsApp
// ---------------------------------------------------------------------------

test("whatsapp connectability in GET response includes webhookUrl", async () => {
  await withConnectableEnv(async () => {
    await withHarness(async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-token");

      const route = getWhatsAppChannelRoute();
      const request = buildAuthGetRequest("/api/channels/whatsapp");
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        connectability: { webhookUrl: string | null; mode: string };
      };
      assert.equal(
        body.connectability.webhookUrl,
        "https://openclaw.example/api/channels/whatsapp/webhook",
      );
      assert.equal(body.connectability.mode, "webhook-proxied");
    });
  });
});
