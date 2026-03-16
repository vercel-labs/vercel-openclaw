/**
 * Full smoke test for vercel-openclaw.
 *
 * Exercises the complete lifecycle of the app in 8 phases:
 *   1. Harness setup with all channels + firewall learning
 *   2. Fresh create + bootstrap → running
 *   3. Proxy verification → HTML injection + WS rewrite + no token leak
 *   4. Firewall learning + sync → enforce → policy applied
 *   5. Snapshot stop → stopped + snapshotId
 *   6. Channel-triggered restore → Slack+Telegram enqueue → one restore + replies
 *   7. Already-running Discord → no second restore + chunking
 *   8. Final invariants → clean queues + correct lifecycle sequence + no error logs
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import {
  ensureMetaShape,
  CURRENT_SCHEMA_VERSION,
} from "@/shared/types";
import {
  createScenarioHarness,
  dumpDiagnostics,
  type ScenarioHarness,
} from "@/test-utils/harness";
import {
  chatCompletionsResponse,
  gatewayReadyResponse,
} from "@/test-utils/fake-fetch";
import {
  buildSlackWebhook,
  buildTelegramWebhook,
  buildDiscordWebhook,
} from "@/test-utils/webhook-builders";
import {
  assertGatewayRequest,
  assertQueuesDrained,
  assertNoBrowserAuthTraffic,
} from "@/test-utils/assertions";
import {
  ensureSandboxRunning,
  probeGatewayReady,
  stopSandbox,
} from "@/server/sandbox/lifecycle";
import { enqueueChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
} from "@/server/channels/keys";
import {
  setFirewallMode,
  approveDomains,
  syncFirewallPolicyIfRunning,
  ingestLearningFromSandbox,
} from "@/server/firewall/state";
import { injectWrapperScript } from "@/server/proxy/htmlInjection";

// ---------------------------------------------------------------------------
// Full smoke test — single sequential test with 8 phases
// ---------------------------------------------------------------------------

test("full-smoke: complete lifecycle with channels, firewall, and proxy", async (t) => {
  const h = createScenarioHarness();

  try {
    // =====================================================================
    // Phase 1: Harness setup with all channels + firewall learning
    // =====================================================================
    await t.test("Phase 1: harness setup with all channels + firewall learning", async () => {
      h.installDefaultGatewayHandlers("Smoke test reply");

      // Configure all three channels
      const secrets = h.configureAllChannels();
      assert.ok(secrets.slackSigningSecret, "Slack signing secret configured");
      assert.ok(secrets.telegramWebhookSecret, "Telegram webhook secret configured");
      assert.ok(secrets.discordPublicKeyHex, "Discord public key configured");

      // Set firewall to learning mode
      const meta = await h.getMeta();
      assert.equal(meta.firewall.mode, "disabled", "Firewall starts disabled");

      await h.mutateMeta((m) => {
        m.firewall.mode = "learning";
        m.firewall.updatedAt = Date.now();
      });

      const updated = await h.getMeta();
      assert.equal(updated.firewall.mode, "learning", "Firewall now in learning mode");
      assert.ok(updated.channels.slack, "Slack configured");
      assert.ok(updated.channels.telegram, "Telegram configured");
      assert.ok(updated.channels.discord, "Discord configured");

      h.log.info("phase-1-complete");
    });

    // =====================================================================
    // Phase 2: Fresh create + bootstrap → running
    // =====================================================================
    await t.test("Phase 2: fresh create + bootstrap → running", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = h.fakeFetch.fetch;

      try {
        let scheduledCallback: (() => Promise<void> | void) | null = null;

        const result = await ensureSandboxRunning({
          origin: "https://smoke.example.com",
          reason: "smoke-test-create",
          schedule(cb) {
            scheduledCallback = cb;
          },
        });

        assert.equal(result.state, "waiting", "Should return waiting for fresh create");
        assert.ok(scheduledCallback, "Background work should be scheduled");

        // Execute scheduled background work (create + bootstrap)
        await (scheduledCallback as () => Promise<void>)();

        // Probe gateway readiness
        const meta = await h.getMeta();
        if (meta.status !== "running") {
          const probe = await probeGatewayReady();
          assert.ok(probe.ready || (await h.getMeta()).status === "running",
            `Expected running after probe, got ${(await h.getMeta()).status}`);
        }

        const running = await h.getMeta();
        assert.equal(running.status, "running", "Sandbox should be running");
        assert.ok(running.sandboxId, "sandboxId should be set");
        assert.ok(running.portUrls, "portUrls should be set");

        // Verify controller events
        assert.equal(h.controller.created.length, 1, "Exactly one sandbox created");
        assert.equal(h.controller.eventsOfKind("create").length, 1, "One create event");

        // Verify bootstrap artifacts were written
        const handle = h.controller.lastCreated()!;
        assert.ok(handle.writtenFiles.length > 0, "Bootstrap should write config files");
        assert.ok(handle.commands.length > 0, "Bootstrap should run commands");

        h.log.info("phase-2-complete", { sandboxId: running.sandboxId });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // =====================================================================
    // Phase 3: Proxy verification → HTML injection + WS rewrite + no token leak
    // =====================================================================
    await t.test("Phase 3: proxy verification → HTML injection + WS rewrite + no token leak", async () => {
      const meta = await h.getMeta();
      assert.equal(meta.status, "running");

      const sandboxOrigin = meta.portUrls!["3000"]!;
      const gatewayToken = meta.gatewayToken;

      // Test HTML injection
      const rawHtml = '<html><head><title>OpenClaw</title></head><body><div id="openclaw-app">ready</div></body></html>';
      const injected = injectWrapperScript(rawHtml, {
        sandboxOrigin,
        gatewayToken,
      });

      // Verify script injection
      assert.ok(injected.includes("<script>"), "Should inject interceptor script");
      assert.ok(injected.includes("WebSocket"), "Should include WebSocket rewrite");
      assert.ok(injected.includes("openclaw.gateway-token"), "Should include gateway token protocol");
      assert.ok(injected.includes("/api/status"), "Should include heartbeat URL");
      assert.ok(injected.includes('<base href="/gateway/">'), "Should inject base tag");
      assert.ok(injected.includes('no-referrer'), "Should inject referrer policy");

      // Verify the gateway token is embedded in the script (needed for WS auth)
      assert.ok(injected.includes(gatewayToken), "Gateway token should be in injected script");

      // Verify the token does not leak outside the script tag
      // (The token should only appear inside <script>...</script>)
      const scriptStart = injected.indexOf("<script>");
      const scriptEnd = injected.indexOf("</script>") + "</script>".length;
      const beforeScript = injected.slice(0, scriptStart);
      const afterScript = injected.slice(scriptEnd);
      assert.ok(!beforeScript.includes(gatewayToken), "Token must not leak before script");
      assert.ok(!afterScript.includes(gatewayToken), "Token must not leak after script");

      // Verify no browser auth traffic was generated
      assertNoBrowserAuthTraffic(h.fakeFetch.requests());

      h.log.info("phase-3-complete");
    });

    // =====================================================================
    // Phase 4: Firewall learning + sync → enforce → policy applied
    // =====================================================================
    await t.test("Phase 4: firewall learning + sync → enforce → policy applied", async () => {
      const meta = await h.getMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.firewall.mode, "learning");

      // Simulate learning by scripting a command responder that returns domain log
      const handle = h.controller.lastCreated()!;
      handle.responders.push((cmd, args) => {
        if (cmd === "bash" && args?.some((a) => a.includes("shell-commands-for-learning"))) {
          return {
            exitCode: 0,
            output: async () =>
              "curl https://api.openai.com/v1/models\nwget https://registry.npmjs.org/openclaw\ncurl https://api.github.com/repos",
          };
        }
        return undefined;
      });

      // Ingest learning from sandbox
      const ingestResult = await ingestLearningFromSandbox(true);
      assert.ok(ingestResult.ingested, "Should have ingested domains");
      assert.ok(ingestResult.domains.length > 0, "Should have learned domains");

      // Verify learned domains in meta
      const afterIngest = await h.getMeta();
      assert.ok(afterIngest.firewall.learned.length > 0, "Learned domains should be stored");

      // Check expected domains were learned
      const learnedNames = afterIngest.firewall.learned.map((d) => d.domain);
      assert.ok(learnedNames.includes("api.openai.com"), "Should learn api.openai.com");
      assert.ok(learnedNames.includes("registry.npmjs.org"), "Should learn registry.npmjs.org");
      assert.ok(learnedNames.includes("api.github.com"), "Should learn api.github.com");

      // Approve learned domains to allowlist
      await approveDomains(learnedNames);

      const afterApprove = await h.getMeta();
      assert.ok(afterApprove.firewall.allowlist.length >= 3, "Allowlist should have at least 3 domains");
      assert.equal(afterApprove.firewall.learned.length, 0, "Learned list should be cleared after approval");

      // Switch to enforcing mode
      await setFirewallMode("enforcing");

      const enforcing = await h.getMeta();
      assert.equal(enforcing.firewall.mode, "enforcing", "Should be in enforcing mode");

      // Sync policy to sandbox — verify network policy was applied
      const syncResult = await syncFirewallPolicyIfRunning();
      assert.ok(syncResult.applied, "Policy should be applied to running sandbox");

      // Verify the handle received a network policy update
      // The sync in setFirewallMode already applied one, and we called syncFirewallPolicyIfRunning again
      assert.ok(handle.networkPolicies.length >= 1, "Network policy should have been applied");
      const lastPolicy = handle.networkPolicies[handle.networkPolicies.length - 1]!;
      assert.ok(
        typeof lastPolicy === "object" && lastPolicy !== null && "allow" in lastPolicy,
        "Enforcing policy should have allow list",
      );
      const allowList = (lastPolicy as unknown as { allow: string[] }).allow;
      assert.ok(allowList.includes("api.openai.com"), "Policy should include api.openai.com");
      assert.ok(allowList.includes("registry.npmjs.org"), "Policy should include registry.npmjs.org");

      // Verify firewall events were recorded
      assert.ok(enforcing.firewall.events.length > 0, "Firewall events should be recorded");

      h.log.info("phase-4-complete", { allowlistSize: enforcing.firewall.allowlist.length });
    });

    // =====================================================================
    // Phase 5: Snapshot stop → stopped + snapshotId
    // =====================================================================
    await t.test("Phase 5: snapshot stop → stopped + snapshotId", async () => {
      const beforeStop = await h.getMeta();
      assert.equal(beforeStop.status, "running");
      const sandboxId = beforeStop.sandboxId!;

      const stopped = await stopSandbox();

      assert.equal(stopped.status, "stopped", "Status should be stopped");
      assert.ok(stopped.snapshotId, "snapshotId should be present");
      assert.ok(stopped.snapshotId!.startsWith("snap-"), "snapshotId should have snap- prefix");
      assert.equal(stopped.sandboxId, null, "sandboxId should be cleared");
      assert.equal(stopped.portUrls, null, "portUrls should be cleared");

      // Verify snapshot history
      assert.ok(stopped.snapshotHistory.length > 0, "Snapshot history should have entry");
      assert.equal(stopped.snapshotHistory[0]!.snapshotId, stopped.snapshotId);
      assert.equal(stopped.snapshotHistory[0]!.reason, "stop");

      // Verify controller events
      const snapshotEvents = h.controller.eventsOfKind("snapshot");
      assert.equal(snapshotEvents.length, 1, "Stop snapshot should be recorded");
      assert.equal(snapshotEvents[0]!.sandboxId, sandboxId);

      // Verify the handle's snapshot was called
      const handle = h.controller.getHandle(sandboxId);
      assert.ok(handle, "Handle should exist");
      assert.ok(handle!.snapshotCalled, "snapshot() should have been called");

      h.log.info("phase-5-complete", { snapshotId: stopped.snapshotId });
    });

    // =====================================================================
    // Phase 6: Channel-triggered restore → Slack+Telegram enqueue → one restore + replies
    // =====================================================================
    await t.test("Phase 6: channel-triggered restore → Slack+Telegram → one restore + replies", async () => {
      const stoppedMeta = await h.getMeta();
      assert.equal(stoppedMeta.status, "stopped");
      assert.ok(stoppedMeta.snapshotId);

      const secrets = h.configureAllChannels();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = h.fakeFetch.fetch;

      try {
        // Enqueue a Slack job while stopped
        const slackReq = buildSlackWebhook({ signingSecret: secrets.slackSigningSecret });
        const slackBody = await slackReq.text();
        const slackPayload = JSON.parse(slackBody);

        await enqueueChannelJob("slack", {
          payload: slackPayload,
          receivedAt: Date.now(),
          origin: "https://smoke.example.com",
        });

        // Enqueue a Telegram job while stopped
        const telegramReq = buildTelegramWebhook({
          webhookSecret: secrets.telegramWebhookSecret,
        });
        const telegramBody = await telegramReq.text();
        const telegramPayload = JSON.parse(telegramBody);

        await enqueueChannelJob("telegram", {
          payload: telegramPayload,
          receivedAt: Date.now(),
          origin: "https://smoke.example.com",
        });

        const store = h.getStore();
        assert.equal(
          await store.getQueueLength(channelQueueKey("slack")),
          1,
          "Slack queue should have 1 job",
        );
        assert.equal(
          await store.getQueueLength(channelQueueKey("telegram")),
          1,
          "Telegram queue should have 1 job",
        );

        // Record controller state before drain
        const createsBefore = h.controller.created.length;

        // Drain Slack → triggers restore
        await drainSlackQueue();

        // Verify sandbox was restored and is running
        const afterSlack = await h.getMeta();
        assert.equal(afterSlack.status, "running", "Should be running after Slack drain");

        // Verify exactly one restore event
        const restoreEvents = h.controller.eventsOfKind("restore");
        assert.equal(
          restoreEvents.length,
          1,
          `Expected 1 restore event, got ${restoreEvents.length}`,
        );
        assert.deepEqual(
          restoreEvents[0]!.detail,
          { snapshotId: stoppedMeta.snapshotId },
          "Restore should use correct snapshot",
        );

        // Verify Slack API call was made (reply)
        const slackRequests = h.fakeFetch
          .requests()
          .filter((r) => r.url.includes("slack.com/api") && r.method === "POST");
        assert.ok(slackRequests.length >= 1, "At least one Slack API reply");

        // Verify gateway was called with correct token
        assertGatewayRequest(h.fakeFetch.requests(), {
          gatewayToken: afterSlack.gatewayToken,
        });

        // Now drain Telegram — sandbox is already running, no second restore
        const restoresBefore = h.controller.eventsOfKind("restore").length;
        await drainTelegramQueue();

        const afterTelegram = await h.getMeta();
        assert.equal(afterTelegram.status, "running", "Still running after Telegram drain");

        // Verify no additional restore events
        assert.equal(
          h.controller.eventsOfKind("restore").length,
          restoresBefore,
          "No second restore for Telegram — sandbox already running",
        );

        // Verify Telegram API call was made
        const telegramRequests = h.fakeFetch
          .requests()
          .filter((r) => r.url.includes("api.telegram.org"));
        assert.ok(telegramRequests.length >= 1, "At least one Telegram API reply");

        // Verify both queues are drained
        await assertQueuesDrained(store, "slack");
        await assertQueuesDrained(store, "telegram");

        h.log.info("phase-6-complete", {
          restores: h.controller.eventsOfKind("restore").length,
          creates: h.controller.created.length - createsBefore,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // =====================================================================
    // Phase 7: Already-running Discord → no second restore + chunking
    // =====================================================================
    await t.test("Phase 7: already-running Discord → no second restore + chunking", async () => {
      const meta = await h.getMeta();
      assert.equal(meta.status, "running", "Sandbox should still be running from Phase 6");

      const secrets = h.configureAllChannels();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = h.fakeFetch.fetch;

      try {
        const restoresBefore = h.controller.eventsOfKind("restore").length;

        // Build a long reply to test chunking
        const longReply = "A".repeat(2500);
        h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
          chatCompletionsResponse(longReply),
        );

        // Enqueue a Discord interaction
        const discordReq = buildDiscordWebhook({
          privateKey: secrets.discordPrivateKey,
          publicKeyHex: secrets.discordPublicKeyHex,
        });
        const discordBody = await discordReq.text();
        const discordPayload = JSON.parse(discordBody);

        await enqueueChannelJob("discord", {
          payload: discordPayload,
          receivedAt: Date.now(),
          origin: "https://smoke.example.com",
        });

        const store = h.getStore();
        assert.equal(
          await store.getQueueLength(channelQueueKey("discord")),
          1,
          "Discord queue should have 1 job",
        );

        // Drain Discord — should NOT trigger a restore since sandbox is already running
        await drainDiscordQueue();

        const afterDiscord = await h.getMeta();
        assert.equal(afterDiscord.status, "running", "Still running after Discord drain");

        // Verify no additional restores
        assert.equal(
          h.controller.eventsOfKind("restore").length,
          restoresBefore,
          "No extra restore for Discord — sandbox was already running",
        );

        // Verify Discord API calls were made (PATCH for deferred edit or POST for channel)
        const discordRequests = h.fakeFetch
          .requests()
          .filter((r) => r.url.includes("discord.com") && (r.method === "PATCH" || r.method === "POST"));
        assert.ok(discordRequests.length >= 1, "At least one Discord API call");

        // Verify gateway request was made
        assertGatewayRequest(h.fakeFetch.requests(), {
          gatewayToken: afterDiscord.gatewayToken,
          minCalls: 2, // At least 2 total: one from Slack drain (phase 6) + this Discord drain
        });

        // Verify Discord queue is drained
        await assertQueuesDrained(store, "discord");

        h.log.info("phase-7-complete", {
          restores: h.controller.eventsOfKind("restore").length,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // =====================================================================
    // Phase 8: Final invariants → clean queues + correct lifecycle + no error logs
    // =====================================================================
    await t.test("Phase 8: final invariants → clean queues + lifecycle sequence + no errors", async () => {
      const store = h.getStore();
      const meta = await h.getMeta();

      // --- Clean queues for all channels (including failed) ---
      const channels: ChannelName[] = ["slack", "telegram", "discord"];
      for (const ch of channels) {
        await assertQueuesDrained(store, ch);

        // Also verify no failed entries accumulated
        const dlLen = await store.getQueueLength(channelFailedKey(ch));
        assert.equal(dlLen, 0, `${ch} failed queue should be empty`);

        // Verify processing queues are also empty
        const procLen = await store.getQueueLength(channelProcessingKey(ch));
        assert.equal(procLen, 0, `${ch} processing queue should be empty`);
      }

      // --- Correct lifecycle event sequence ---
      const lifecycleEvents = h.controller.events
        .filter((e) => ["create", "snapshot", "restore"].includes(e.kind))
        .map((e) => e.kind);

      assert.deepEqual(
        lifecycleEvents,
        ["create", "snapshot", "restore"],
        "Lifecycle sequence should be: create → stop snapshot → restore",
      );

      // --- Timestamps are monotonically non-decreasing ---
      const timelineEvents = h.controller.events.filter((e) =>
        ["create", "snapshot", "restore"].includes(e.kind),
      );
      for (let i = 1; i < timelineEvents.length; i++) {
        assert.ok(
          timelineEvents[i]!.timestamp >= timelineEvents[i - 1]!.timestamp,
          `Event ${timelineEvents[i]!.kind} should have timestamp >= ${timelineEvents[i - 1]!.kind}`,
        );
      }

      // --- Sandbox count: 1 create + 1 restore = 2 total ---
      assert.equal(
        h.controller.created.length,
        2,
        "Should have exactly 2 sandboxes created (1 fresh + 1 restore)",
      );

      // --- Exactly one restore ---
      assert.equal(
        h.controller.eventsOfKind("restore").length,
        1,
        "Should have exactly 1 restore event across the entire test",
      );

      // --- Final metadata state is healthy ---
      assert.equal(meta.status, "running", "Final status should be running");
      assert.ok(meta.sandboxId, "sandboxId should be set");
      assert.ok(meta.snapshotId, "snapshotId should be preserved from restore");
      assert.equal(meta.lastError, null, "No errors in final state");
      assert.equal(meta.firewall.mode, "enforcing", "Firewall should still be enforcing");
      assert.ok(meta.firewall.allowlist.length >= 3, "Allowlist should have learned domains");

      // --- No error-level log entries ---
      const errorLogs = h.log.entries.filter((e) => e.level === "error");
      assert.equal(
        errorLogs.length,
        0,
        `Expected 0 error logs, got ${errorLogs.length}: ${errorLogs.map((e) => e.message).join(", ")}`,
      );

      // --- No browser auth traffic (admin-secret mode) ---
      assertNoBrowserAuthTraffic(h.fakeFetch.requests());

      // --- Snapshot history has at least one entry ---
      assert.ok(meta.snapshotHistory.length >= 1, "Should have snapshot history");

      // --- Channels are still configured ---
      assert.ok(meta.channels.slack, "Slack config persisted");
      assert.ok(meta.channels.telegram, "Telegram config persisted");
      assert.ok(meta.channels.discord, "Discord config persisted");

      // --- Metadata shape consistency after full lifecycle ---
      // Verify ensureMetaShape round-trips the post-lifecycle meta cleanly
      const reshapedMeta = ensureMetaShape(meta);
      assert.ok(reshapedMeta, "ensureMetaShape should accept post-lifecycle meta");
      assert.equal(reshapedMeta._schemaVersion, CURRENT_SCHEMA_VERSION, "Schema version must be current");
      assert.equal(reshapedMeta.id, "openclaw-single", "Meta ID must be canonical");
      assert.equal(reshapedMeta.status, meta.status, "Status preserved through reshape");
      assert.equal(reshapedMeta.sandboxId, meta.sandboxId, "sandboxId preserved through reshape");
      assert.equal(reshapedMeta.snapshotId, meta.snapshotId, "snapshotId preserved through reshape");
      assert.equal(reshapedMeta.gatewayToken, meta.gatewayToken, "gatewayToken preserved through reshape");
      assert.equal(reshapedMeta.firewall.mode, meta.firewall.mode, "Firewall mode preserved");
      assert.deepStrictEqual(reshapedMeta.firewall.allowlist, meta.firewall.allowlist, "Allowlist preserved");
      assert.equal(reshapedMeta.snapshotHistory.length, meta.snapshotHistory.length, "Snapshot history length preserved");

      // --- Snapshot history is ordered by recency (descending/newest first) ---
      for (let i = 1; i < meta.snapshotHistory.length; i++) {
        assert.ok(
          meta.snapshotHistory[i - 1]!.timestamp >= meta.snapshotHistory[i]!.timestamp,
          `Snapshot history[${i - 1}] timestamp should be >= history[${i}]`,
        );
      }

      // --- Each snapshot record has required fields ---
      for (const record of meta.snapshotHistory) {
        assert.ok(record.id, "Snapshot record must have an id");
        assert.ok(record.snapshotId, "Snapshot record must have a snapshotId");
        assert.ok(record.timestamp > 0, "Snapshot record must have a positive timestamp");
        assert.ok(record.reason, "Snapshot record must have a reason");
      }

      // --- Metadata version is monotonically increasing (> 1 after lifecycle) ---
      assert.ok(meta.version > 1, `Meta version should be > 1 after lifecycle, got ${meta.version}`);

      // --- createdAt <= updatedAt ---
      assert.ok(
        meta.createdAt <= meta.updatedAt,
        `createdAt (${meta.createdAt}) should be <= updatedAt (${meta.updatedAt})`,
      );

      h.log.info("phase-8-complete: all invariants passed");
    });
  } catch (err) {
    // Dump full diagnostic output on failure
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
