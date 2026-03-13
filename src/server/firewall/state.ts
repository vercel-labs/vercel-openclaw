import { ApiError } from "@/shared/http";
import type { FirewallEvent, FirewallIngestOutcome, FirewallReport, FirewallState, FirewallSyncOutcome, LearnedDomain } from "@/shared/types";
import { computePolicyHash } from "@/shared/types";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import { applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { extractDomains, extractDomainsWithContext, groupByRegistrableDomain, normalizeDomainList } from "@/server/firewall/domains";
import { logInfo, logWarn } from "@/server/log";
import { getSandboxController } from "@/server/sandbox/controller";

const EVENT_RETENTION = 1000;
const LEARNED_RETENTION = 500;
const LEARNING_LOG_PATH = "/tmp/shell-commands-for-learning.log";
const LEARNING_LOCK_KEY = "openclaw-single:lock:learning-refresh";
const LEARNING_INGEST_INTERVAL_MS = 10_000;

export async function getFirewallState(): Promise<FirewallState> {
  const firewall = (await getInitializedMeta()).firewall;
  return { ...firewall, wouldBlock: computeWouldBlock(firewall) };
}

/**
 * Compute which learned domains would be blocked if enforcing were enabled.
 * Only meaningful in learning mode — returns [] for disabled/enforcing.
 */
export function computeWouldBlock(firewall: FirewallState): string[] {
  if (firewall.mode !== "learning") {
    return [];
  }
  const allowlist = new Set(firewall.allowlist);
  const seen = new Set<string>();
  return firewall.learned
    .filter((entry) => {
      if (allowlist.has(entry.domain) || seen.has(entry.domain)) return false;
      seen.add(entry.domain);
      return true;
    })
    .map((entry) => entry.domain)
    .sort((a, b) => a.localeCompare(b));
}

export async function setFirewallMode(
  mode: FirewallState["mode"],
  options?: { requestId?: string },
): Promise<FirewallState> {
  const current = (await getInitializedMeta()).firewall.mode;
  if (current === mode) {
    logInfo("firewall.mode_change_noop", { operation: "mode_change", mode, requestId: options?.requestId });
    return (await getInitializedMeta()).firewall;
  }

  logInfo("firewall.mode_change_started", { operation: "mode_change", from: current, to: mode, requestId: options?.requestId });
  const meta = await mutateMeta((meta) => {
    if (mode === "enforcing" && meta.firewall.allowlist.length === 0) {
      logWarn("firewall.mode_change_failed", {
        operation: "mode_change",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot enable enforcing with empty allowlist",
        mode,
        requestId: options?.requestId,
      });
      throw new ApiError(
        409,
        "FIREWALL_ALLOWLIST_EMPTY",
        "Cannot enable enforcing mode with an empty allowlist.",
      );
    }

    const now = Date.now();
    meta.firewall.mode = mode;
    meta.firewall.updatedAt = now;

    if (mode === "learning") {
      meta.firewall.learningStartedAt = now;
      meta.firewall.commandsObserved = 0;
      logInfo("firewall.mode_change_learning_started", { operation: "mode_change", learningStartedAt: now, requestId: options?.requestId });
    }
  });
  await syncFirewallPolicyAfterMutation("setFirewallMode", options?.requestId);
  return meta.firewall;
}

export async function approveDomains(
  domains: string[],
  options?: { requestId?: string },
): Promise<FirewallState> {
  logInfo("firewall.approve_started", { operation: "approve", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.approve_failed", {
      operation: "approve",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
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
  });
  logInfo("firewall.approve_completed", { operation: "approve", count: normalized.valid.length, requestId: options?.requestId });
  await syncFirewallPolicyAfterMutation("approveDomains", options?.requestId);
  return meta.firewall;
}

export async function removeDomains(
  domains: string[],
  options?: { requestId?: string },
): Promise<FirewallState> {
  logInfo("firewall.remove_started", { operation: "remove", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.remove_failed", {
      operation: "remove",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
    const now = Date.now();
    const removals = new Set(normalized.valid);
    const nextAllowlist = meta.firewall.allowlist.filter(
      (domain) => !removals.has(domain),
    );
    if (meta.firewall.mode === "enforcing" && nextAllowlist.length === 0) {
      logWarn("firewall.remove_failed", {
        operation: "remove",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot empty allowlist while enforcing",
        mode: meta.firewall.mode,
        requestId: options?.requestId,
      });
      throw new ApiError(
        409,
        "FIREWALL_ALLOWLIST_EMPTY",
        "Cannot empty the allowlist while enforcing mode is active.",
      );
    }
    meta.firewall.allowlist = nextAllowlist;
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "allowlist_updated",
      decision: "allowed",
      reason: `Removed ${normalized.valid.length} domain(s)`,
      source: "api",
    });
  });
  logInfo("firewall.remove_completed", { operation: "remove", count: normalized.valid.length, requestId: options?.requestId });
  await syncFirewallPolicyAfterMutation("removeDomains", options?.requestId);
  return meta.firewall;
}

export async function promoteLearnedDomainsToEnforcing(
  options?: { requestId?: string },
): Promise<FirewallState> {
  logInfo("firewall.promote_started", { operation: "promote", requestId: options?.requestId });
  const meta = await mutateMeta((meta) => {
    const learnedNames = meta.firewall.learned.map((entry) => entry.domain);
    const nextAllowlist = new Set([...meta.firewall.allowlist, ...learnedNames]);
    if (nextAllowlist.size === 0) {
      logWarn("firewall.promote_failed", {
        operation: "promote",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot promote with empty allowlist",
        requestId: options?.requestId,
      });
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
  });
  logInfo("firewall.promote_completed", { operation: "promote", requestId: options?.requestId });
  await syncFirewallPolicyAfterMutation("promoteLearnedDomainsToEnforcing", options?.requestId);
  return meta.firewall;
}

export async function dismissLearnedDomains(
  domains: string[],
  options?: { requestId?: string },
): Promise<FirewallState> {
  logInfo("firewall.dismiss_started", { operation: "dismiss", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.dismiss_failed", {
      operation: "dismiss",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
    const now = Date.now();
    const dismissals = new Set(normalized.valid);
    meta.firewall.learned = meta.firewall.learned.filter(
      (entry) => !dismissals.has(entry.domain),
    );
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "learned_dismissed",
      decision: "allowed",
      reason: `Dismissed ${normalized.valid.length} learned domain(s)`,
      source: "api",
    });
  });
  logInfo("firewall.dismiss_completed", { operation: "dismiss", count: normalized.valid.length, requestId: options?.requestId });
  return meta.firewall;
}

async function syncFirewallPolicyAfterMutation(mutation: string, requestId?: string): Promise<void> {
  try {
    await syncFirewallPolicyIfRunning({ requestId });
  } catch (error) {
    logWarn("firewall.sync_failed_after_mutation", {
      operation: "sync",
      code: "FIREWALL_SYNC_FAILED",
      reason: error instanceof Error ? error.message : String(error),
      mutation,
      requestId,
    });
    throw new ApiError(
      502,
      "FIREWALL_SYNC_FAILED",
      "Failed to sync firewall policy to the running sandbox.",
    );
  }
}

export async function syncFirewallPolicyIfRunning(
  options?: { requestId?: string },
): Promise<FirewallSyncOutcome> {
  const meta = await getInitializedMeta();
  const hash = computePolicyHash(meta.firewall.mode, meta.firewall.allowlist);

  if (!meta.sandboxId || (meta.status !== "running" && meta.status !== "booting")) {
    const reason = "sandbox-not-running";
    const outcome: FirewallSyncOutcome = {
      timestamp: Date.now(),
      durationMs: 0,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: false,
      reason,
    };
    logInfo("firewall.sync_skipped", { operation: "sync", reason, policyHash: hash, requestId: options?.requestId });
    await mutateMeta((m) => {
      m.firewall.lastSyncReason = reason;
      m.firewall.lastSyncOutcome = outcome;
    });
    return outcome;
  }

  const syncStart = Date.now();
  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    await applyFirewallPolicyToSandbox(sandbox, meta);
    const now = Date.now();
    const durationMs = now - syncStart;
    const outcome: FirewallSyncOutcome = {
      timestamp: now,
      durationMs,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: true,
      reason: "policy-applied",
    };
    logInfo("firewall.sync_completed", { operation: "sync", durationMs, policyHash: hash, allowlistCount: meta.firewall.allowlist.length, requestId: options?.requestId });
    await mutateMeta((m) => {
      m.firewall.lastSyncAppliedAt = now;
      m.firewall.lastSyncReason = "policy-applied";
      m.firewall.lastSyncOutcome = outcome;
    });
    return outcome;
  } catch (error) {
    const now = Date.now();
    const durationMs = now - syncStart;
    const reason = error instanceof Error ? error.message : String(error);
    const outcome: FirewallSyncOutcome = {
      timestamp: now,
      durationMs,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: false,
      reason,
    };
    logWarn("firewall.sync_failed", { operation: "sync", code: "SYNC_APPLY_ERROR", reason, durationMs, policyHash: hash, requestId: options?.requestId });
    await mutateMeta((m) => {
      m.firewall.lastSyncFailedAt = now;
      m.firewall.lastSyncReason = reason;
      m.firewall.lastSyncOutcome = outcome;
    });
    throw error;
  }
}

export async function ingestLearningFromSandbox(
  force = false,
  options?: { requestId?: string },
): Promise<{
  ingested: boolean;
  reason: string;
  domains: string[];
  outcome: FirewallIngestOutcome;
}> {
  const ingestStart = Date.now();

  const makeSkipOutcome = (skipReason: string): FirewallIngestOutcome => ({
    timestamp: Date.now(),
    durationMs: Date.now() - ingestStart,
    domainsSeenCount: 0,
    newCount: 0,
    updatedCount: 0,
    skipReason,
  });

  const meta = await getInitializedMeta();
  if (meta.firewall.mode !== "learning") {
    logInfo("firewall.ingest_skipped", { operation: "ingest", reason: "mode-not-learning", mode: meta.firewall.mode, requestId: options?.requestId });
    const outcome = makeSkipOutcome("mode-not-learning");
    await persistIngestionSkip("mode-not-learning", outcome);
    return { ingested: false, reason: "mode-not-learning", domains: [], outcome };
  }
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("firewall.ingest_skipped", { operation: "ingest", reason: "sandbox-not-running", status: meta.status, requestId: options?.requestId });
    const outcome = makeSkipOutcome("sandbox-not-running");
    await persistIngestionSkip("sandbox-not-running", outcome);
    return { ingested: false, reason: "sandbox-not-running", domains: [], outcome };
  }
  if (
    !force &&
    meta.firewall.lastIngestedAt &&
    Date.now() - meta.firewall.lastIngestedAt < LEARNING_INGEST_INTERVAL_MS
  ) {
    logInfo("firewall.ingest_skipped", { operation: "ingest", reason: "throttled", lastIngestedAt: meta.firewall.lastIngestedAt, requestId: options?.requestId });
    const outcome = makeSkipOutcome("throttled");
    await persistIngestionSkip("throttled", outcome);
    return { ingested: false, reason: "throttled", domains: [], outcome };
  }

  const store = getStore();
  const lockToken = await store.acquireLock(LEARNING_LOCK_KEY, 10);
  if (!lockToken) {
    logInfo("firewall.ingest_skipped", { operation: "ingest", reason: "locked", requestId: options?.requestId });
    const outcome = makeSkipOutcome("locked");
    await persistIngestionSkip("locked", outcome);
    return { ingested: false, reason: "locked", domains: [], outcome };
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const result = await sandbox.runCommand("bash", [
      "-lc",
      `if [ -f ${LEARNING_LOG_PATH} ]; then cat ${LEARNING_LOG_PATH}; : > ${LEARNING_LOG_PATH}; fi`,
    ]);
    const output = await result.output("both");
    const logLineCount = output.split("\n").filter((line) => line.trim().length > 0).length;
    const enriched = extractDomainsWithContext(output);
    const domains = enriched.map((entry) => entry.domain);
    if (domains.length > 0) {
      logInfo("firewall.ingest_domains_learned", {
        operation: "ingest",
        count: domains.length,
        domains: enriched.map((e) => ({
          domain: e.domain,
          category: e.category,
          sourceCommand: e.sourceCommand,
        })),
        requestId: options?.requestId,
      });
    }

    const contextMap = new Map(enriched.map((e) => [e.domain, e]));
    let newCount = 0;
    let updatedCount = 0;

    await mutateMeta((next) => {
      next.firewall.lastIngestedAt = Date.now();
      next.firewall.commandsObserved += logLineCount;
      next.firewall.lastIngestionSkipReason = null;
      next.firewall.ingestionSkipCount = 0;
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

        const ctx = contextMap.get(domain);
        const existing = learnedMap.get(domain);
        const current =
          existing ??
          ({
            domain,
            firstSeenAt: now,
            lastSeenAt: now,
            hitCount: 0,
          } satisfies LearnedDomain);

        if (existing) {
          updatedCount += 1;
        } else {
          newCount += 1;
        }

        current.lastSeenAt = now;
        current.hitCount += 1;

        if (ctx) {
          const existingCategories = new Set(current.categories ?? []);
          existingCategories.add(ctx.category);
          current.categories = [...existingCategories];
        }

        learnedMap.set(domain, current);

        prependFirewallEvent(next.firewall, {
          id: eventId(),
          timestamp: now,
          action: "domain_observed",
          decision: "learned",
          domain,
          reason: "Observed in shell command log while learning",
          source: "learning-log",
          sourceCommand: ctx?.sourceCommand,
          category: ctx?.category,
        });
      }

      next.firewall.learned = [...learnedMap.values()]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, LEARNED_RETENTION);
      next.firewall.updatedAt = now;
    });

    const outcome: FirewallIngestOutcome = {
      timestamp: Date.now(),
      durationMs: Date.now() - ingestStart,
      domainsSeenCount: domains.length,
      newCount,
      updatedCount,
      skipReason: null,
    };

    await mutateMeta((m) => {
      m.firewall.lastIngestOutcome = outcome;
    });

    logInfo("firewall.ingest_completed", {
      operation: "ingest",
      durationMs: outcome.durationMs,
      domainsSeenCount: outcome.domainsSeenCount,
      newCount: outcome.newCount,
      updatedCount: outcome.updatedCount,
      requestId: options?.requestId,
    });

    return {
      ingested: domains.length > 0,
      reason: domains.length > 0 ? "updated" : "no-domains",
      domains,
      outcome,
    };
  } catch (error) {
    logWarn("firewall.ingest_failed", {
      operation: "ingest",
      code: "SANDBOX_READ_FAILED",
      reason: error instanceof Error ? error.message : String(error),
      requestId: options?.requestId,
    });
    const outcome: FirewallIngestOutcome = {
      timestamp: Date.now(),
      durationMs: Date.now() - ingestStart,
      domainsSeenCount: 0,
      newCount: 0,
      updatedCount: 0,
      skipReason: "sandbox-read-failed",
    };
    await mutateMeta((m) => {
      m.firewall.lastIngestOutcome = outcome;
    });
    return { ingested: false, reason: "sandbox-read-failed", domains: [], outcome };
  } finally {
    await store.releaseLock(LEARNING_LOCK_KEY, lockToken);
  }
}

async function persistIngestionSkip(reason: string, outcome: FirewallIngestOutcome): Promise<void> {
  await mutateMeta((m) => {
    m.firewall.lastIngestionSkipReason = reason;
    m.firewall.ingestionSkipCount += 1;
    m.firewall.lastIngestOutcome = outcome;
  });
}

export type FirewallDiagnostics = {
  mode: FirewallState["mode"];
  learningHealth: {
    durationMs: number | null;
    commandsObserved: number;
    uniqueDomains: number;
    lastIngestedAt: number | null;
    stalenessMs: number | null;
  };
  syncStatus: {
    lastAppliedAt: number | null;
    lastFailedAt: number | null;
    lastReason: string | null;
  };
  ingestionStatus: {
    lastSkipReason: string | null;
    consecutiveSkips: number;
  };
  wouldBlockCount: number;
};

export async function getFirewallDiagnostics(): Promise<FirewallDiagnostics> {
  const fw = await getFirewallState();
  const now = Date.now();

  const isLearning = fw.mode === "learning";

  return {
    mode: fw.mode,
    learningHealth: {
      durationMs:
        isLearning && fw.learningStartedAt !== null
          ? now - fw.learningStartedAt
          : null,
      commandsObserved: fw.commandsObserved,
      uniqueDomains: fw.learned.length,
      lastIngestedAt: fw.lastIngestedAt,
      stalenessMs:
        isLearning && fw.lastIngestedAt !== null
          ? now - fw.lastIngestedAt
          : null,
    },
    syncStatus: {
      lastAppliedAt: fw.lastSyncAppliedAt,
      lastFailedAt: fw.lastSyncFailedAt,
      lastReason: fw.lastSyncReason,
    },
    ingestionStatus: {
      lastSkipReason: fw.lastIngestionSkipReason,
      consecutiveSkips: fw.ingestionSkipCount,
    },
    wouldBlockCount: fw.wouldBlock.length,
  };
}

const FIREWALL_LIMITATIONS: string[] = [
  "Learning is based on shell command text observation, not actual network traffic inspection.",
  "Domains accessed by background processes or daemons may not be captured.",
  "IP-only connections bypass domain-based firewall rules.",
  "DNS-over-HTTPS traffic is not observable through shell log inspection.",
  "Learning log is truncated on each read — domains only appear once per ingest cycle.",
];

export async function getFirewallReport(): Promise<FirewallReport> {
  const fw = await getFirewallState();
  const diagnostics = await getFirewallDiagnostics();
  const hash = computePolicyHash(fw.mode, fw.allowlist);

  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    state: fw,
    diagnostics,
    groupedLearned: groupByRegistrableDomain(fw.learned),
    wouldBlock: fw.wouldBlock,
    lastIngest: fw.lastIngestOutcome,
    lastSync: fw.lastSyncOutcome,
    limitations: FIREWALL_LIMITATIONS,
    policyHash: hash,
  };
}

function prependFirewallEvent(state: FirewallState, event: FirewallEvent): void {
  state.events = [event, ...state.events].slice(0, EVENT_RETENTION);
}

function eventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
