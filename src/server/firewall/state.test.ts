import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import { DOMAIN_PRESETS, computePolicyHash, ensureMetaShape } from "@/shared/types";
import {
  _setAiGatewayCredentialOverrideForTesting,
  _setInstanceIdOverrideForTesting,
} from "@/server/env";
import {
  approveDomains,
  computeWouldBlock,
  dismissLearnedDomains,
  getFirewallState,
  ingestLearningFromSandbox,
  promoteLearnedDomainsToEnforcing,
  removeDomains,
  setFirewallMode,
  syncFirewallPolicyIfRunning,
} from "@/server/firewall/state";
import { toNetworkPolicy } from "@/server/firewall/policy";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { learningLockKey } from "@/server/store/keyspace";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";
import { getServerLogs, _resetLogBuffer } from "@/server/log";

async function withFirewallTestStore(fn: () => Promise<void>): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL: undefined,
    REDIS_URL: undefined,
    KV_URL: undefined,
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
  };
  const originals: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  // Default tests to no AI Gateway credential so firewall sync does not
  // inject a transform rule. Tests that exercise token injection explicitly
  // set their own credential override.
  _setAiGatewayCredentialOverrideForTesting(null);

  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _setAiGatewayCredentialOverrideForTesting(null);
    _resetStoreForTesting();
    _resetLogBuffer();
  }
}

function withInstanceId<T>(
  instanceId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const original = process.env.OPENCLAW_INSTANCE_ID;
  if (instanceId === null) {
    delete process.env.OPENCLAW_INSTANCE_ID;
  } else {
    process.env.OPENCLAW_INSTANCE_ID = instanceId;
  }
  _setInstanceIdOverrideForTesting(null);

  const restore = () => {
    if (original === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = original;
    }
    _setInstanceIdOverrideForTesting(null);
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

async function prepareRunningSandbox(
  configure?: (meta: SingleMeta) => void,
): Promise<void> {
  await mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = "sandbox-123";
    configure?.(meta);
  });
}

function installFailingSandboxSync(): {
  readonly updateCalls: number;
  restore(): void;
} {
  let updateCalls = 0;

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        get timeout() { return 1800000; },
        get status() { return "running" as const; },
        async runCommand() {
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async updateNetworkPolicy() {
          updateCalls += 1;
          throw new Error("sandbox policy update failed");
        },
        async readFileToBuffer() { return null; },
        async stop() {},
        async delete() {},
        async runDetachedCommand() { return { cmdId: "fake-cmd" }; },
        async getCommand() { return { async kill() {} }; },
      };
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get updateCalls() {
      return updateCalls;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

async function assertFirewallSyncFailed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "FIREWALL_SYNC_FAILED");
    assert.equal(
      error.message,
      "Failed to sync firewall policy to the running sandbox.",
    );
    return true;
  });
}

test(
  "setFirewallMode throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting mode update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(setFirewallMode("learning"));

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "learning");
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "approveDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(approveDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "removeDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist removal",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
        });

        await assertFirewallSyncFailed(removeDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["vercel.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "promoteLearnedDomainsToEnforcing throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting promotion",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.mode = "learning";
          meta.firewall.learned = [
            {
              domain: "api.openai.com",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hitCount: 3,
            },
          ];
        });

        await assertFirewallSyncFailed(promoteLearnedDomainsToEnforcing());

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "enforcing");
        assert.deepEqual(firewall.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
        assert.deepEqual(firewall.learned, []);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

// ===========================================================================
// Happy-path helpers — succeeding sandbox controller
// ===========================================================================

function installSucceedingSandboxController(opts?: {
  /** Shell command log content returned by `cat /tmp/shell-commands-for-learning.log` */
  shellLog?: string;
}): {
  readonly appliedPolicies: NetworkPolicy[];
  restore(): void;
} {
  const appliedPolicies: NetworkPolicy[] = [];
  const shellLog = opts?.shellLog ?? "";

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        get timeout() { return 1800000; },
        get status() { return "running" as const; },
        async runCommand(_cmd: string, args?: string[]) {
          const cmdStr = [_cmd, ...(args ?? [])].join(" ");
          // If reading the learning log, return the configured content
          if (cmdStr.includes("shell-commands-for-learning.log")) {
            return { exitCode: 0, output: async () => shellLog };
          }
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async updateNetworkPolicy(policy: NetworkPolicy) {
          appliedPolicies.push(policy);
          return policy;
        },
        async readFileToBuffer() { return null; },
        async stop() {},
        async delete() {},
        async runDetachedCommand() { return { cmdId: "fake-cmd" }; },
        async getCommand() { return { async kill() {} }; },
      } satisfies SandboxHandle;
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get appliedPolicies() {
      return appliedPolicies;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

// ===========================================================================
// Firewall mode transition tests (happy path)
// ===========================================================================

test("disabled → learning: mode changes, sandbox policy stays allow-all", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();

      // Default mode is disabled
      let fw = await getFirewallState();
      assert.equal(fw.mode, "disabled");

      // Transition to learning
      fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");

      // Policy applied to sandbox should be allow-all (both disabled and learning map to allow-all)
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");
    } finally {
      ctrl.restore();
    }
  });
});

test("learning → enforcing: learned domains become the allowlist, sandbox policy updates to { allow: [...] }", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learned = [
          { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 5 },
          { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 3, hitCount: 2 },
        ];
      });

      // Promote learned domains to enforcing
      const fw = await promoteLearnedDomainsToEnforcing();

      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Sandbox should have received { allow: [...] } policy
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.ok(typeof applied === "object" && "allow" in applied);
      assert.deepEqual(applied.allow, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: approveDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com"];
      });

      const fw = await approveDomains(["vercel.com"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: removeDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org", "vercel.com"];
      });

      const fw = await removeDomains(["registry.npmjs.org"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("full transition: disabled → learning → ingest domains → enforcing with allowlist", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions",
      "wget https://registry.npmjs.org/express",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox();

      // Step 1: disabled → learning
      let fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");

      // Step 2: ingest domains from shell log
      const ingestResult = await ingestLearningFromSandbox(true);
      assert.equal(ingestResult.ingested, true);
      assert.ok(ingestResult.domains.includes("api.openai.com"));
      assert.ok(ingestResult.domains.includes("registry.npmjs.org"));

      // Verify learned domains stored in metadata
      fw = await getFirewallState();
      assert.equal(fw.learned.length, 2);
      const learnedNames = fw.learned.map((d) => d.domain).sort();
      assert.deepEqual(learnedNames, ["api.openai.com", "registry.npmjs.org"]);

      // Step 3: learning → enforcing (promote learned)
      fw = await promoteLearnedDomainsToEnforcing();
      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Should have synced twice total (setFirewallMode + promote)
      assert.equal(ctrl.appliedPolicies.length, 2);
      const enforcingPolicy = ctrl.appliedPolicies[1] as { allow: string[] };
      assert.deepEqual(enforcingPolicy.allow, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: extracts domains from shell command log and stores in metadata", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "dns lookup api.anthropic.com",
      "host: cdn.vercel.com",
      "https://hooks.slack.com/services/T123/B456",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, true);
      assert.ok(result.domains.length >= 2, `Expected ≥2 domains, got ${result.domains.length}`);
      assert.ok(result.domains.includes("api.anthropic.com"));
      assert.ok(result.domains.includes("cdn.vercel.com"));
      assert.ok(result.domains.includes("hooks.slack.com"));

      // Verify learned entries have correct shape
      const fw = await getFirewallState();
      for (const entry of fw.learned) {
        assert.ok(typeof entry.domain === "string");
        assert.ok(typeof entry.firstSeenAt === "number");
        assert.ok(typeof entry.lastSeenAt === "number");
        assert.ok(typeof entry.hitCount === "number");
        assert.ok(entry.hitCount >= 1);
      }

      // Verify events were recorded
      assert.ok(
        fw.events.some((e) => e.action === "domain_observed"),
        "Expected at least one domain_observed event",
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: skips when mode is not learning", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController({ shellLog: "https://api.openai.com" });
    try {
      await prepareRunningSandbox(); // mode = disabled (default)

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, false);
      assert.equal(result.reason, "mode-not-learning");
      assert.deepEqual(result.domains, []);
    } finally {
      ctrl.restore();
    }
  });
});

test("toNetworkPolicy: disabled and learning return allow-all, enforcing returns { allow: [...] }", () => {
  assert.equal(toNetworkPolicy("disabled", []), "allow-all");
  assert.equal(toNetworkPolicy("learning", ["api.openai.com"]), "allow-all");
  assert.deepEqual(toNetworkPolicy("enforcing", ["vercel.com", "api.openai.com"]), {
    allow: ["api.openai.com", "vercel.com"],
  });
});

// ===========================================================================
// Sync while stopped: setFirewallMode when sandbox is not running
// ===========================================================================

test("setFirewallMode succeeds when sandbox is stopped (no sync needed)", async () => {
  await withFirewallTestStore(async () => {
    // Leave sandbox as uninitialized (default) — no sandboxId, no running instance
    const fw = await setFirewallMode("learning");
    assert.equal(fw.mode, "learning");
    // No sync should have been attempted — no sandbox to sync to
  });
});

test("approveDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    const fw = await approveDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
  });
});

test("removeDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
    });
    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["vercel.com"]);
  });
});

// ===========================================================================
// setFirewallMode to enforcing with empty allowlist is rejected
// ===========================================================================

test("setFirewallMode to enforcing with empty allowlist throws 409", async () => {
  await withFirewallTestStore(async () => {
    // Clear the default-seeded allowlist so the empty-allowlist guard is tested
    await mutateMeta((meta) => {
      meta.firewall.allowlist = [];
    });
    await assert.rejects(
      setFirewallMode("enforcing"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );
  });
});

// ===========================================================================
// Domain merge: ingesting same domain multiple times increments hitCount
// ===========================================================================

test("learning ingestion: enriches events with sourceCommand and category, and learned domains with categories", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions",
      "npm http fetch GET 200 https://registry.npmjs.org/typescript 50ms",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, true);

      const fw = await getFirewallState();

      // Verify events carry sourceCommand and category
      const curlEvent = fw.events.find(
        (e) => e.domain === "api.openai.com" && e.action === "domain_observed",
      );
      assert.ok(curlEvent, "Expected domain_observed event for api.openai.com");
      assert.equal(curlEvent.category, "curl");
      assert.ok(curlEvent.sourceCommand?.includes("curl"));

      const npmEvent = fw.events.find(
        (e) => e.domain === "registry.npmjs.org" && e.action === "domain_observed",
      );
      assert.ok(npmEvent, "Expected domain_observed event for registry.npmjs.org");
      assert.equal(npmEvent.category, "npm");

      // Verify learned domains carry categories
      const openaiLearned = fw.learned.find((l) => l.domain === "api.openai.com");
      assert.ok(openaiLearned);
      assert.ok(openaiLearned.categories?.includes("curl"));

      const npmLearned = fw.learned.find((l) => l.domain === "registry.npmjs.org");
      assert.ok(npmLearned);
      assert.ok(npmLearned.categories?.includes("npm"));
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: caps learned list at 500 entries", async () => {
  await withFirewallTestStore(async () => {
    // Pre-fill with 499 learned domains so ingesting 2 more exceeds the 500 cap
    const existing = Array.from({ length: 499 }, (_, i) => ({
      domain: `d${String(i).padStart(4, "0")}.example.com`,
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      hitCount: 1,
    }));

    const shellLog = [
      "curl https://new-a.example.com/api",
      "curl https://new-b.example.com/api",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learned = existing;
      });

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, true);

      const fw = await getFirewallState();
      // 499 existing + 2 new = 501 → capped at 500
      assert.equal(fw.learned.length, 500);

      // New domains should be present (sorted by lastSeenAt desc, newest first)
      const learnedDomains = fw.learned.map((e) => e.domain);
      assert.ok(learnedDomains.includes("new-a.example.com"));
      assert.ok(learnedDomains.includes("new-b.example.com"));
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: re-ingesting same domain increments hitCount", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = "curl https://api.openai.com/v1/chat";
    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      // First ingestion
      const r1 = await ingestLearningFromSandbox(true);
      assert.equal(r1.ingested, true);

      let fw = await getFirewallState();
      const firstEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(firstEntry);
      assert.equal(firstEntry.hitCount, 1);

      // Second ingestion with same domain
      const r2 = await ingestLearningFromSandbox(true);
      assert.equal(r2.ingested, true);

      fw = await getFirewallState();
      const secondEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(secondEntry);
      assert.equal(secondEntry.hitCount, 2);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// wouldBlock computation tests
// ===========================================================================

test("computeWouldBlock: returns learned domains not in allowlist when mode is learning", () => {
  const state = {
    mode: "learning" as const,
    allowlist: ["api.openai.com"],
    learned: [
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  const result = computeWouldBlock(state);
  assert.deepEqual(result, ["cdn.vercel.com", "registry.npmjs.org"]);
});

test("computeWouldBlock: returns empty array when mode is disabled", () => {
  const state = {
    mode: "disabled" as const,
    allowlist: [],
    learned: [
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("computeWouldBlock: returns empty array when mode is enforcing", () => {
  const state = {
    mode: "enforcing" as const,
    allowlist: ["api.openai.com"],
    learned: [],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("computeWouldBlock: returns empty when all learned domains are in allowlist", () => {
  const state = {
    mode: "learning" as const,
    allowlist: ["api.openai.com", "cdn.vercel.com"],
    learned: [
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("getFirewallState: includes wouldBlock in response during learning", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 3 },
      ];
    });

    const fw = await getFirewallState();
    assert.deepEqual(fw.wouldBlock, ["cdn.vercel.com"]);
  });
});

test("getFirewallState: wouldBlock is empty when mode is disabled", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.learned = [
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      ];
    });

    const fw = await getFirewallState();
    assert.deepEqual(fw.wouldBlock, []);
  });
});

// ===========================================================================
// Soak-time tracking tests
// ===========================================================================

test("setFirewallMode('learning') sets learningStartedAt and resets commandsObserved", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.commandsObserved = 42;
        meta.firewall.learningStartedAt = 1000;
      });

      const before = Date.now();
      const fw = await setFirewallMode("learning");

      assert.equal(fw.mode, "learning");
      assert.equal(fw.commandsObserved, 0);
      assert.ok(
        fw.learningStartedAt !== null && fw.learningStartedAt >= before,
        "learningStartedAt should be set to current time",
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("setFirewallMode('disabled') does not reset learningStartedAt", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learningStartedAt = 5000;
        meta.firewall.commandsObserved = 10;
      });

      const fw = await setFirewallMode("disabled");
      assert.equal(fw.mode, "disabled");
      // learningStartedAt and commandsObserved are preserved (not reset) when leaving learning
      assert.equal(fw.learningStartedAt, 5000);
      assert.equal(fw.commandsObserved, 10);
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox increments commandsObserved by number of log lines", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat",
      "npm http fetch GET 200 https://registry.npmjs.org/express",
      "some other command without a domain",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.commandsObserved = 5;
      });

      await ingestLearningFromSandbox(true);

      const fw = await getFirewallState();
      // 5 existing + 3 log lines = 8
      assert.equal(fw.commandsObserved, 8);
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox increments commandsObserved even when no domains are found", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = "ls -la\necho hello";
    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.commandsObserved = 0;
      });

      await ingestLearningFromSandbox(true);

      const fw = await getFirewallState();
      assert.equal(fw.commandsObserved, 2);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// DOMAIN_PRESETS tests
// ===========================================================================

test("DOMAIN_PRESETS contains at least 4 presets with non-empty domain lists", () => {
  const keys = Object.keys(DOMAIN_PRESETS);
  assert.ok(keys.length >= 4, `Expected ≥4 presets, got ${keys.length}`);
  for (const key of keys) {
    const preset = DOMAIN_PRESETS[key];
    assert.ok(preset.label.length > 0, `Preset ${key} should have a label`);
    assert.ok(preset.domains.length > 0, `Preset ${key} should have at least one domain`);
    for (const domain of preset.domains) {
      assert.ok(domain.includes("."), `Domain ${domain} in preset ${key} should be a valid hostname`);
    }
  }
});

test("DOMAIN_PRESETS domains can be approved via approveDomains", async () => {
  await withFirewallTestStore(async () => {
    const fw = await approveDomains(DOMAIN_PRESETS.npm.domains);
    for (const domain of DOMAIN_PRESETS.npm.domains) {
      assert.ok(fw.allowlist.includes(domain), `Expected ${domain} in allowlist`);
    }
  });
});

// ===========================================================================
// ensureMetaShape migration tests for new fields
// ===========================================================================

test("ensureMetaShape: migrates metadata missing learningStartedAt and commandsObserved", () => {
  const old = {
    _schemaVersion: 1,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: ["example.com"],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      // No learningStartedAt or commandsObserved
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(old);
  assert.ok(result);
  assert.equal(result.firewall.learningStartedAt, null);
  assert.equal(result.firewall.commandsObserved, 0);
});

// ===========================================================================
// Same-mode idempotency tests
// ===========================================================================

test("setFirewallMode is a no-op when requested mode equals current mode", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learningStartedAt = 5000;
        meta.firewall.commandsObserved = 42;
        meta.firewall.updatedAt = 9000;
      });

      const fw = await setFirewallMode("learning");

      // Mode unchanged, learning counters preserved (not reset)
      assert.equal(fw.mode, "learning");
      assert.equal(fw.learningStartedAt, 5000);
      assert.equal(fw.commandsObserved, 42);

      // No sync should have been triggered
      assert.equal(ctrl.appliedPolicies.length, 0);
    } finally {
      ctrl.restore();
    }
  });
});

test("setFirewallMode is a no-op for disabled → disabled", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // default mode is disabled

      const fw = await setFirewallMode("disabled");
      assert.equal(fw.mode, "disabled");
      assert.equal(ctrl.appliedPolicies.length, 0);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// Single sync per mode change (no double sync)
// ===========================================================================

test("setFirewallMode syncs sandbox policy exactly once per mode change", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();

      await setFirewallMode("learning");
      assert.equal(ctrl.appliedPolicies.length, 1, "Expected exactly 1 sync for mode change");

      // Same mode again — no additional sync
      await setFirewallMode("learning");
      assert.equal(ctrl.appliedPolicies.length, 1, "Expected no additional sync for same-mode no-op");
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// removeDomains rejects emptying allowlist while enforcing
// ===========================================================================

test("removeDomains rejects with 409 when removal would empty allowlist while enforcing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    await assert.rejects(
      removeDomains(["api.openai.com"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    // Allowlist should be unchanged
    const fw = await getFirewallState();
    assert.deepEqual(fw.allowlist, ["api.openai.com"]);
  });
});

test("removeDomains allows partial removal while enforcing (non-empty result)", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
    });

    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["vercel.com"]);
  });
});

test("removeDomains allows emptying allowlist when mode is not enforcing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, []);
  });
});

// ===========================================================================
// computeWouldBlock deduplicates learned domains
// ===========================================================================

test("computeWouldBlock deduplicates when learned list contains duplicate domain entries", () => {
  const state = {
    mode: "learning" as const,
    allowlist: [],
    learned: [
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 3, lastSeenAt: 4, hitCount: 2 },
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  const result = computeWouldBlock(state);
  assert.deepEqual(result, ["api.openai.com", "cdn.vercel.com"]);
});

test("ensureMetaShape: preserves existing learningStartedAt and commandsObserved", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      learningStartedAt: 5000,
      commandsObserved: 42,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.equal(result.firewall.learningStartedAt, 5000);
  assert.equal(result.firewall.commandsObserved, 42);
});

// ===========================================================================
// Structured logging: logWarn before ApiError throws
// ===========================================================================

test("setFirewallMode to enforcing with empty allowlist emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    // Clear the default-seeded allowlist so the empty-allowlist guard is tested
    await mutateMeta((meta) => {
      meta.firewall.allowlist = [];
    });
    _resetLogBuffer();
    await assert.rejects(
      setFirewallMode("enforcing"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "FIREWALL_ALLOWLIST_EMPTY",
    );
    assert.ok(warnLog, "Expected logWarn with FIREWALL_ALLOWLIST_EMPTY before throw");
    assert.equal(warnLog.message, "firewall.mode_change_failed");
  });
});

test("approveDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      approveDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

test("removeDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      removeDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

test("removeDomains emptying allowlist while enforcing emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    _resetLogBuffer();
    await assert.rejects(
      removeDomains(["api.openai.com"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "FIREWALL_ALLOWLIST_EMPTY",
    );
    assert.ok(warnLog, "Expected logWarn with FIREWALL_ALLOWLIST_EMPTY before throw");
  });
});

test("dismissLearnedDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      dismissLearnedDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

// ===========================================================================
// Structured logging: ingestion skip reasons
// ===========================================================================

test("ingestLearningFromSandbox returns skip reason when mode is not learning", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // mode = disabled

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, false);
      assert.equal(result.reason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox returns skip reason when sandbox is not running", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.status = "stopped";
    });

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "sandbox-not-running");
  });
});

test("ingestLearningFromSandbox acquires the learning lock with the active instance id", async () => {
  await withFirewallTestStore(async () => {
    await withInstanceId("fork-a", async () => {
      const ctrl = installSucceedingSandboxController();
      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.mode = "learning";
        });

        const storeModule = await import("@/server/store/store");
        const store = storeModule.getStore();
        const originalAcquireLock = store.acquireLock.bind(store);
        const originalReleaseLock = store.releaseLock.bind(store);
        const acquiredKeys: string[] = [];
        const releasedKeys: string[] = [];

        store.acquireLock = async (key, ttlSeconds) => {
          acquiredKeys.push(key);
          return originalAcquireLock(key, ttlSeconds);
        };
        store.releaseLock = async (key, token) => {
          releasedKeys.push(key);
          return originalReleaseLock(key, token);
        };

        try {
          await ingestLearningFromSandbox(true);
        } finally {
          store.acquireLock = originalAcquireLock;
          store.releaseLock = originalReleaseLock;
        }

        assert.deepEqual(acquiredKeys, [learningLockKey()]);
        assert.deepEqual(releasedKeys, [learningLockKey()]);
      } finally {
        ctrl.restore();
      }
    });
  });
});

// ===========================================================================
// Request correlation: requestId passed through mutation functions
// ===========================================================================

test("setFirewallMode includes requestId in log entries", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await setFirewallMode("learning", { requestId: "req-abc-123" });

    const logs = getServerLogs();
    const modeChangeLog = logs.find(
      (e) => e.message === "firewall.mode_change_requested" && e.data?.requestId === "req-abc-123",
    );
    assert.ok(modeChangeLog, "Expected firewall.mode_change_requested log with requestId");
  });
});

// ===========================================================================
// FirewallIngestOutcome and FirewallSyncOutcome
// ===========================================================================

test("computePolicyHash: deterministic — same inputs produce same hash", () => {
  const h1 = computePolicyHash("enforcing", ["b.com", "a.com"]);
  const h2 = computePolicyHash("enforcing", ["a.com", "b.com"]);
  assert.equal(h1, h2, "Hash must be deterministic regardless of allowlist order");
  assert.equal(h1.length, 64, "SHA-256 hex should be 64 chars");
});

test("computePolicyHash: different mode produces different hash", () => {
  const h1 = computePolicyHash("enforcing", ["a.com"]);
  const h2 = computePolicyHash("disabled", ["a.com"]);
  assert.notEqual(h1, h2, "Different modes must produce different hashes");
});

test("computePolicyHash: different allowlist produces different hash", () => {
  const h1 = computePolicyHash("enforcing", ["a.com"]);
  const h2 = computePolicyHash("enforcing", ["a.com", "b.com"]);
  assert.notEqual(h1, h2, "Different allowlists must produce different hashes");
});

test("syncFirewallPolicyIfRunning returns FirewallSyncOutcome with policyHash", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      const outcome = await syncFirewallPolicyIfRunning();
      assert.equal(typeof outcome.timestamp, "number");
      assert.equal(typeof outcome.durationMs, "number");
      assert.equal(typeof outcome.allowlistCount, "number");
      assert.equal(typeof outcome.policyHash, "string");
      assert.equal(outcome.policyHash.length, 64);
      assert.equal(typeof outcome.applied, "boolean");
      assert.equal(typeof outcome.reason, "string");
    } finally {
      ctrl.restore();
    }
  });
});

test("syncFirewallPolicyIfRunning persists lastSyncOutcome in metadata", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      await syncFirewallPolicyIfRunning();
      const state = await getFirewallState();
      assert.ok(state.lastSyncOutcome, "lastSyncOutcome should be persisted");
      assert.equal(state.lastSyncOutcome.applied, true);
      assert.equal(state.lastSyncOutcome.reason, "policy-applied");
      assert.equal(state.lastSyncOutcome.policyHash.length, 64);
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox returns FirewallIngestOutcome with timing", async () => {
  await withFirewallTestStore(async () => {
    // Mode not learning — should return skip outcome
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // mode = disabled
      const result = await ingestLearningFromSandbox(true);
      const outcome = result.outcome;
      assert.equal(typeof outcome.timestamp, "number");
      assert.equal(typeof outcome.durationMs, "number");
      assert.equal(outcome.domainsSeenCount, 0);
      assert.equal(outcome.newCount, 0);
      assert.equal(outcome.updatedCount, 0);
      assert.equal(outcome.skipReason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox persists lastIngestOutcome in metadata", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      await ingestLearningFromSandbox(true);
      const state = await getFirewallState();
      assert.ok(state.lastIngestOutcome, "lastIngestOutcome should be persisted");
      assert.equal(state.lastIngestOutcome.skipReason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ensureMetaShape: migrates old metadata without lastIngestOutcome/lastSyncOutcome", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      learningStartedAt: 5000,
      commandsObserved: 42,
      // No lastIngestOutcome or lastSyncOutcome — simulates old data
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.equal(result.firewall.lastIngestOutcome, null);
  assert.equal(result.firewall.lastSyncOutcome, null);
});

test("ensureMetaShape: is idempotent — running twice produces identical output", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: ["a.com"],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const first = ensureMetaShape(existing);
  assert.ok(first);
  const second = ensureMetaShape(first);
  assert.ok(second);
  assert.deepEqual(first, second, "ensureMetaShape must be idempotent");
});

test("ensureMetaShape: preserves valid FirewallIngestOutcome and FirewallSyncOutcome", () => {
  const ingestOutcome = {
    timestamp: 1000,
    durationMs: 50,
    domainsSeenCount: 3,
    newCount: 2,
    updatedCount: 1,
    skipReason: null,
  };
  const syncOutcome = {
    timestamp: 2000,
    durationMs: 100,
    allowlistCount: 5,
    policyHash: "a".repeat(64),
    applied: true,
    reason: "policy-applied",
  };

  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      lastIngestOutcome: ingestOutcome,
      lastSyncOutcome: syncOutcome,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.deepEqual(result.firewall.lastIngestOutcome, ingestOutcome);
  assert.deepEqual(result.firewall.lastSyncOutcome, syncOutcome);
});
