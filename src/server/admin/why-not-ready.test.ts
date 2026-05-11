import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildWhyNotReady } from "@/server/admin/why-not-ready";
import { createDefaultMeta, type SingleMeta } from "@/shared/types";
import {
  createUnknownUserVisibleReply,
  type ChannelLastForward,
} from "@/shared/channels";

function metaFixture(): SingleMeta {
  return createDefaultMeta(1_000_000, "test-token", "test-instance");
}

function slackForward(
  overrides: Partial<ChannelLastForward> = {},
): ChannelLastForward {
  return {
    ok: true,
    status: 200,
    classification: "accepted",
    attempts: 1,
    totalMs: 50,
    transport: "public",
    sandboxUrl: "https://sb-test.vercel.run",
    sandboxId: "sb-test",
    finalReasonHead: null,
    startedAt: Date.now() - 1000,
    completedAt: Date.now() - 500,
    deliveryId: "delivery-1",
    userVisibleReply: createUnknownUserVisibleReply(Date.now() - 500),
    ...overrides,
  };
}

describe("buildWhyNotReady", () => {
  test("flags slack with no credentials as not ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = null;

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, false);
    const kinds = report.channels.slack.blockers.map((b) => b.kind);
    assert.ok(
      kinds.includes("no_credentials"),
      `expected no_credentials blocker, got ${kinds.join(",")}`,
    );
  });

  test("slack with creds and recent ok forward is ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: { lastForward: slackForward() },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.deepEqual(report.channels.slack.blockers, []);
    assert.equal(
      report.channels.slack.observabilityGaps[0]?.kind,
      "user_visible_reply_unknown",
    );
    assert.equal(
      report.channels.slack.readinessSnapshot.userVisibleReply,
      report.channels.slack.observabilityGaps[0]?.evidence.userVisibleReply,
    );
  });

  test("observed user-visible reply clears native-acceptance observability gap", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          userVisibleReply: {
            status: "observed",
            checkedAt: Date.now() - 400,
            observedAt: Date.now() - 400,
            timeoutMs: null,
            source: "manual",
            reason: "operator-confirmed",
            evidence: null,
          },
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.deepEqual(report.channels.slack.observabilityGaps, []);
  });

  test("timed-out user-visible reply adds observability gap without changing ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          userVisibleReply: {
            status: "timed-out",
            checkedAt: Date.now() - 400,
            observedAt: null,
            timeoutMs: 30_000,
            source: "synthetic-canary",
            reason: "deadline-expired",
            evidence: null,
          },
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.equal(
      report.channels.slack.observabilityGaps[0]?.kind,
      "user_visible_reply_timed_out",
    );
  });

  test("slack lastForward sandbox-not-listening yields blocker with sandboxUrl", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          ok: false,
          status: 502,
          classification: "sandbox-not-listening",
          sandboxUrl: "https://sb-stale.vercel.run",
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, false);
    const blocker = report.channels.slack.blockers.find(
      (b) => b.kind === "sandbox_not_listening",
    );
    assert.ok(blocker, "expected sandbox_not_listening blocker");
    assert.equal(blocker.evidence.sandboxUrl, "https://sb-stale.vercel.run");
  });

  test("telegram expected listener without ready proof yields handler blocker", async () => {
    const meta = metaFixture();
    meta.status = "running";
    meta.sandboxId = "sbx-telegram";
    meta.channels.telegram = {
      botToken: "tg-token",
      webhookSecret: "tg-secret",
      webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
    meta.lastRestoreMetrics = {
      sandboxCreateMs: 0,
      tokenWriteMs: 0,
      assetSyncMs: 0,
      startupScriptMs: 0,
      forcePairMs: 0,
      firewallSyncMs: 0,
      localReadyMs: 0,
      publicReadyMs: 0,
      totalMs: 0,
      skippedStaticAssetSync: true,
      assetSha256: null,
      vcpus: 0,
      recordedAt: Date.now() - 1_000,
      telegramExpected: true,
      telegramConfigPresent: true,
      telegramListenerReady: false,
      telegramListenerStatus: 0,
      telegramListenerError: "connection refused",
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.telegram.ready, false);
    const blocker = report.channels.telegram.blockers.find(
      (b) => b.kind === "handler_not_ready",
    );
    assert.ok(blocker, "expected handler_not_ready blocker");
    assert.equal(blocker.evidence.sandboxPort, 8787);
    assert.equal(blocker.evidence.telegramListenerReady, false);
  });
});
