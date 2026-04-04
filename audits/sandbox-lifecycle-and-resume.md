# Sandbox Lifecycle and Resume Audit

**Auditor**: Claude (automated)
**Date**: 2026-04-03
**Target**: Monday launch readiness
**Scope**: Sandbox create, resume, stop, reconnect, cron wake, failure handling

## Files Audited

| File | Lines | Focus |
|------|-------|-------|
| `src/server/sandbox/lifecycle.ts` | 3799 | Create, restore, stop, token refresh, health reconciliation, cron persistence |
| `src/server/sandbox/controller.ts` | 218 | SDK wrapper, test double injection |
| `src/server/openclaw/bootstrap.ts` | 599 | Full bootstrap (npm install, config write, gateway wait) |
| `src/server/openclaw/restore-assets.ts` | 257 | Static/dynamic file splits, manifest hashing |
| `src/server/openclaw/config.ts` | 3094 | Gateway config, fast-restore script, config hashing |
| `src/server/watchdog/run.ts` | 440 | Watchdog cron wake, stuck-state repair |
| `src/server/sandbox/lifecycle.test.ts` | (reviewed structure) | Test coverage map |
| `src/server/sandbox/cron-persistence.test.ts` | (reviewed structure) | Cron round-trip tests |

## Issues Summary

| ID | Severity | Status | Title | Location |
|----|----------|--------|-------|----------|
| SL-1 | P2 | warn | Dead `restoreSandboxFromSnapshot` function never called | `lifecycle.ts:2734` |
| SL-2 | P3 | warn | `reconcileStaleRunningStatus` maps all non-running SDK states to "stopped" | `lifecycle.ts:1601` |
| SL-3 | P2 | warn | Persistent resume path missing cron job restoration | `lifecycle.ts:2477-2601` |
| SL-4 | P3 | warn | Persistent resume path missing Telegram webhook re-registration | `lifecycle.ts:2477-2601` |
| SL-5 | P3 | pass | Lock renewal failure silently degrades | `lifecycle.ts:3700-3714` |
| SL-6 | P2 | warn | `probeGatewayReady` requires marker AND `response.ok` but bootstrap accepts any HTTP status | `lifecycle.ts:2088` vs `bootstrap.ts:499` |
| SL-7 | P3 | pass | Stop path swallows 404/410 as "already gone" based on string matching | `lifecycle.ts:695-696` |
| SL-8 | P1 | warn | No timeout on `sandbox.stop({ blocking: true })` call | `lifecycle.ts:658` |
| SL-9 | P3 | pass | Background static asset sync fire-and-forget with no retry | `lifecycle.ts:3323-3361` |
| SL-10 | P2 | pass | Config hash skip logic is robust and well-tested | `lifecycle.ts:2949-2952` |
| SL-11 | P3 | pass | Cron job heartbeat guards against transient empty writes | `lifecycle.ts:1539-1553` |
| SL-12 | P2 | warn | `markSandboxUnavailable` sets status to "stopped" when snapshot exists, masking the real error | `lifecycle.ts:736` |

## Detailed Findings

### SL-1: Dead `restoreSandboxFromSnapshot` function (P2 / warn)

**File**: `lifecycle.ts:2734-3443`

The function `restoreSandboxFromSnapshot` (711 lines) is defined as a private function but is never called from production code. It handles the full snapshot-based restore flow including:
- Config hash comparison and skip optimization
- Firewall policy overlap with boot
- Cron job restoration after restore
- Telegram webhook re-registration
- Background static asset sync
- Detailed restore metrics recording

The actual production code path goes through `createAndBootstrapSandboxWithinLifecycleLock` which uses `getSandboxController().get()` to auto-resume persistent sandboxes. This v2 persistent sandbox path is correct for the current architecture.

**Risk**: The dead code is not a bug per se since the persistent sandbox path works. However, the dead function contains capabilities (cron restore, Telegram reconciliation) that the live persistent resume path does NOT have -- see SL-3 and SL-4. Tests reference this function by name in comments but actually test `ensureSandboxRunning` which routes to `createAndBootstrapSandboxWithinLifecycleLock`.

**Recommendation**: After launch, remove the dead `restoreSandboxFromSnapshot` function and port its missing capabilities (cron restore, Telegram reconcile) to the persistent resume path. For launch, this is acceptable because cron restore and Telegram reconcile are handled by the snapshot-based restore path and the watchdog respectively.

### SL-2: `reconcileStaleRunningStatus` maps all non-running to "stopped" (P3 / warn)

**File**: `lifecycle.ts:1601-1604`

When the SDK reports a sandbox status other than "running" (e.g., "failed", "aborted", "stopping"), `reconcileStaleRunningStatus` unconditionally sets metadata status to "stopped" and clears `lastError`. This loses diagnostic information when a sandbox enters "failed" state.

```typescript
// Line 1601-1604
return mutateMeta((next) => {
  next.status = "stopped";
  next.lastError = null;
});
```

**Risk**: Low for launch. The "stopped" status is appropriate for the recovery flow since it triggers re-create on next ensure. Logging at line 1596-1599 captures the actual SDK status for diagnostics.

**Recommendation**: P3 -- consider preserving the SDK status as `lastError` for operator visibility. Not blocking for launch.

### SL-3: Persistent resume path missing cron job restoration (P2 / warn)

**File**: `lifecycle.ts:2477-2601`

The persistent resume path (`isResumed` branch in `createAndBootstrapSandboxWithinLifecycleLock`) does NOT include cron job restoration logic. The snapshot-based restore path (`restoreSandboxFromSnapshot`, which is dead code -- see SL-1) has full cron restore at lines 3217-3283.

**Risk**: When a persistent sandbox resumes and its `jobs.json` was lost (edge case: partial write during gateway restart, config re-init), the persistent resume path will not recover cron jobs from the store. The watchdog compensates partially: if the cron wake key exists, it will wake the sandbox, and the heartbeat path (`touchRunningSandbox`) will persist new cron state once the sandbox is running.

**Mitigation**: The persistent sandbox file system persists across stop/resume, so `jobs.json` loss during persistent resume is extremely rare. OpenClaw's gateway reads, normalizes, and writes back `jobs.json` on startup. The store-based backup is a belt-and-suspenders measure. For v2 persistent sandboxes, the gateway restart script does not wipe `jobs.json`.

**Recommendation**: Post-launch P2. Add cron restore logic to the persistent resume path to match the safety net in the dead snapshot restore path.

### SL-4: Persistent resume path missing Telegram webhook re-registration (P3 / warn)

**File**: `lifecycle.ts:2477-2601`

The persistent resume path does not call `reconcileTelegramIntegration({ force: true })` after resume. The dead snapshot restore path has this at lines 3303-3315.

**Risk**: After a persistent sandbox resumes, the Telegram webhook URL on Telegram's servers may be stale if a previous startup script called `deleteWebhook`. However, the persistent resume uses the `fast-restore-script` which does not call `deleteWebhook`, and OpenClaw's own startup flow re-registers the webhook. This is only a risk if the previous stop happened abnormally.

**Recommendation**: Post-launch P3. The watchdog probe will detect Telegram issues and trigger repair. Not launch-blocking.

### SL-5: Lock renewal failure silently degrades (P3 / pass)

**File**: `lifecycle.ts:3700-3714`

When lock renewal fails, the code sets `stopRenewal = true` and logs a warning but does NOT abort the running operation. The operation continues without lock protection.

**Risk**: In practice, this is correct behavior. Aborting mid-lifecycle would leave the sandbox in a worse state. The lock TTL (20 minutes for lifecycle, 15 minutes for start) provides a generous window. If renewal fails, it means either Upstash is down (operation should complete fast) or another process stole the lock (unlikely with proper token-based locking).

**Assessment**: Pass. Current behavior is the right tradeoff.

### SL-6: Readiness probe inconsistency between bootstrap and lifecycle (P2 / warn)

**File**: `lifecycle.ts:2088` vs `bootstrap.ts:499`

The `probeGatewayReady` function in lifecycle requires BOTH `response.ok` AND the `openclaw-app` marker:
```typescript
// lifecycle.ts:2088
const ready = response.ok && markerFound;
```

The `waitForGatewayReady` function in bootstrap accepts ANY HTTP response (even 500):
```typescript
// bootstrap.ts:499
if (hasMarker || (httpStatus > 0 && httpStatus < 600)) {
```

**Risk**: After restore, `probeGatewayReady` may report "not ready" if the gateway returns a non-2xx status (e.g., 500 during plugin init), even though the gateway IS running and the bootstrap would have accepted it. This creates a window where `waitForSandboxReady` polls longer than necessary.

The `config-sync-gateway-ready` poll (lifecycle.ts:837-846) uses `curl -f` with `grep -q 'openclaw-app'`, requiring both success AND marker -- consistent with the stricter check.

**Recommendation**: Post-launch P2. The probes will converge once the gateway finishes initializing. Not a launch blocker because the 5-minute ready timeout is generous, and the gateway typically returns 200 within seconds.

### SL-7: Stop path 404/410 detection via string matching (P3 / pass)

**File**: `lifecycle.ts:695-696`

```typescript
const isGone = message.includes("404") || message.includes("410");
```

**Risk**: String matching on error messages is fragile. An error message like "connection timeout after 404ms" would falsely match. However, `@vercel/sandbox` error messages for gone sandboxes reliably include HTTP status codes, and a false positive here is safe -- it just marks the sandbox as "uninitialized" rather than throwing.

**Assessment**: Pass. False positives are safe (lead to re-create). False negatives would throw, causing the caller to see an error -- also acceptable.

### SL-8: No timeout on `sandbox.stop({ blocking: true })` (P1 / warn)

**File**: `lifecycle.ts:658`

```typescript
await sandbox.stop({ blocking: true });
```

This call has no timeout wrapper. If the Vercel Sandbox API hangs during a blocking stop, the lifecycle lock will eventually expire (20 minutes), but the Vercel Function will hit `maxDuration` first (default 10s on Hobby, configurable on Pro).

**Risk**: On Vercel, the function will timeout and return 504 to the caller. The lifecycle lock remains held until TTL expiry (20 min). During this window, no other lifecycle operations can proceed. The next watchdog run will detect the stuck state (after 90 seconds threshold) and attempt repair.

The same issue exists at lines 2691, 3192, 3567 where `sandbox.stop({ blocking: true })` is called without a timeout.

**Mitigation**: The Vercel Function `maxDuration` acts as an implicit timeout. The watchdog's stuck-state detector (run.ts:172-212) handles recovery after 90 seconds. The auto-renewed lock interval (30 seconds) means the lock renewer runs at most once before the function dies.

**Recommendation**: Pre-launch P1 consideration. Wrap `sandbox.stop()` calls with `AbortSignal.timeout(30_000)` or `Promise.race` to fail fast. However, given the existing mitigation layers (function timeout + watchdog), this is survivable for launch.

### SL-9: Background static asset sync is fire-and-forget (P3 / pass)

**File**: `lifecycle.ts:3323-3361`

The background asset sync after snapshot restore runs as a detached promise (`.then()` / `.catch()`). If it fails, the error is logged but no retry is attempted. The next restore will re-attempt the sync.

**Assessment**: Pass. This is intentional -- the sync is off the hot path to keep restores fast. The gateway boots with cached scripts from the snapshot, which are functional even if slightly outdated. The watchdog's restore oracle will eventually seal a fresh snapshot.

### SL-10: Config hash skip logic (P2 / pass)

**File**: `lifecycle.ts:2949-2952`

The snapshot restore correctly uses `snapshotDynamicConfigHash` (snapshot-truth) rather than `runtimeDynamicConfigHash` (runtime-truth) for skip decisions. This prevents stale runtime state from causing false matches.

```typescript
const snapshotHash = latest.snapshotDynamicConfigHash ?? latest.snapshotConfigHash;
const skippedDynamicConfigSync = snapshotHash !== null && snapshotHash === currentConfigHash;
```

**Assessment**: Pass. This is correct and well-documented with inline comments.

### SL-11: Cron heartbeat transient-write guard (P3 / pass)

**File**: `lifecycle.ts:1539-1553`

The heartbeat path correctly guards against overwriting good cron data with transiently empty `jobs.json`:
- Only writes when a valid record with jobs exists
- Only overwrites when the hash has changed
- Does NOT clear the store when `buildCronRecord` returns null (which indicates empty/invalid data)

**Assessment**: Pass. This is robust against the documented edge cases.

### SL-12: `markSandboxUnavailable` status mapping (P2 / warn)

**File**: `lifecycle.ts:733-738`

```typescript
meta.status = meta.snapshotId ? "stopped" : "error";
meta.lastError = reason;
```

When a snapshot exists, `markSandboxUnavailable` sets status to "stopped" regardless of the actual failure reason. This means a sandbox that failed due to a network error will appear as cleanly "stopped" in the UI if a snapshot exists.

**Risk**: The next `ensureSandboxRunning` call will attempt to resume from the "stopped" state, which is the correct recovery action. However, the operator sees "stopped" instead of the actual failure reason as the status. The `lastError` field does carry the reason, but the status is misleading.

**Recommendation**: Post-launch P2. The current behavior leads to correct recovery. The `lastError` field preserves the diagnostic information.

## Positive Findings

1. **Distributed locking is well-implemented**: The lifecycle lock with auto-renewal, the start lock, and the token refresh lock use proper acquire/release patterns with TTL-based safety nets.

2. **Circuit breaker for token refresh**: The breaker pattern (3 consecutive failures, 30s open window) prevents thundering herd on OIDC outages.

3. **Stale operation detection**: The 5-minute stale threshold (`STALE_OPERATION_MS`) plus the watchdog's 90-second stuck detector provide two layers of stuck-state recovery.

4. **Fast-restore script integrity checks**: The script validates peer dependencies (`@buape/carbon`) and rejects stale snapshot content (`host-scheduler` skill) at startup, failing fast instead of serving broken state.

5. **Firewall enforcing mode fail-closed**: Both create and restore paths stop the sandbox and set error status when enforcing-mode firewall sync fails. This prevents an unsecured sandbox from serving traffic.

6. **Hot-spare promotion**: The hot-spare evaluation uses freshness gates (snapshot ID, config hash, asset hash) to prevent promoting a stale spare.

7. **Config hash versioning**: `GATEWAY_CONFIG_HASH_VERSION` allows invalidating all existing hashes when the hash algorithm changes.

## Release Recommendation

**GO with caveats.**

No P0 blockers found. The codebase has robust locking, recovery, and observability for the sandbox lifecycle. The main risk areas are:

1. **SL-8 (P1)**: The unbounded `sandbox.stop()` calls could cause lock contention during degraded Sandbox API conditions. The existing mitigations (function timeout, watchdog recovery) make this survivable but not ideal. Consider adding explicit timeouts pre-launch if time permits.

2. **SL-3 (P2)**: Cron job restoration is missing from the persistent resume path. This is mitigated by the fact that persistent sandbox filesystems survive stop/resume, making job loss during persistent resume extremely rare.

3. **SL-1 (P2)**: The dead `restoreSandboxFromSnapshot` function (711 lines) should be cleaned up post-launch to avoid confusion about which code path is actually running.

For a Monday launch, the existing watchdog, health reconciliation, and retry infrastructure provide sufficient safety nets around these issues. Monitor `watchdog.run_completed` logs and `sandbox.restore.cron_jobs_restore_failed` events in the first 48 hours.
