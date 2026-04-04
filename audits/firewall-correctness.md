# Firewall Correctness Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: Prelaunch-warning (enforcement model is correct; known bypass vectors are self-documented)

## Scope

- `src/server/firewall/domains.ts`
- `src/server/firewall/policy.ts`
- `src/server/firewall/state.ts`

## Intended Contract

The firewall operates in three modes:

| Mode | Sandbox Policy | Behavior |
|---|---|---|
| `disabled` | `allow-all` | No restrictions; no learning |
| `learning` | `allow-all` | All traffic allowed; shell command log is ingested to discover domains |
| `enforcing` | `{ allow: [...allowlist] }` | Only allowlisted domains reachable from the sandbox |

Domains are discovered through shell-command observation (not network traffic inspection), normalized to ASCII hostnames, and stored in metadata. The operator approves learned domains before they enter the allowlist. Transitioning to `enforcing` requires a non-empty allowlist.

## Findings

### PASS — Mode-to-policy mapping is correct

- **Evidence**: `policy.ts:7-18`
- **Detail**: `disabled` → `"allow-all"`, `learning` → `"allow-all"`, `enforcing` → `{ allow: [...sorted] }`. The mapping is straightforward and consistent with the documented contract.

### PASS — Enforcing mode requires non-empty allowlist

- **Evidence**: `state.ts:53-66` (`setFirewallMode`)
- **Detail**: Transitioning to `enforcing` with an empty allowlist throws `ApiError(409, "FIREWALL_ALLOWLIST_EMPTY")`. This prevents operators from accidentally locking out all egress.

### PASS — Domain removal cannot empty enforcing allowlist

- **Evidence**: `state.ts:159-172` (`removeDomains`)
- **Detail**: Removing domains that would result in an empty allowlist while in enforcing mode throws `ApiError(409)`. The check runs inside `mutateMeta`, so the mutation is aborted cleanly.

### PASS — Domain normalization is thorough

- **Evidence**: `domains.ts:22-91` (`normalizeDomain`)
- **Detail**: The pipeline handles Unicode dots, IDN conversion via `domainToASCII()`, IP address rejection, wildcard rejection, TLD validation, per-label constraints (max 63 chars, no leading/trailing hyphens), and ambiguous TLD filtering. The normalization is conservative — it rejects rather than guesses.

### PASS — Self-documented fundamental limitations

- **Evidence**: `state.ts:619-625` (`FIREWALL_LIMITATIONS`)
- **Detail**: Five fundamental bypass vectors are explicitly documented:
  1. Shell-command observation, not network traffic inspection
  2. Background/daemon traffic not captured
  3. IP-only connections bypass domain-based rules
  4. DNS-over-HTTPS is invisible
  5. Log truncation on each read means domains can only be learned once per ingest cycle

### WARN — Store committed before sandbox policy sync; failure leaves diverged state

- **Evidence**: `state.ts:52-78` (`setFirewallMode`), `state.ts:268-285` (`syncFirewallPolicyAfterMutation`)
- **Severity**: P2 (medium)
- **Detail**: When the operator changes mode (e.g., to `enforcing`), the new mode is written to the store first via `mutateMeta` (line 69), then `syncFirewallPolicyAfterMutation` applies it to the sandbox (line 78). If the sandbox API call fails, the store says `enforcing` but the sandbox is still running `allow-all`. The next status check will show the mode as `enforcing` even though traffic is not restricted.
- **Impact**: An operator who transitions to `enforcing` and sees the mode confirmed may believe traffic is restricted when it is not.
- **Recommended fix**: Either roll back the mode change on sync failure, or add a `lastSyncStatus` field to the admin UI that shows whether the current policy is actually applied. The `lastSyncFailedAt` timestamp already exists (`state.ts:335-351`) but is not surfaced in the UI.

### WARN — Enforcing mode silently unapplied when sandbox is not running

- **Evidence**: `state.ts:293-309` (`syncFirewallPolicyIfRunning`)
- **Severity**: P2 (medium)
- **Detail**: If the sandbox is not running when the mode changes to `enforcing`, the function records `applied: false, reason: "sandbox-not-running"` and returns without error. When the sandbox later starts via `ensureSandboxReady`, enforcement depends on whether `syncFirewallPolicyIfRunning` is called during the restore flow. The restore flow in `lifecycle.ts` does apply the firewall policy during restore — but if the sandbox was already running when the mode was changed and the sync failed, the "sandbox-not-running" path would not fire. The window exists between mode change and next restore.
- **Recommended fix**: Verify that the restore flow always syncs the latest policy from the store, not a cached value. Currently this appears correct (firewall sync uses fresh metadata), but add a test that covers: set mode to enforcing while stopped → start sandbox → verify policy is applied.

### WARN — Learning mode ingest truncates log before persisting

- **Evidence**: `state.ts:410-413` (`ingestLearningFromSandbox`)
- **Severity**: P2 (medium)
- **Detail**: The shell command reads and truncates the learning log in one atomic bash operation: `cat /tmp/shell-commands-for-learning.log; : > /tmp/shell-commands-for-learning.log`. If the sandbox call succeeds but the subsequent domain extraction or store write fails (e.g., `state.ts:530-546` catch), the log content is permanently lost. Domains that were in that log will not be rediscovered until the sandbox generates the same commands again.
- **Recommended fix**: Write to a separate file first (`mv` + create new), so the original log is preserved if persistence fails. Or accept this as a known limitation given the non-critical nature of learning mode.

### WARN — `toNetworkPolicy` does not re-validate allowlist contents

- **Evidence**: `policy.ts:12-13`
- **Severity**: P3 (low)
- **Detail**: The `allow` array is spread directly from `meta.firewall.allowlist` without passing through `normalizeDomain`. If data is written directly to the store (e.g., via manual Redis edit or a future admin API), arbitrary strings could end up in the sandbox network policy. All current code paths go through `approveDomains` which normalizes, so this is defense-in-depth only.
- **Recommended fix**: Add a `normalizeDomainList` pass in `toNetworkPolicy` as a safety net. Low priority.

### WARN — Stderr mixed with stdout during learning ingest

- **Evidence**: `state.ts:414` (`output("both")`)
- **Severity**: P3 (low)
- **Detail**: The ingest command collects both stdout and stderr. If the sandbox prints error messages to stderr (e.g., "permission denied"), those strings are passed to `extractDomainsWithContext` and may produce spurious domain matches.
- **Recommended fix**: Use `output("stdout")` only, or filter stderr lines before domain extraction.

### WARN — Ambiguous TLD list is finite and hardcoded

- **Evidence**: `domains.ts:20` (`AMBIGUOUS_TLDS`)
- **Severity**: P3 (low)
- **Detail**: The blocked TLDs (`get`, `js`, `json`, `log`, `mov`, `py`, `rs`, `ts`, `zip`) are hardcoded. Legitimate domains like `something.zip` (a real Google TLD) would be silently rejected. New ambiguous TLDs added to the DNS root would not be filtered.
- **Recommended fix**: Accept this as a conservative default. The learning flow surfaces rejected domains only as "not learned," and the operator can manually add legitimate ambiguous-TLD domains to the allowlist. Document this in the admin UI.

### PASS — Distributed lock on ingest prevents concurrent writes

- **Evidence**: `state.ts:404-406` (distributed lock with 10-second TTL)
- **Detail**: Only one serverless instance can run ingest at a time. The lock has a 10-second TTL, and ingest is throttled to once per 10 seconds (unless `force=true`). This prevents duplicate domain entries from concurrent polling.

### PASS — Promote-to-enforcing is atomic

- **Evidence**: `state.ts:189-229` (`promoteLearnedDomainsToEnforcing`)
- **Detail**: Merging learned domains into the allowlist, clearing learned, and setting mode to `enforcing` all happen in a single `mutateMeta` call. No intermediate state is visible.

## Recommended Fixes (ranked by severity)

### P2 — Address before launch

1. **Surface `lastSyncFailedAt` in admin UI**: Show operators whether the current firewall policy is actually applied to the sandbox, not just stored. (`state.ts:335-351`)
2. **Diverged store/sandbox state**: Either roll back mode on sync failure or add a visible "sync pending" indicator. (`state.ts:52-78`)
3. **Learning log truncation before persistence**: Document as a known limitation or implement a two-file swap. (`state.ts:410-413`)

### P3 — Post-launch improvements

4. **Re-validate allowlist in `toNetworkPolicy`**: Defense-in-depth normalization pass. (`policy.ts:12-13`)
5. **Separate stdout from stderr in ingest**: Prevent spurious domain matches. (`state.ts:414`)
6. **Document ambiguous TLD filtering**: Help operators understand why some domains are rejected. (`domains.ts:20`)

## Release Recommendation

**Prelaunch-warning**: The firewall enforcement model is correct and well-structured. The fundamental limitations (shell-command observation, no IP-based rules) are self-documented and acceptable for the stated use case. The P2 items (store/sandbox divergence, learning log truncation, missing UI indicator for sync status) are edge cases that could cause operator confusion but do not risk data exfiltration in the common case. The enforcing mode's actual sandbox-level restrictions work correctly when sync succeeds.
