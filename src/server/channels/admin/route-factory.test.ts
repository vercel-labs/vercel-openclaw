import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { withHarness } from "@/test-utils/harness";
import { buildAuthPutRequest, callRoute } from "@/test-utils/route-caller";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  }
});

// ---------------------------------------------------------------------------
// Route-factory regression: blocked connectability returns 409 with zero
// channel-side effects. The PUT handler must return before spec.put() and
// before any post-mutation state reads/writes.
// ---------------------------------------------------------------------------

test("PUT handler returns 409 when connectability blocks — spec.put and spec.delete are never called", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    // Ensure no public origin is configured so localhost fails the check
    delete process.env.NEXT_PUBLIC_APP_URL;

    let putCalls = 0;
    let deleteCalls = 0;
    let selectStateCalls = 0;

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => {
        selectStateCalls++;
        return s.slack;
      },
      async put() {
        putCalls++;
      },
      async delete() {
        deleteCalls++;
      },
    });

    // localhost origin → connectability returns canConnect:false → 409
    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "slack");
    assert.equal(body.connectability.canConnect, false);

    // Zero side effects: no spec methods called after the connectability guard
    assert.equal(putCalls, 0, "spec.put must not be called when blocked");
    assert.equal(deleteCalls, 0, "spec.delete must not be called when blocked");
    assert.equal(selectStateCalls, 0, "selectState (post-mutation read) must not be called when blocked");
  });
});

// ---------------------------------------------------------------------------
// Route-factory regression: exceptions inside the try block are caught
// by authJsonError and returned as a structured JSON error envelope.
//
// The PUT handler's try block covers: buildChannelConnectability,
// getInitializedMeta, spec.put, and getPublicChannelState. Proving
// that a thrown error is caught proves that connectability exceptions
// (which execute in the same block) cannot escape the handler.
// ---------------------------------------------------------------------------

test("PUT handler wraps thrown errors in JSON error envelope (authJsonError)", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {
        throw new Error("simulated failure inside try block");
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 500);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "INTERNAL_ERROR");
    assert.equal(typeof body.message, "string");
  });
});

test("PUT handler wraps ApiError with correct status code", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { ApiError } = await import("@/shared/http");

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {
        throw new ApiError(400, "BAD_INPUT", "invalid field");
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "BAD_INPUT");
    assert.equal(body.message, "invalid field");
  });
});
