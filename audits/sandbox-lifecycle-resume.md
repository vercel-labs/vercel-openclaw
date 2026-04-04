# Sandbox Lifecycle & Resume Edge Cases Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: Prelaunch-warning (no launch-blocking issues; several edge-case risks documented)

## Scope

- `src/server/sandbox/lifecycle.ts`
- `src/server/sandbox/controller.ts`
- `src/server/openclaw/bootstrap.ts`
- `src/server/openclaw/config.ts`
- `src/server/openclaw/restore-assets.ts`

## Findings

### PASS — Stale-operation recovery prevents permanent strand

- **Evidence**: `lifecycle.ts:258,3781-3782` (`isOperationStale`, 5-minute threshold on `updatedAt`)
- **Detail**: If a process crashes while status is `creating`, `setup`, `restoring`, or `booting`, the next `ensureSandboxReady` call detects the stale operation and re-triggers `scheduleLifecycleWork`. The 5-minute window is generous but prevents indefinite stranding.

### PASS — Lock-based concurrency for lifecycle and token refresh

- **Evidence**: `lifecycle.ts:2277` (`withAutoRenewedLock`), `lifecycle.ts:151-166` (TTL constants)
- **Detail**: `LIFECYCLE_LOCK_TTL_SECONDS=1200` (20 min), `START_LOCK_TTL_SECONDS=900` (15 min), `TOKEN_REFRESH_LOCK_TTL_SECONDS=60`. Renewal interval is `min(LOCK_RENEW_INTERVAL_MS, ttl/2)`. Locks prevent concurrent create/restore operations across serverless instances.

### PASS — 404/410 on stop triggers clean state reset

- **Evidence**: `lifecycle.ts:689-709`
- **Detail**: When `sandbox.stop()` throws with a 404 or 410 (platform-timed-out sandbox), status is set to `uninitialized` and `sandboxId` is cleared. This correctly handles the common edge case of a sandbox that has already been reclaimed by the platform.

### PASS — Two-stage readiness (local + public)

- **Evidence**: `lifecycle.ts` restore flow, `bootstrap.ts:499`
- **Detail**: After restore, readiness is checked locally via `curl http://localhost:3000/` inside the sandbox, then via the proxied public URL. This separates sandbox boot failures from proxy/DNS issues and prevents masking one failure with another.

### PASS — Manifest-based static asset skipping

- **Evidence**: `restore-assets.ts:195-211`
- **Detail**: Static files are only rewritten when the SHA-256 of the restore asset manifest changes. This avoids redundant uploads on repeat resumes when the app version hasn't changed.

### WARN — Lock renewal failure does not abort in-progress work

- **Evidence**: `lifecycle.ts:3681-3700`
- **Severity**: P2 (medium)
- **Detail**: `withAutoRenewedLock` sets `stopRenewal = true` and logs a warning when `renewLock` returns false, but the in-progress function continues executing. The lock expires naturally, allowing another process to acquire it. Two processes may then run competing lifecycle operations (e.g., concurrent restores). Only a `logWarn` is emitted; no abort signal is sent.
- **Recommended fix**: Propagate the renewal failure via an `AbortSignal` that lifecycle work checks at each phase boundary. If the lock is lost, abandon the in-progress operation cleanly.

### WARN — `readFileToBuffer` silently returns null for all errors

- **Evidence**: `controller.ts:130-135`
- **Severity**: P3 (low-medium)
- **Detail**: The `try/catch` around `sandbox.readFileToBuffer` catches all exceptions and returns `null`. Callers cannot distinguish a missing file from a network failure, a permission error, or a sandbox in a bad state. This affects cron job reads (`lifecycle.ts:558`), token reads (`lifecycle.ts:2001`), and manifest reads (`lifecycle.ts:3461`).
- **Impact**: `readCronNextWakeFromSandbox` (`lifecycle.ts:554-601`) treats `null` as "no jobs file" and returns `{ status: "no-jobs" }`, causing cron wake time to be deleted from the store. A transient read failure would silently disable cron wake.
- **Recommended fix**: Have `readFileToBuffer` throw on non-404 errors so callers can distinguish file-not-found from transient failures. Or return a discriminated result type.

### WARN — Cron restore failure leaves sandbox running without jobs

- **Evidence**: `lifecycle.ts:3275-3283` (approximate; within `restoreSandboxFromSnapshot`)
- **Severity**: P2 (medium)
- **Detail**: If writing cron jobs back to the sandbox after restore fails, `cronRestoreOutcome` is set to `"restore-failed"` and a warning is logged, but the sandbox continues to `running` status. Scheduled jobs are silently lost until the next heartbeat or manual intervention.
- **Recommended fix**: Surface `cronRestoreOutcome` failures in the admin UI status panel and/or log at `error` level rather than `warn`.

### WARN — Gateway accepts 5xx as "ready"

- **Evidence**: `bootstrap.ts:499`, `config.ts:747` (fast-restore script readiness check)
- **Severity**: P2 (medium)
- **Detail**: Both the TypeScript `waitForGatewayReady` probe and the shell-script readiness check accept any HTTP response (including 500) as "ready." A gateway that starts but immediately crashes on every request is marked as healthy, and the sandbox transitions to `running`.
- **Recommended fix**: Tighten the readiness check to require a 2xx response, or at minimum reject 5xx. If backward compatibility is a concern, add a health-check endpoint to the gateway.

### WARN — `cleanupBeforeSnapshot` failure is best-effort

- **Evidence**: `lifecycle.ts:509-547`
- **Severity**: P3 (low)
- **Detail**: If pre-snapshot cleanup fails (e.g., sandbox command errors), only a `logWarn` is emitted. The snapshot is taken with stale logs, npm cache, and temp files. This wastes snapshot storage but doesn't break functionality.
- **Recommended fix**: No code change needed for launch. Consider logging the cleanup failure at `error` level and tracking snapshot size metrics.

### WARN — Cron heartbeat bookkeeping errors swallowed entirely

- **Evidence**: `lifecycle.ts:1554-1556`
- **Severity**: P3 (low)
- **Detail**: The blank `catch {}` around cron-wake bookkeeping in `touchRunningSandbox` means any failure to persist cron wake times is silently dropped. The comment says this is intentional to avoid breaking the heartbeat, but it means cron wake can drift without any signal.
- **Recommended fix**: Add `logWarn` inside the catch to surface the failure without breaking the heartbeat.

### WARN — Hot-spare post-stop pre-create errors fully swallowed

- **Evidence**: `lifecycle.ts:670-686` (approximate)
- **Severity**: P3 (low)
- **Detail**: After stopping a sandbox, a hot-spare pre-create is attempted. Failures are only logged as `logWarn`. A failed pre-create leaves stale hot-spare metadata in the store until the next promotion attempt discovers it.
- **Recommended fix**: No code change needed for launch. The next promotion evaluates the candidate freshness and rejects stale entries.

### WARN — Proxy origin excluded from gateway config hash

- **Evidence**: `config.ts:442,451-464`
- **Severity**: P3 (low)
- **Detail**: `computeGatewayConfigHash` uses a synthetic `"https://proxy.invalid"` for `proxyOrigin`, so changes to the actual proxy URL (e.g., domain migration) do not invalidate the hash. The sandbox continues with stale `allowedOrigins` until another config field changes.
- **Recommended fix**: Include the real `proxyOrigin` in the hash, or document the current behavior as an intentional trade-off for restore stability.

### WARN — Firewall sync failure during enforcing restore can leave sandbox running without policy

- **Evidence**: `lifecycle.ts` restore flow (firewall application runs as a concurrent promise)
- **Severity**: P2 (medium)
- **Detail**: During restore, firewall application runs concurrently with the fast-restore script. If firewall sync fails in `enforcing` mode, the sandbox is stopped and status is set to `error`. However, if the stop also fails, the sandbox is left running without firewall enforcement. Status is set to `error` and `sandboxId` is cleared, so it won't serve new traffic — but any in-flight requests may reach an unprotected sandbox.
- **Recommended fix**: Verify the stop succeeded before clearing `sandboxId`. If stop fails, escalate the log level to `error` with the sandbox ID for manual investigation.

### PASS — Background static asset sync is fire-and-forget but retry-safe

- **Evidence**: `lifecycle.ts` restore flow (`.then(...).catch(...)` pattern)
- **Detail**: Background asset sync uses fire-and-forget. If it fails, `runtimeAssetSha256` is not updated, so the next restore retries the sync. The operator only sees a warning log; there is no status change. This is acceptable for non-critical static assets.

### PASS — Circuit breaker on AI Gateway token refresh

- **Evidence**: `lifecycle.ts:1814` (BREAKER_FAILURE_THRESHOLD=3, BREAKER_OPEN_DURATION_MS=30s)
- **Detail**: After 3 consecutive refresh failures, the circuit breaker opens for 30 seconds. During this time, requests use stale tokens and the next 401 from the gateway re-triggers refresh. This prevents refresh storms.

## Recommended Fixes (ranked by severity)

### P2 — Address before launch

1. **Lock renewal → abort signal**: Propagate lock loss to in-progress work so competing operations cannot run concurrently. (`lifecycle.ts:3681-3700`)
2. **Cron restore failure surfacing**: Log at `error` level and surface in admin UI when `cronRestoreOutcome` is `"restore-failed"`. (`lifecycle.ts:3275-3283`)
3. **Gateway readiness 5xx**: Tighten readiness check to reject 5xx responses. (`bootstrap.ts:499`, `config.ts:747`)
4. **Firewall sync failure during enforcing restore**: Verify stop succeeded before clearing `sandboxId`. (`lifecycle.ts` restore flow)

### P3 — Post-launch improvements

5. **`readFileToBuffer` error discrimination**: Return a discriminated result type instead of `null` for all errors. (`controller.ts:130-135`)
6. **Cron heartbeat bookkeeping logging**: Add `logWarn` in the blank catch. (`lifecycle.ts:1554-1556`)
7. **Proxy origin in config hash**: Include real `proxyOrigin` or document the trade-off. (`config.ts:442`)
8. **Cleanup-before-snapshot severity**: Consider `logError` instead of `logWarn`. (`lifecycle.ts:509-547`)

## Release Recommendation

**Prelaunch-warning**: No launch-blocking issues found. The lifecycle subsystem has robust stale-operation recovery, distributed locking, two-stage readiness, and circuit-breaker protection. The P2 items (lock renewal abort, cron restore surfacing, 5xx readiness, firewall sync verification) represent edge cases that are unlikely in normal operation but could cause silent degradation under concurrent failures. None risk data loss or message dropping in the common case.
