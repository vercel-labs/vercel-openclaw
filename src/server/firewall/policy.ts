import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

import type { SingleMeta } from "@/shared/types";
import { logInfo } from "@/server/log";
import type { SandboxHandle } from "@/server/sandbox/controller";

const AI_GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
export const CODEX_AUTH_DOMAIN = "auth.openai.com";
export const CODEX_INFERENCE_DOMAIN = "chatgpt.com";

/**
 * Hosts that `toNetworkPolicy()` always folds into the allow map when Codex
 * mode is active, regardless of user allowlist manipulation. These pair with
 * the `CODEX_SYSTEM_DOMAINS` re-export in `firewall/domains.ts` so the domain
 * module remains the single source of truth for system-allowed hosts.
 */
const CODEX_SYSTEM_DOMAINS = [CODEX_AUTH_DOMAIN, CODEX_INFERENCE_DOMAIN] as const;

/**
 * Build the network policy transform rules that inject an Authorization header
 * for requests to ai-gateway.vercel.sh.  Reused by both the main sandbox
 * firewall and worker sandbox creation.
 */
export function buildAiGatewayTransformRules(
  token: string,
): NetworkPolicyRule[] {
  return [
    {
      transform: [{ headers: { authorization: `Bearer ${token}` } }],
    },
  ];
}

export type ToNetworkPolicyOptions = {
  aiGatewayToken?: string;
  /**
   * When true, Codex mode is active: the AI Gateway header transform is
   * suppressed and the OpenAI inference/auth hosts are always included in
   * the allow map. When false/absent, behavior is byte-identical to legacy.
   */
  codexMode?: boolean;
};

export function toNetworkPolicy(
  mode: SingleMeta["firewall"]["mode"],
  allowlist: string[],
  aiGatewayTokenOrOptions?: string | ToNetworkPolicyOptions,
): NetworkPolicy {
  const options: ToNetworkPolicyOptions =
    typeof aiGatewayTokenOrOptions === "string"
      ? { aiGatewayToken: aiGatewayTokenOrOptions }
      : aiGatewayTokenOrOptions ?? {};

  const { aiGatewayToken, codexMode = false } = options;

  // Codex path: AI Gateway header transform is suppressed; OpenAI hosts are
  // always allowed regardless of user allowlist manipulation.
  if (codexMode) {
    switch (mode) {
      case "disabled":
      case "learning": {
        const allow: Record<string, NetworkPolicyRule[]> = {};
        for (const domain of CODEX_SYSTEM_DOMAINS) {
          allow[domain] = [];
        }
        allow["*"] = [];
        return { allow };
      }
      case "enforcing": {
        const allow: Record<string, NetworkPolicyRule[]> = {};
        for (const domain of [...allowlist].sort((a, b) => a.localeCompare(b))) {
          allow[domain] = [];
        }
        for (const domain of CODEX_SYSTEM_DOMAINS) {
          allow[domain] = [];
        }
        return { allow };
      }
    }
  }

  // When a token is provided, always use the object form so the transform
  // injects the Authorization header at the firewall layer — the credential
  // never enters the sandbox.
  if (aiGatewayToken) {
    const transformRules = buildAiGatewayTransformRules(aiGatewayToken);
    switch (mode) {
      case "disabled":
      case "learning": {
        // Functionally equivalent to "allow-all" but with credential injection.
        return {
          allow: {
            [AI_GATEWAY_DOMAIN]: transformRules,
            "*": [],
          },
        };
      }
      case "enforcing": {
        const allow: Record<string, NetworkPolicyRule[]> = {};
        for (const domain of [...allowlist].sort((a, b) => a.localeCompare(b))) {
          allow[domain] =
            domain === AI_GATEWAY_DOMAIN ? transformRules : [];
        }
        // Ensure ai-gateway is always reachable even if not in the user's allowlist.
        if (!(AI_GATEWAY_DOMAIN in allow)) {
          allow[AI_GATEWAY_DOMAIN] = transformRules;
        }
        return { allow };
      }
    }
  }

  // Legacy path: no token — return the simple form.
  switch (mode) {
    case "enforcing":
      return { allow: [...allowlist].sort((left, right) => left.localeCompare(right)) };
    case "disabled":
    case "learning":
      return "allow-all";
  }
}

export type ApplyFirewallPolicyOptions = {
  aiGatewayToken?: string;
  codexMode?: boolean;
};

export async function applyFirewallPolicyToSandbox(
  sandbox: SandboxHandle,
  meta: SingleMeta,
  aiGatewayTokenOrOptions?: string | ApplyFirewallPolicyOptions,
): Promise<NetworkPolicy> {
  const options: ApplyFirewallPolicyOptions =
    typeof aiGatewayTokenOrOptions === "string"
      ? { aiGatewayToken: aiGatewayTokenOrOptions }
      : aiGatewayTokenOrOptions ?? {};

  const { aiGatewayToken, codexMode = false } = options;

  const policy = toNetworkPolicy(meta.firewall.mode, meta.firewall.allowlist, {
    aiGatewayToken,
    codexMode,
  });
  logInfo("firewall.policy_requested", {
    operation: "sync",
    mode: meta.firewall.mode,
    allowlistCount: meta.firewall.allowlist.length,
    hasAiGatewayTransform: !codexMode && !!aiGatewayToken,
    codexMode,
  });
  await sandbox.updateNetworkPolicy(policy);
  logInfo("firewall.policy_applied", {
    operation: "sync",
    mode: meta.firewall.mode,
    allowlistCount: meta.firewall.allowlist.length,
    hasAiGatewayTransform: !codexMode && !!aiGatewayToken,
    codexMode,
  });
  return policy;
}
