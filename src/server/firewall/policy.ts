import type { NetworkPolicy } from "@vercel/sandbox";

import type { SingleMeta } from "@/shared/types";
import { logInfo } from "@/server/log";
import type { SandboxHandle } from "@/server/sandbox/controller";

export function toNetworkPolicy(
  mode: SingleMeta["firewall"]["mode"],
  allowlist: string[],
): NetworkPolicy {
  switch (mode) {
    case "enforcing":
      return { allow: [...allowlist].sort((left, right) => left.localeCompare(right)) };
    case "disabled":
    case "learning":
      return "allow-all";
  }
}

export async function applyFirewallPolicyToSandbox(
  sandbox: SandboxHandle,
  meta: SingleMeta,
): Promise<NetworkPolicy> {
  const policy = toNetworkPolicy(meta.firewall.mode, meta.firewall.allowlist);
  logInfo("firewall.sync_policy_applied", {
    operation: "sync",
    mode: meta.firewall.mode,
    allowlistCount: meta.firewall.allowlist.length,
  });
  await sandbox.updateNetworkPolicy(policy);
  return policy;
}
