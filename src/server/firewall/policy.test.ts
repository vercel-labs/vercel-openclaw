/**
 * Tests for firewall/policy.ts — toNetworkPolicy and applyFirewallPolicyToSandbox.
 *
 * Covers all three firewall modes: disabled, learning, enforcing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicyRule } from "@vercel/sandbox";

import { createDefaultMeta } from "@/shared/types";
import { toNetworkPolicy, applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { FakeSandboxHandle, type SandboxEvent } from "@/test-utils/fake-sandbox-controller";

// ---------------------------------------------------------------------------
// toNetworkPolicy
// ---------------------------------------------------------------------------

test("policy: disabled mode returns allow-all", () => {
  const policy = toNetworkPolicy("disabled", []);
  assert.equal(policy, "allow-all");
});

test("policy: disabled mode ignores allowlist", () => {
  const policy = toNetworkPolicy("disabled", ["example.com", "api.github.com"]);
  assert.equal(policy, "allow-all");
});

test("policy: learning mode returns allow-all", () => {
  const policy = toNetworkPolicy("learning", []);
  assert.equal(policy, "allow-all");
});

test("policy: learning mode ignores allowlist", () => {
  const policy = toNetworkPolicy("learning", ["example.com"]);
  assert.equal(policy, "allow-all");
});

test("policy: enforcing mode returns sorted allow object", () => {
  const policy = toNetworkPolicy("enforcing", ["z.com", "a.com", "m.com"]);
  assert.deepEqual(policy, { allow: ["a.com", "m.com", "z.com"] });
});

test("policy: enforcing mode with empty allowlist returns empty allow array", () => {
  const policy = toNetworkPolicy("enforcing", []);
  assert.deepEqual(policy, { allow: [] });
});

test("policy: enforcing mode with single domain", () => {
  const policy = toNetworkPolicy("enforcing", ["only.com"]);
  assert.deepEqual(policy, { allow: ["only.com"] });
});

test("policy: enforcing mode does not mutate input array", () => {
  const original = ["z.com", "a.com"];
  const copy = [...original];
  toNetworkPolicy("enforcing", original);
  assert.deepEqual(original, copy, "input array should not be sorted in place");
});

// ---------------------------------------------------------------------------
// applyFirewallPolicyToSandbox
// ---------------------------------------------------------------------------

test("policy: applyFirewallPolicyToSandbox applies allow-all for disabled", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "disabled";

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.equal(result, "allow-all");
  assert.equal(handle.networkPolicies.length, 1);
  assert.equal(handle.networkPolicies[0], "allow-all");
});

test("policy: applyFirewallPolicyToSandbox applies allow-all for learning", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "learning";
  meta.firewall.allowlist = ["example.com"];

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.equal(result, "allow-all");
});

test("policy: applyFirewallPolicyToSandbox applies sorted allowlist for enforcing", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "enforcing";
  meta.firewall.allowlist = ["z.io", "a.io", "m.io"];

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.deepEqual(result, { allow: ["a.io", "m.io", "z.io"] });
  assert.deepEqual(handle.networkPolicies[0], { allow: ["a.io", "m.io", "z.io"] });
});

test("policy: applyFirewallPolicyToSandbox records event in handle log", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-ev", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "enforcing";
  meta.firewall.allowlist = ["x.com"];

  await applyFirewallPolicyToSandbox(handle, meta);

  const policyEvents = events.filter((e) => e.kind === "update_network_policy");
  assert.equal(policyEvents.length, 1);
});

// ---------------------------------------------------------------------------
// toNetworkPolicy with aiGatewayToken (header injection)
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-ai-gateway-token";
const expectedTransform = [
  { transform: [{ headers: { authorization: `Bearer ${TEST_TOKEN}` } }] },
];

test("policy: disabled mode with token returns object form with wildcard and transform", () => {
  const policy = toNetworkPolicy("disabled", [], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "*": [],
    },
  });
});

test("policy: disabled mode with token ignores allowlist", () => {
  const policy = toNetworkPolicy("disabled", ["example.com"], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "*": [],
    },
  });
});

test("policy: learning mode with token returns object form with wildcard and transform", () => {
  const policy = toNetworkPolicy("learning", ["example.com"], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "*": [],
    },
  });
});

test("policy: enforcing mode with token returns record form with transform on ai-gateway", () => {
  const policy = toNetworkPolicy("enforcing", ["api.openai.com", "ai-gateway.vercel.sh"], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "api.openai.com": [],
    },
  });
});

test("policy: enforcing mode with token ensures ai-gateway even when not in allowlist", () => {
  const policy = toNetworkPolicy("enforcing", ["registry.npmjs.org"], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "registry.npmjs.org": [],
      "ai-gateway.vercel.sh": expectedTransform,
    },
  });
});

test("policy: enforcing mode with token sorts domains", () => {
  const policy = toNetworkPolicy("enforcing", ["z.io", "a.io"], TEST_TOKEN);
  const keys = Object.keys((policy as { allow: Record<string, unknown> }).allow);
  // Sorted allowlist domains come first, then ai-gateway appended at end
  assert.deepEqual(keys, ["a.io", "z.io", "ai-gateway.vercel.sh"]);
});

test("policy: enforcing mode with token does not duplicate ai-gateway", () => {
  const policy = toNetworkPolicy("enforcing", ["ai-gateway.vercel.sh", "other.com"], TEST_TOKEN);
  const allow = (policy as { allow: Record<string, unknown> }).allow;
  const aiGatewayEntries = Object.keys(allow).filter(
    (k) => k === "ai-gateway.vercel.sh",
  );
  assert.equal(aiGatewayEntries.length, 1);
});

test("policy: enforcing mode with token and empty allowlist still includes ai-gateway", () => {
  const policy = toNetworkPolicy("enforcing", [], TEST_TOKEN);
  assert.deepEqual(policy, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
    },
  });
});

test("policy: applyFirewallPolicyToSandbox with token passes transform to handle", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-transform", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "disabled";

  const result = await applyFirewallPolicyToSandbox(handle, meta, TEST_TOKEN);
  assert.deepEqual(result, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "*": [],
    },
  });
  assert.deepEqual(handle.networkPolicies[0], result);
});

// ---------------------------------------------------------------------------
// Codex mode — AI Gateway transform suppressed + OpenAI hosts always allowed
// ---------------------------------------------------------------------------

// Codex off: assert behavior matches the legacy paths byte-for-byte.

test("policy: codexMode=false disabled matches legacy allow-all", () => {
  const legacy = toNetworkPolicy("disabled", ["example.com"]);
  const codexOff = toNetworkPolicy("disabled", ["example.com"], { codexMode: false });
  assert.deepEqual(codexOff, legacy);
  assert.equal(codexOff, "allow-all");
});

test("policy: codexMode=false learning matches legacy allow-all", () => {
  const legacy = toNetworkPolicy("learning", ["example.com"]);
  const codexOff = toNetworkPolicy("learning", ["example.com"], { codexMode: false });
  assert.deepEqual(codexOff, legacy);
  assert.equal(codexOff, "allow-all");
});

test("policy: codexMode=false enforcing matches legacy simple allow array", () => {
  const legacy = toNetworkPolicy("enforcing", ["b.com", "a.com"]);
  const codexOff = toNetworkPolicy("enforcing", ["b.com", "a.com"], { codexMode: false });
  assert.deepEqual(codexOff, legacy);
  assert.deepEqual(codexOff, { allow: ["a.com", "b.com"] });
});

// Codex on + disabled/learning: new shape with OpenAI hosts and catch-all.

test("policy: codexMode=true disabled returns OpenAI hosts + catch-all, no AI gateway transform", () => {
  const policy = toNetworkPolicy("disabled", ["example.com"], { codexMode: true });
  assert.deepEqual(policy, {
    allow: {
      "auth.openai.com": [],
      "chatgpt.com": [],
      "*": [],
    },
  });
  const allow = (policy as { allow: Record<string, NetworkPolicyRule[]> }).allow;
  assert.ok(!("ai-gateway.vercel.sh" in allow));
});

test("policy: codexMode=true learning returns OpenAI hosts + catch-all, no AI gateway transform", () => {
  const policy = toNetworkPolicy("learning", [], { codexMode: true });
  assert.deepEqual(policy, {
    allow: {
      "auth.openai.com": [],
      "chatgpt.com": [],
      "*": [],
    },
  });
});

test("policy: codexMode=true disabled ignores aiGatewayToken and emits no transform", () => {
  const policy = toNetworkPolicy("disabled", [], {
    codexMode: true,
    aiGatewayToken: TEST_TOKEN,
  });
  const allow = (policy as { allow: Record<string, NetworkPolicyRule[]> }).allow;
  assert.ok(!("ai-gateway.vercel.sh" in allow));
  for (const rules of Object.values(allow)) {
    for (const rule of rules) {
      assert.ok(
        !("transform" in rule),
        "codex mode must not emit transform rules even when a token is supplied",
      );
    }
  }
});

// Codex on + enforcing: allow contains OpenAI hosts with empty rules; no transform.

test("policy: codexMode=true enforcing merges OpenAI hosts with user allowlist", () => {
  const policy = toNetworkPolicy("enforcing", ["api.example.com", "registry.npmjs.org"], {
    codexMode: true,
  });
  assert.deepEqual(policy, {
    allow: {
      "api.example.com": [],
      "registry.npmjs.org": [],
      "auth.openai.com": [],
      "chatgpt.com": [],
    },
  });
});

test("policy: codexMode=true enforcing adds OpenAI hosts even when allowlist is empty", () => {
  const policy = toNetworkPolicy("enforcing", [], { codexMode: true });
  assert.deepEqual(policy, {
    allow: {
      "auth.openai.com": [],
      "chatgpt.com": [],
    },
  });
});

test("policy: codexMode=true enforcing does not emit ai-gateway transform even with token", () => {
  const policy = toNetworkPolicy("enforcing", ["ai-gateway.vercel.sh", "api.example.com"], {
    codexMode: true,
    aiGatewayToken: TEST_TOKEN,
  });
  const allow = (policy as { allow: Record<string, NetworkPolicyRule[]> }).allow;
  // ai-gateway can still appear (user put it in allowlist), but with no transform.
  if ("ai-gateway.vercel.sh" in allow) {
    assert.deepEqual(allow["ai-gateway.vercel.sh"], []);
  }
  // No rule in the map should carry a transform.
  for (const rules of Object.values(allow)) {
    for (const rule of rules) {
      assert.ok(
        !("transform" in rule),
        "codex mode must not emit transform rules even when a token is supplied",
      );
    }
  }
  assert.deepEqual(allow["auth.openai.com"], []);
  assert.deepEqual(allow["chatgpt.com"], []);
});

test("policy: codexMode=true enforcing cannot be bypassed by stripping OpenAI hosts from allowlist", () => {
  // Even if the user's allowlist tries to exclude the OpenAI hosts, the policy
  // layer folds them back in so Codex continues to function.
  const policy = toNetworkPolicy("enforcing", ["evil.example"], { codexMode: true });
  const allow = (policy as { allow: Record<string, NetworkPolicyRule[]> }).allow;
  assert.ok("auth.openai.com" in allow);
  assert.ok("chatgpt.com" in allow);
});

test("policy: applyFirewallPolicyToSandbox with codexMode option skips transform", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-codex", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "enforcing";
  meta.firewall.allowlist = ["api.example.com"];

  const result = await applyFirewallPolicyToSandbox(handle, meta, {
    aiGatewayToken: TEST_TOKEN,
    codexMode: true,
  });
  assert.deepEqual(result, {
    allow: {
      "api.example.com": [],
      "auth.openai.com": [],
      "chatgpt.com": [],
    },
  });
  assert.deepEqual(handle.networkPolicies[0], result);
});

test("policy: applyFirewallPolicyToSandbox preserves legacy string-token signature", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-legacy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "disabled";

  const result = await applyFirewallPolicyToSandbox(handle, meta, TEST_TOKEN);
  assert.deepEqual(result, {
    allow: {
      "ai-gateway.vercel.sh": expectedTransform,
      "*": [],
    },
  });
});
