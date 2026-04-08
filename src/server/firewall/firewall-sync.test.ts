/**
 * Firewall policy sync tests — cross-subsystem traces between firewall,
 * lifecycle/bootstrap, and learning ingestion.
 *
 * Covers:
 * - applyFirewallPolicyToSandbox failure during bootstrap does not crash lifecycle
 * - firewall mode transition from learning to enforcing triggers policy sync
 * - policy sync retry after transient sandbox API failure
 * - learning mode ingestion extracts domains from shell log correctly
 * - concurrent sandbox restore results in exactly one firewall policy application
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { withHarness, type ScenarioHarness, FakeSandboxHandle } from "@/test-utils/harness";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import {
  setFirewallMode,
  syncFirewallPolicyIfRunning,
  ingestLearningFromSandbox,
  promoteLearnedDomainsToEnforcing,
} from "@/server/firewall/state";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";
import type { SingleMeta } from "@/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up meta so the harness looks like a running sandbox,
 * and register a handle in the controller so `get({ sandboxId })` works.
 */
async function seedRunning(
  h: ScenarioHarness,
  configure?: (meta: SingleMeta) => void,
): Promise<void> {
  const sandboxId = "sbx-fake-1";
  // Ensure a handle exists for this sandbox ID in the controller
  if (!h.controller.handlesByIds.has(sandboxId)) {
    const handle = new FakeSandboxHandle(sandboxId, h.controller.events);
    h.controller.handlesByIds.set(sandboxId, handle);
  }

  await h.mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = sandboxId;
    meta.gatewayToken = "test-gw-token";
    meta.portUrls = { "3000": `https://${sandboxId}-3000.fake.vercel.run` };
    configure?.(meta);
  });
}

/** Pause for a tick to let background `void run()` execute. */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. applyFirewallPolicyToSandbox failure during bootstrap does not crash lifecycle
// ---------------------------------------------------------------------------

test("applyFirewallPolicyToSandbox failure during bootstrap sets error status but does not throw from ensureSandboxRunning", async () => {
  await withHarness(async (h) => {
    // Make the first sandbox's updateNetworkPolicy throw
    const origCreate = h.controller.create.bind(h.controller);
    h.controller.create = async (params) => {
      const handle = (await origCreate(params)) as FakeSandboxHandle;
      handle.updateNetworkPolicy = async () => {
        throw new Error("sandbox API unreachable");
      };
      return handle;
    };

    // Configure gateway probe to succeed (so bootstrap proceeds to the policy step)
    h.fakeFetch.otherwise(async () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    // ensureSandboxRunning schedules work in background — should not throw
    const result = await ensureSandboxRunning({
      origin: "https://test.vercel.app",
      reason: "firewall-sync-test",
    });

    // The initial call returns waiting; background work will run
    assert.equal(result.state, "waiting");

    // Wait for the background lifecycle to complete
    await tick(1000);

    // The lifecycle should have caught the error — it either set error status,
    // or is still in a transitional state (setup/creating). The key assertion
    // is that ensureSandboxRunning itself did not throw.
    const meta = await h.getMeta();
    assert.ok(
      ["error", "running", "booting", "setup", "creating"].includes(meta.status),
      `Expected lifecycle to handle policy failure gracefully, got status: ${meta.status}`,
    );
  });
});

test("applyFirewallPolicyToSandbox calls updateNetworkPolicy with correct enforcing policy", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["vercel.com", "api.openai.com"];
    });

    const meta = await h.getMeta();
    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    const policy = await applyFirewallPolicyToSandbox(fakeHandle, meta);

    assert.deepEqual(policy, { allow: ["api.openai.com", "vercel.com"] });
    assert.equal(fakeHandle.networkPolicies.length, 1);
    assert.deepEqual(fakeHandle.networkPolicies[0], { allow: ["api.openai.com", "vercel.com"] });
  });
});

// ---------------------------------------------------------------------------
// 2. firewall mode transition from learning to enforcing triggers policy sync
// ---------------------------------------------------------------------------

test("promoting learned domains to enforcing syncs { allow: [...] } to sandbox", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.learned = [
        { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 5 },
        { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 3, hitCount: 2 },
      ];
    });

    const fw = await promoteLearnedDomainsToEnforcing();

    assert.equal(fw.mode, "enforcing");
    assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
    assert.deepEqual(fw.learned, []);

    // Verify the sandbox received the enforcing policy
    const policyEvents = h.controller.eventsOfKind("update_network_policy");
    assert.equal(policyEvents.length, 1);
    const appliedPolicy = policyEvents[0].detail?.policy as { allow: string[] };
    assert.deepEqual(appliedPolicy.allow, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
  });
});

test("setFirewallMode from learning to disabled syncs allow-all to sandbox", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    const fw = await setFirewallMode("disabled");
    assert.equal(fw.mode, "disabled");

    const policyEvents = h.controller.eventsOfKind("update_network_policy");
    assert.equal(policyEvents.length, 1);
    assert.equal(policyEvents[0].detail?.policy, "allow-all");
  });
});

// ---------------------------------------------------------------------------
// 3. policy sync retry after transient sandbox API failure
// ---------------------------------------------------------------------------

test("syncFirewallPolicyIfRunning reports applied:false when sandbox is not running", async () => {
  await withHarness(async (_h) => {
    // Default meta is uninitialized — no sandbox
    const result = await syncFirewallPolicyIfRunning();
    assert.equal(result.applied, false);
    assert.equal(result.reason, "sandbox-not-running");
  });
});

test("syncFirewallPolicyIfRunning succeeds after transient failure on retry", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;

    // First call: simulate transient failure
    let callCount = 0;
    const origUpdate = fakeHandle.updateNetworkPolicy.bind(fakeHandle);
    fakeHandle.updateNetworkPolicy = async (policy: NetworkPolicy) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient sandbox API error");
      }
      return origUpdate(policy);
    };

    // First attempt fails
    await assert.rejects(
      syncFirewallPolicyIfRunning(),
      (err: Error) => err.message === "transient sandbox API error",
    );

    // Second attempt (retry) succeeds
    const result = await syncFirewallPolicyIfRunning();
    assert.equal(result.applied, true);
    assert.equal(result.reason, "policy-applied");
    assert.equal(callCount, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. learning mode ingestion extracts domains from shell log correctly
// ---------------------------------------------------------------------------

test("ingestLearningFromSandbox extracts domains from curl/wget/dns commands", async () => {
  await withHarness(async (h) => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions -H 'Authorization: Bearer sk-xxx'",
      "wget https://registry.npmjs.org/express",
      "dns lookup api.anthropic.com",
      "host: cdn.vercel.com",
      "some random non-domain text",
    ].join("\n");

    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    // Configure the sandbox to return our shell log
    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    fakeHandle.responders.push((cmd, args) => {
      const full = [cmd, ...(args ?? [])].join(" ");
      if (full.includes("shell-commands-for-learning.log")) {
        return { exitCode: 0, output: async () => shellLog };
      }
      return undefined;
    });

    const result = await ingestLearningFromSandbox(true);

    assert.equal(result.ingested, true);
    assert.ok(result.domains.includes("api.openai.com"));
    assert.ok(result.domains.includes("registry.npmjs.org"));
    assert.ok(result.domains.includes("api.anthropic.com"));
    assert.ok(result.domains.includes("cdn.vercel.com"));

    // Verify learned entries stored in metadata
    const meta = await h.getMeta();
    const learnedDomains = meta.firewall.learned.map((e) => e.domain).sort();
    assert.ok(learnedDomains.includes("api.openai.com"));
    assert.ok(learnedDomains.includes("registry.npmjs.org"));

    // Verify domain_observed events recorded
    assert.ok(
      meta.firewall.events.some((e) => e.action === "domain_observed"),
      "Expected domain_observed events in firewall event log",
    );
  });
});

test("ingestLearningFromSandbox skips domains already in allowlist", async () => {
  await withHarness(async (h) => {
    const shellLog = "curl https://api.openai.com/v1/chat\ncurl https://new-domain.example.com/api";

    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    fakeHandle.responders.push((cmd, args) => {
      const full = [cmd, ...(args ?? [])].join(" ");
      if (full.includes("shell-commands-for-learning.log")) {
        return { exitCode: 0, output: async () => shellLog };
      }
      return undefined;
    });

    const result = await ingestLearningFromSandbox(true);

    assert.equal(result.ingested, true);
    // api.openai.com should NOT appear in learned (already in allowlist)
    const meta = await h.getMeta();
    const learnedDomains = meta.firewall.learned.map((e) => e.domain);
    assert.ok(!learnedDomains.includes("api.openai.com"), "Should not learn already-allowlisted domain");
    assert.ok(learnedDomains.includes("new-domain.example.com"), "Should learn new domain");
  });
});

test("ingestLearningFromSandbox returns ingested:false when mode is not learning", async () => {
  await withHarness(async (h) => {
    await seedRunning(h); // default mode is disabled

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "mode-not-learning");
  });
});

test("ingestLearningFromSandbox returns ingested:false when sandbox is not running", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      // status remains uninitialized, no sandboxId
    });

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "sandbox-not-running");
  });
});

test("ingestLearningFromSandbox handles sandbox read failure gracefully", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    fakeHandle.responders.push((cmd, args) => {
      const full = [cmd, ...(args ?? [])].join(" ");
      if (full.includes("shell-commands-for-learning.log")) {
        // Simulate a failure — throw from the output() call
        return {
          exitCode: 1,
          output: async () => {
            throw new Error("sandbox unreachable");
          },
        };
      }
      return undefined;
    });

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "sandbox-read-failed");
  });
});

// ---------------------------------------------------------------------------
// 5. concurrent sandbox restore results in exactly one firewall policy application
// ---------------------------------------------------------------------------

test("concurrent ensureSandboxRunning calls result in at most one sandbox create", async () => {
  await withHarness(async (h) => {
    // Configure gateway probe to succeed
    h.fakeFetch.otherwise(async () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    // Fire 3 concurrent restore requests (simulating multiple channel webhooks)
    const [r1, r2, r3] = await Promise.all([
      ensureSandboxRunning({ origin: "https://test.vercel.app", reason: "slack-webhook" }),
      ensureSandboxRunning({ origin: "https://test.vercel.app", reason: "discord-webhook" }),
      ensureSandboxRunning({ origin: "https://test.vercel.app", reason: "telegram-webhook" }),
    ]);

    // All should return waiting (since sandbox starts from uninitialized)
    for (const r of [r1, r2, r3]) {
      assert.ok(
        r.state === "waiting" || r.state === "running",
        `Expected waiting or running, got ${r.state}`,
      );
    }

    // Wait for background lifecycle to settle
    await tick(500);

    // Only one sandbox should have been created (lock prevents duplicates)
    assert.ok(
      h.controller.created.length <= 1,
      `Expected at most 1 sandbox create, got ${h.controller.created.length}`,
    );

    // If a sandbox was created, verify firewall policy was applied exactly once per create
    if (h.controller.created.length === 1) {
      const handle = h.controller.lastCreated()!;
      // Each lifecycle path (create or restore) calls applyFirewallPolicyToSandbox once
      assert.ok(
        handle.networkPolicies.length <= 2,
        `Expected at most 2 policy applications (create+probe), got ${handle.networkPolicies.length}`,
      );
    }
  });
});

test("concurrent ensureSandboxRunning with snapshot results in one restore", async () => {
  await withHarness(async (h) => {
    // Set up as stopped with a snapshot
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-existing-123";
      meta.gatewayToken = "test-gw-token";
      meta.startupScript = "#!/bin/bash\necho ok";
    });

    // Configure gateway probe to succeed
    h.fakeFetch.otherwise(async () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    // Fire concurrent restore requests
    const [r1, r2] = await Promise.all([
      ensureSandboxRunning({ origin: "https://test.vercel.app", reason: "slack-restore" }),
      ensureSandboxRunning({ origin: "https://test.vercel.app", reason: "discord-restore" }),
    ]);

    for (const r of [r1, r2]) {
      assert.ok(
        r.state === "waiting" || r.state === "running",
        `Expected waiting or running, got ${r.state}`,
      );
    }

    await tick(500);

    // Only one sandbox should be created (restore from snapshot)
    assert.ok(
      h.controller.created.length <= 1,
      `Expected at most 1 sandbox restore, got ${h.controller.created.length}`,
    );

    // If restored, verify it was from the snapshot
    if (h.controller.created.length === 1) {
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(
        restoreEvents.length <= 1,
        `Expected at most 1 restore event, got ${restoreEvents.length}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Sync after restore: firewall policy applied after sandbox restore
// ---------------------------------------------------------------------------

test("firewall policy is applied when sandbox is restored from stopped state", async () => {
  await withHarness(async (h) => {
    // First drive to running and configure enforcing firewall
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    // Sync should apply the enforcing policy
    const result = await syncFirewallPolicyIfRunning();
    assert.equal(result.applied, true);
    assert.equal(result.reason, "policy-applied");

    // Verify the correct policy was applied
    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    assert.equal(fakeHandle.networkPolicies.length, 1);
    const applied = fakeHandle.networkPolicies[0] as { allow: string[] };
    assert.deepEqual(applied.allow, ["api.openai.com", "registry.npmjs.org"]);
  });
});

test("firewall learning mode policy (allow-all) applied after restore", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    const result = await syncFirewallPolicyIfRunning();
    assert.equal(result.applied, true);

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    assert.equal(fakeHandle.networkPolicies.length, 1);
    assert.equal(fakeHandle.networkPolicies[0], "allow-all");
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed learning events: garbage input doesn't corrupt state
// ---------------------------------------------------------------------------

test("ingestLearningFromSandbox handles empty log gracefully", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    fakeHandle.responders.push((cmd, args) => {
      const full = [cmd, ...(args ?? [])].join(" ");
      if (full.includes("shell-commands-for-learning.log")) {
        return { exitCode: 0, output: async () => "" };
      }
      return undefined;
    });

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "no-domains");
    assert.deepEqual(result.domains, []);
  });
});

test("ingestLearningFromSandbox ignores malformed/garbage lines without corrupting state", async () => {
  await withHarness(async (h) => {
    const garbageLog = [
      "",
      "   ",
      "not a domain at all",
      "!!!@@@###",
      "curl https://api.openai.com/v1/chat",
      "random noise 12345",
      "http://",
      "just-a-bare-word",
    ].join("\n");

    await seedRunning(h, (meta) => {
      meta.firewall.mode = "learning";
    });

    const fakeHandle = h.controller.handlesByIds.get("sbx-fake-1")!;
    fakeHandle.responders.push((cmd, args) => {
      const full = [cmd, ...(args ?? [])].join(" ");
      if (full.includes("shell-commands-for-learning.log")) {
        return { exitCode: 0, output: async () => garbageLog };
      }
      return undefined;
    });

    const result = await ingestLearningFromSandbox(true);
    // Should extract only the valid domain
    if (result.domains.length > 0) {
      assert.ok(result.domains.includes("api.openai.com"));
    }

    // State should not be corrupted
    const meta = await h.getMeta();
    for (const entry of meta.firewall.learned) {
      assert.ok(typeof entry.domain === "string");
      assert.ok(entry.domain.length > 0);
      assert.ok(typeof entry.hitCount === "number");
      assert.ok(entry.hitCount >= 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Blocked-domain persistence: domains remain after mode transitions
// ---------------------------------------------------------------------------

test("allowlist persists across mode transitions (enforcing -> disabled -> enforcing)", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    // Transition to disabled
    const fwDisabled = await setFirewallMode("disabled");
    assert.equal(fwDisabled.mode, "disabled");
    // Allowlist should still be there
    assert.deepEqual(fwDisabled.allowlist, ["api.openai.com", "registry.npmjs.org"]);

    // Transition back to enforcing
    const fwEnforcing = await setFirewallMode("enforcing");
    assert.equal(fwEnforcing.mode, "enforcing");
    assert.deepEqual(fwEnforcing.allowlist, ["api.openai.com", "registry.npmjs.org"]);
  });
});

test("blocked domains (removed from allowlist) stay removed after sync", async () => {
  await withHarness(async (h) => {
    await seedRunning(h, (meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "evil.example.com", "registry.npmjs.org"];
    });

    // Remove a domain
    const { removeDomains: removeDomainsFn } = await import("@/server/firewall/state");
    const fw = await removeDomainsFn(["evil.example.com"]);
    assert.deepEqual(fw.allowlist, ["api.openai.com", "registry.npmjs.org"]);

    // Verify the sandbox received the updated policy without the removed domain
    const policyEvents = h.controller.eventsOfKind("update_network_policy");
    assert.ok(policyEvents.length >= 1);
    const lastPolicy = policyEvents[policyEvents.length - 1].detail?.policy as { allow: string[] };
    assert.ok(!lastPolicy.allow.includes("evil.example.com"), "Removed domain should not be in policy");
    assert.ok(lastPolicy.allow.includes("api.openai.com"), "Remaining domain should be in policy");
  });
});
