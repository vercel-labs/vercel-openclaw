import { Sandbox } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { FirewallEvent, FirewallState, LearnedDomain } from "@/shared/types";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { extractDomains, normalizeDomainList } from "@/server/firewall/domains";
import { logWarn } from "@/server/log";

const EVENT_RETENTION = 200;
const LEARNED_RETENTION = 500;
const LEARNING_LOG_PATH = "/tmp/shell-commands-for-learning.log";
const LEARNING_LOCK_KEY = "openclaw-single:lock:learning-refresh";
const LEARNING_INGEST_INTERVAL_MS = 10_000;

export async function getFirewallState(): Promise<FirewallState> {
  return (await getInitializedMeta()).firewall;
}

export async function setFirewallMode(
  mode: FirewallState["mode"],
): Promise<FirewallState> {
  return (
    await mutateMeta((meta) => {
      if (mode === "enforcing" && meta.firewall.allowlist.length === 0) {
        throw new ApiError(
          409,
          "FIREWALL_ALLOWLIST_EMPTY",
          "Cannot enable enforcing mode with an empty allowlist.",
        );
      }

      meta.firewall.mode = mode;
      meta.firewall.updatedAt = Date.now();
    })
  ).firewall;
}

export async function approveDomains(domains: string[]): Promise<FirewallState> {
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  return (
    await mutateMeta((meta) => {
      const now = Date.now();
      const allowlist = new Set(meta.firewall.allowlist);
      for (const domain of normalized.valid) {
        allowlist.add(domain);
      }
      meta.firewall.allowlist = [...allowlist].sort((left, right) =>
        left.localeCompare(right),
      );
      meta.firewall.learned = meta.firewall.learned.filter(
        (entry) => !allowlist.has(entry.domain),
      );
      meta.firewall.updatedAt = now;
      prependFirewallEvent(meta.firewall, {
        id: eventId(),
        timestamp: now,
        action: "allowlist_updated",
        decision: "allowed",
        reason: `Approved ${normalized.valid.length} domain(s)`,
        source: "api",
      });
    })
  ).firewall;
}

export async function removeDomains(domains: string[]): Promise<FirewallState> {
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  return (
    await mutateMeta((meta) => {
      const now = Date.now();
      const removals = new Set(normalized.valid);
      meta.firewall.allowlist = meta.firewall.allowlist.filter(
        (domain) => !removals.has(domain),
      );
      meta.firewall.updatedAt = now;
      prependFirewallEvent(meta.firewall, {
        id: eventId(),
        timestamp: now,
        action: "allowlist_updated",
        decision: "allowed",
        reason: `Removed ${normalized.valid.length} domain(s)`,
        source: "api",
      });
    })
  ).firewall;
}

export async function promoteLearnedDomainsToEnforcing(): Promise<FirewallState> {
  return (
    await mutateMeta((meta) => {
      const learnedNames = meta.firewall.learned.map((entry) => entry.domain);
      const nextAllowlist = new Set([...meta.firewall.allowlist, ...learnedNames]);
      if (nextAllowlist.size === 0) {
        throw new ApiError(
          409,
          "FIREWALL_ALLOWLIST_EMPTY",
          "Cannot enable enforcing mode with an empty allowlist.",
        );
      }

      const now = Date.now();
      meta.firewall.allowlist = [...nextAllowlist].sort((left, right) =>
        left.localeCompare(right),
      );
      meta.firewall.learned = [];
      meta.firewall.mode = "enforcing";
      meta.firewall.updatedAt = now;
      prependFirewallEvent(meta.firewall, {
        id: eventId(),
        timestamp: now,
        action: "mode_updated",
        decision: "allowed",
        reason: `Promoted ${learnedNames.length} learned domain(s) to enforcing`,
        source: "api",
      });
    })
  ).firewall;
}

export async function syncFirewallPolicyIfRunning(): Promise<{
  applied: boolean;
  reason: string;
}> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || (meta.status !== "running" && meta.status !== "booting")) {
    return { applied: false, reason: "sandbox-not-running" };
  }

  const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
  await applyFirewallPolicyToSandbox(sandbox, meta);
  return { applied: true, reason: "policy-applied" };
}

export async function ingestLearningFromSandbox(
  force = false,
): Promise<{
  ingested: boolean;
  reason: string;
  domains: string[];
}> {
  const meta = await getInitializedMeta();
  if (meta.firewall.mode !== "learning") {
    return { ingested: false, reason: "mode-not-learning", domains: [] };
  }
  if (meta.status !== "running" || !meta.sandboxId) {
    return { ingested: false, reason: "sandbox-not-running", domains: [] };
  }
  if (
    !force &&
    meta.firewall.lastIngestedAt &&
    Date.now() - meta.firewall.lastIngestedAt < LEARNING_INGEST_INTERVAL_MS
  ) {
    return { ingested: false, reason: "throttled", domains: [] };
  }

  const store = getStore();
  const lockToken = await store.acquireLock(LEARNING_LOCK_KEY, 10);
  if (!lockToken) {
    return { ingested: false, reason: "locked", domains: [] };
  }

  try {
    const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
    const result = await sandbox.runCommand("bash", [
      "-lc",
      `if [ -f ${LEARNING_LOG_PATH} ]; then cat ${LEARNING_LOG_PATH}; : > ${LEARNING_LOG_PATH}; fi`,
    ]);
    const output = await result.output("both");
    const domains = extractDomains(output);

    await mutateMeta((next) => {
      next.firewall.lastIngestedAt = Date.now();
      if (domains.length === 0) {
        return;
      }

      const allowlist = new Set(next.firewall.allowlist);
      const learnedMap = new Map(
        next.firewall.learned.map((entry) => [entry.domain, { ...entry }]),
      );
      const now = Date.now();

      for (const domain of domains) {
        if (allowlist.has(domain)) {
          continue;
        }

        const current =
          learnedMap.get(domain) ??
          ({
            domain,
            firstSeenAt: now,
            lastSeenAt: now,
            hitCount: 0,
          } satisfies LearnedDomain);

        current.lastSeenAt = now;
        current.hitCount += 1;
        learnedMap.set(domain, current);

        prependFirewallEvent(next.firewall, {
          id: eventId(),
          timestamp: now,
          action: "domain_observed",
          decision: "learned",
          domain,
          reason: "Observed in shell command log while learning",
          source: "learning-log",
        });
      }

      next.firewall.learned = [...learnedMap.values()]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, LEARNED_RETENTION);
      next.firewall.updatedAt = now;
    });

    return {
      ingested: domains.length > 0,
      reason: domains.length > 0 ? "updated" : "no-domains",
      domains,
    };
  } catch (error) {
    logWarn("firewall.learning_ingest_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ingested: false, reason: "sandbox-read-failed", domains: [] };
  } finally {
    await store.releaseLock(LEARNING_LOCK_KEY, lockToken);
  }
}

function prependFirewallEvent(state: FirewallState, event: FirewallEvent): void {
  state.events = [event, ...state.events].slice(0, EVENT_RETENTION);
}

function eventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
