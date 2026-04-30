/**
 * L4-host scenario 5: fast-path stale-running fallback.
 *
 * When meta says `status: running` + `sandboxId` is set but the sandbox is
 * actually dead (auto-stopped, snapshotted, or wedged), a Slack `app_mention`
 * must NOT be silently dropped. The webhook fast-path tries the in-band
 * forward to `<sandboxUrl>/slack/events`; on 5xx or network failure it must
 * call `reconcileStaleRunningStatus()` and fall through to the durable
 * workflow wake path so the user still gets a reply.
 *
 * Two scenarios cover the two failure modes the route distinguishes:
 *
 *   - Gateway-error fallback: forward returns 502.
 *   - Network-error fallback: forward throws (TimeoutError or fetch reject).
 *
 * Both must end with: response 200, workflow.start called exactly once,
 * fast-path forward attempted exactly once.
 *
 * Catches: stale `running` metadata silently dropping events when the
 * sandbox has gone away under us.
 *
 * Run: npm test src/test-utils/host-smoke/l4-host-fast-path-stale.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { callRoute, getSlackWebhookRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import { slackWebhookWorkflowRuntime } from "@/app/api/channels/slack/webhook/route";
import {
  buildSignedSlackRequest,
  buildSlackAppMentionPayload,
} from "@/test-utils/host-smoke/slack-events";
import { slackOkResponse } from "@/test-utils/fake-fetch";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-l4-stale";
const CHANNEL_ID = "C0L4STALE";
const SANDBOX_ID = "sbx-l4-stale-running";
const SANDBOX_URL_3000 = `https://${SANDBOX_ID}-3000.fake.vercel.run`;

async function configureRunningSandboxWithSlack(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SLACK_SIGNING_SECRET,
      botToken: "xoxb-l4-stale-bot-token",
      configuredAt: Date.now(),
    };
    meta.status = "running";
    meta.sandboxId = SANDBOX_ID;
    meta.portUrls = { "3000": SANDBOX_URL_3000 };
  });
}

function fastPathForwardAttempts(h: ScenarioHarness): number {
  return h.fakeFetch
    .requests()
    .filter(
      (r) =>
        r.method.toUpperCase() === "POST" &&
        r.url.startsWith(SANDBOX_URL_3000) &&
        r.url.endsWith("/slack/events"),
    ).length;
}

test("L4-host fast-path stale: 502 from forward triggers fallback to workflow", async () => {
  await withHarness(async (h) => {
    await configureRunningSandboxWithSlack(h);

    h.fakeFetch.onPost(/\/slack\/events$/, () => new Response("bad gateway", { status: 502 }));
    // Boot message + any other Slack outbound during fallback.
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: buildSlackAppMentionPayload({ channelId: CHANNEL_ID }),
      });
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200, "stale fast-path must not surface its 502 to Slack");
      assert.equal(
        fastPathForwardAttempts(h),
        1,
        "fast-path must be attempted exactly once before fallback",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "5xx fast-path must fall through to durable workflow",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("L4-host fast-path stale: network error from forward triggers fallback to workflow", async () => {
  await withHarness(async (h) => {
    await configureRunningSandboxWithSlack(h);

    h.fakeFetch.onPost(/\/slack\/events$/, () => {
      throw new Error("ECONNREFUSED simulated for stale sandbox");
    });
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: buildSlackAppMentionPayload({ channelId: CHANNEL_ID }),
      });
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200, "network failure must not surface to Slack");
      assert.equal(
        fastPathForwardAttempts(h),
        1,
        "fast-path must be attempted exactly once",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "network-error fast-path must fall through to durable workflow",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});
