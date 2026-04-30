import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { whatsappWebhookWorkflowRuntime } from "@/app/api/channels/whatsapp/webhook/route";
import { channelDedupKey } from "@/server/channels/keys";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { getStore } from "@/server/store/store";
import { FakeSandboxHandle } from "@/test-utils/fake-sandbox-controller";
import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { callRoute, buildPostRequest, resetAfterCallbacks } from "@/test-utils/route-caller";
import {
  buildWhatsAppVerificationRequest,
  buildWhatsAppWebhook,
} from "@/test-utils/webhook-builders";

const APP_SECRET = "test-whatsapp-app-secret";
const VERIFY_TOKEN = "test-whatsapp-verify-token";

let whatsappRouteModule:
  | typeof import("@/app/api/channels/whatsapp/webhook/route")
  | null = null;

function getWhatsAppWebhookRoute() {
  if (!whatsappRouteModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    whatsappRouteModule = require("@/app/api/channels/whatsapp/webhook/route") as typeof import("@/app/api/channels/whatsapp/webhook/route");
  }

  return whatsappRouteModule;
}

async function configureWhatsApp(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.whatsapp = {
      enabled: true,
      configuredAt: Date.now(),
      phoneNumberId: "123456789",
      accessToken: "wa-access-token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      businessAccountId: "waba-123",
      lastKnownLinkState: "linked",
    };
  });
}

test("WhatsApp webhook: GET verification returns challenge", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    const route = getWhatsAppWebhookRoute();
    const req = buildWhatsAppVerificationRequest(VERIFY_TOKEN, "challenge-123");
    const result = await callRoute(route.GET, req);

    assert.equal(result.status, 200);
    assert.equal(result.text, "challenge-123");
  });
});

test("WhatsApp webhook: invalid signature returns 401", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    const route = getWhatsAppWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/whatsapp/webhook",
      JSON.stringify({ object: "whatsapp_business_account" }),
      { "x-hub-signature-256": "sha256=bad" },
    );
    const result = await callRoute(route.POST, req);

    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { ok: false, error: "UNAUTHORIZED" });
  });
});

test("WhatsApp webhook: no config returns 404", async () => {
  await withHarness(async () => {
    const route = getWhatsAppWebhookRoute();
    const req = buildWhatsAppWebhook({ appSecret: APP_SECRET });
    const result = await callRoute(route.POST, req);

    assert.equal(result.status, 404);
    assert.deepEqual(result.json, { ok: false, error: "NOT_FOUND" });
  });
});

test("WhatsApp webhook: valid event enqueues work and returns 200", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    h.fakeFetch.onPost(/graph\.facebook\.com/, () =>
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.sent1" }],
      }),
    );

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildWhatsAppWebhook({ appSecret: APP_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1);
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: duplicate message id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    h.fakeFetch.onPost(/graph\.facebook\.com/, () =>
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.sent2" }],
      }),
    );

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.dedup1",
                    type: "text",
                    text: { body: "hello dedup" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    try {
      const req1 = buildWhatsAppWebhook({ appSecret: APP_SECRET, payload });
      const result1 = await callRoute(route.POST, req1);
      assert.equal(result1.status, 200);
      resetAfterCallbacks();

      const req2 = buildWhatsAppWebhook({ appSecret: APP_SECRET, payload });
      const result2 = await callRoute(route.POST, req2);
      assert.equal(result2.status, 200);
      assert.deepEqual(result2.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: fast path gateway response falls through to workflow", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-whatsapp-non-ok";
      meta.snapshotId = "snap-whatsapp-non-ok";
      meta.portUrls = {
        "3000": "https://sbx-whatsapp-non-ok-3000.fake.vercel.run",
      };
    });

    h.fakeFetch.onPost(/whatsapp-webhook$/, () =>
      new Response("bad gateway", { status: 502 }),
    );

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildWhatsAppWebhook({ appSecret: APP_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        1,
        "workflow must start when the native handler returned a gateway error so the event is not silently dropped",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: fast path refreshes AI Gateway token before native forward", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    _resetLogBuffer();
    _setAiGatewayTokenOverrideForTesting("fresh-whatsapp-fast-path-token");
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-whatsapp-token-refresh";
      meta.snapshotId = "snap-whatsapp-token-refresh";
      meta.portUrls = {
        "3000": "https://sbx-whatsapp-token-refresh-3000.fake.vercel.run",
      };
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 60;
      meta.lastTokenSource = "oidc";
    });
    await h.controller.get({ sandboxId: "sbx-whatsapp-token-refresh" });

    let networkPolicyCountAtForward = -1;
    h.fakeFetch.onPost(/whatsapp-webhook$/, () => {
      networkPolicyCountAtForward =
        h.controller.getHandle("sbx-whatsapp-token-refresh")?.networkPolicies.length ?? -1;
      return new Response("ok", { status: 200 });
    });

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildWhatsAppWebhook({ appSecret: APP_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(
        networkPolicyCountAtForward,
        1,
        "AI Gateway network policy must be refreshed before native WhatsApp forward",
      );
      assert.ok(
        getServerLogs().some((entry) => entry.message === "channels.fast_path_token_refresh"),
        "token refresh outcome should be logged for fast-path triage",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("WhatsApp webhook: fast path non-gateway response returns 200 without workflow", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-whatsapp-handler-error";
      meta.snapshotId = "snap-whatsapp-handler-error";
      meta.portUrls = {
        "3000": "https://sbx-whatsapp-handler-error-3000.fake.vercel.run",
      };
    });

    h.fakeFetch.onPost(/whatsapp-webhook$/, () =>
      new Response("handler rejected", { status: 500 }),
    );

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildWhatsAppWebhook({ appSecret: APP_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must not start when a non-gateway handler response means the payload reached the native handler",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: fast path connection failure sends boot message after reconciliation", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-whatsapp-stale-dead";
      meta.snapshotId = "snap-whatsapp-stale-dead";
    });
    // Pre-create the sandbox handle with "stopped" status so reconciliation
    // correctly transitions meta.status to "stopped"
    const handle = await h.controller.get({ sandboxId: "sbx-whatsapp-stale-dead" });
    (handle as FakeSandboxHandle).setStatus("stopped");

    h.fakeFetch.onPost(/graph\.facebook\.com/, () =>
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.boot1" }],
      }),
    );

    const route = getWhatsAppWebhookRoute();
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildWhatsAppWebhook({ appSecret: APP_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1);

      const graphCalls = h.fakeFetch
        .requests()
        .filter((entry) => entry.url.includes("graph.facebook.com"));
      assert.ok(
        graphCalls.length >= 1,
        "boot message should be sent after stale-running reconciliation",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: unexpected enqueue failure returns 500", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    const route = getWhatsAppWebhookRoute();
    const store = getStore();
    const acquireMock = mock.method(store, "acquireLock", async () => {
      throw new Error("store unavailable");
    });

    try {
      const req = buildWhatsAppWebhook({
        appSecret: APP_SECRET,
        payload: {
          object: "whatsapp_business_account",
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: "123456789" },
                    messages: [
                      {
                        from: "15551234567",
                        id: "wamid.unexpected-failure-1",
                        type: "text",
                        text: { body: "hello" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });
    } finally {
      acquireMock.mock.restore();
    }
  });
});

test("WhatsApp webhook: releases dedup lock and returns 500 when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureWhatsApp(h);
    h.fakeFetch.onPost(/graph\.facebook\.com/, () =>
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.sent3" }],
      }),
    );

    const route = getWhatsAppWebhookRoute();
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.fail1",
                    type: "text",
                    text: { body: "start fail" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const dedupKey = channelDedupKey("whatsapp", "wamid.fail1");
    const startMock = mock.method(whatsappWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildWhatsAppWebhook({ appSecret: APP_SECRET, payload });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken);
      await getStore().releaseLock(dedupKey, reacquiredToken!);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});
