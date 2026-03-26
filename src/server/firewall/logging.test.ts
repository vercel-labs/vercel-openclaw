import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";
import { approveDomains, setFirewallMode } from "@/server/firewall/state";
import type { SingleMeta } from "@/shared/types";

async function withLoggingTestStore(fn: () => Promise<void>): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
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

  _resetStoreForTesting();
  _resetLogBuffer();

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
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    _resetLogBuffer();
  }
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

function findLogIndex(message: string): number {
  return getServerLogs().findIndex((entry) => entry.message === message);
}

function installSucceedingSandboxController(
  assertBeforeApply: (policy: NetworkPolicy) => void | Promise<void>,
): { appliedPolicies: NetworkPolicy[]; restore(): void } {
  const appliedPolicies: NetworkPolicy[] = [];

  const controller: SandboxController = {
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
          return "https://sandbox-123.fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async updateNetworkPolicy(policy: NetworkPolicy) {
          await assertBeforeApply(policy);
          appliedPolicies.push(policy);
          return policy;
        },
        async readFileToBuffer() { return null; },
        async stop() {},
      } satisfies SandboxHandle;
    },
  };

  _setSandboxControllerForTesting(controller);
  return {
    appliedPolicies,
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

test("setFirewallMode logs requested before sandbox update and applied after sync completes", async () => {
  await withLoggingTestStore(async () => {
    const controller = installSucceedingSandboxController(() => {
      const messages = getServerLogs().map((entry) => entry.message);
      assert.ok(messages.includes("firewall.mode_change_requested"));
      assert.ok(messages.includes("firewall.policy_requested"));
      assert.ok(!messages.includes("firewall.policy_applied"));
      assert.ok(!messages.includes("firewall.mode_change_applied"));
    });

    try {
      await prepareRunningSandbox();
      await setFirewallMode("learning", { requestId: "req-mode-1" });

      assert.equal(controller.appliedPolicies.length, 1);
      assert.equal(controller.appliedPolicies[0], "allow-all");

      assert.ok(findLogIndex("firewall.mode_change_requested") >= 0);
      assert.ok(findLogIndex("firewall.policy_requested") > findLogIndex("firewall.mode_change_requested"));
      assert.ok(findLogIndex("firewall.policy_applied") > findLogIndex("firewall.policy_requested"));
      assert.ok(findLogIndex("firewall.sync_completed") > findLogIndex("firewall.policy_applied"));
      assert.ok(findLogIndex("firewall.mode_change_applied") > findLogIndex("firewall.sync_completed"));

      const appliedLog = getServerLogs().find((entry) => entry.message === "firewall.mode_change_applied");
      assert.equal(appliedLog?.data?.requestId, "req-mode-1");
    } finally {
      controller.restore();
    }
  });
});

test("approveDomains logs requested before sandbox update and applied after sync completes", async () => {
  await withLoggingTestStore(async () => {
    const controller = installSucceedingSandboxController((policy) => {
      const messages = getServerLogs().map((entry) => entry.message);
      assert.ok(messages.includes("firewall.domains_approved_requested"));
      assert.ok(messages.includes("firewall.policy_requested"));
      assert.ok(!messages.includes("firewall.policy_applied"));
      assert.ok(!messages.includes("firewall.domains_approved_applied"));
      assert.deepEqual(policy, { allow: ["api.openai.com", "vercel.com"] });
    });

    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com"];
      });
      await approveDomains(["VERCEL.COM"], { requestId: "req-approve-1" });

      assert.equal(controller.appliedPolicies.length, 1);
      assert.deepEqual(controller.appliedPolicies[0], { allow: ["api.openai.com", "vercel.com"] });

      assert.ok(findLogIndex("firewall.domains_approved_requested") >= 0);
      assert.ok(findLogIndex("firewall.policy_requested") > findLogIndex("firewall.domains_approved_requested"));
      assert.ok(findLogIndex("firewall.policy_applied") > findLogIndex("firewall.policy_requested"));
      assert.ok(findLogIndex("firewall.sync_completed") > findLogIndex("firewall.policy_applied"));
      assert.ok(findLogIndex("firewall.domains_approved_applied") > findLogIndex("firewall.sync_completed"));

      const appliedLog = getServerLogs().find(
        (entry) => entry.message === "firewall.domains_approved_applied",
      );
      assert.equal(appliedLog?.data?.requestId, "req-approve-1");
      assert.equal(appliedLog?.data?.count, 1);
    } finally {
      controller.restore();
    }
  });
});
