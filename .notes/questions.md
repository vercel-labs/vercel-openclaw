# Sandbox Lifecycle Audit — Open Questions

These are behaviors where the code does *something*, but it's ambiguous whether that's the intended design or an accident. Each needs a human decision before tests are written that might protect bugs.

---

## State transition ambiguities

### 1. Snapshotting stale guardrail threshold

When you click Stop, the sandbox enters `snapshotting` while Vercel auto-snapshots in the background. If nothing changes for 5 minutes, the system force-transitions to `stopped` so the user isn't blocked forever. **Is 5 minutes the right threshold?** The SDK itself has no timeout at all — `blocking: true` polls every 500ms indefinitely. A large sandbox filesystem could legitimately take longer than 5 minutes to snapshot.

**Context:** `lifecycle.ts:161` — `STALE_OPERATION_MS = 5 * 60 * 1000`. Used by `reconcileSnapshottingStatus()` at line 1853.

### 2. Gateway liveness failure asymmetry

`touchRunningSandbox()` runs an internal `curl localhost:3000` liveness check. If the curl returns a bad HTTP code, the sandbox is immediately marked unavailable. But if the `runCommand` itself throws (exception, not bad exit code), it only logs a warning and does NOT mark unavailable. **Is this asymmetry intentional?** A transient `runCommand` failure could indicate the same condition as a bad HTTP code.

**Context:** `lifecycle.ts:1682-1707` — liveness check logic.

### 3. Error vs stopped on markSandboxUnavailable

When `markSandboxUnavailable()` is called, it transitions to `stopped` if there's a `snapshotId`, or `error` if there isn't. A brand-new sandbox with no snapshot that loses its gateway goes to `error` (scary in the UI, needs manual intervention), while an older sandbox just goes to `stopped` (clean, auto-recoverable). **Is this the right distinction?**

**Context:** `lifecycle.ts:862-881` — `markSandboxUnavailable()`.

### 4. Resume failure wipes snapshot history

When resuming a persistent sandbox via `get()` and it returns an unhealthy status (failed/error/aborted), the code deletes the sandbox and falls through to `create()`. But it also clears all snapshot metadata (snapshotId, snapshotConfigHash, etc.). **Is it correct to lose the snapshot history?** The snapshots still exist in Vercel — only the SDK handle was bad.

**Context:** `lifecycle.ts:2721-2734` — unhealthy handle fallback.

### 5. Flat 5-minute stale threshold for all statuses

`isOperationStale()` uses a flat 5-minute threshold for `creating`, `setup`, `restoring`, `booting`, and `snapshotting`. **Should these have different thresholds?** A fresh create with npm install could legitimately take >5 min, while a fast-restore should never take that long.

**Context:** `lifecycle.ts:3437-3439` — `isOperationStale()`.

---

## Concurrency and race conditions

### 6. Two concurrent gateway requests during auto-sleep

Gateway calls `touchRunningSandbox()` which discovers the sandbox is gone and calls `markSandboxUnavailable()`. Then it calls `ensureSandboxRunning()` with `schedule: after`. If two requests hit this simultaneously, the `startLock` prevents double-create but metadata could flap between `stopped/error` and `restoring`. **Is the deduplication sufficient?**

**Context:** `src/app/gateway/[[...path]]/route.ts:92-143` — gateway proxy flow.

### 7. Watchdog and gateway racing on health reconciliation

The watchdog runs `reconcileSandboxHealth()` on a failing probe, and the gateway runs it on a 410 response. Both can schedule lifecycle work. The `startLock` prevents double-create, but **can the watchdog's repair conflict with a gateway-triggered repair?** Both could mark unavailable with different reasons.

**Context:** `watchdog/run.ts:326-349` and `gateway route.ts:211-224`.

### 8. Channel webhook reconcile + ensureSandboxReady ordering

When a Telegram message arrives for a sleeping sandbox, the webhook route calls `reconcileStaleRunningStatus()` (metadata-only), then the workflow calls `ensureSandboxReady()` (blocks until running). **Is there a window where the reconcile hasn't finished but `ensureSandboxReady` reads stale metadata?** Both are async awaits, so probably not, but the ordering assumption is implicit.

**Context:** `src/app/api/channels/telegram/webhook/route.ts:267-268` and `src/server/workflows/channels/drain-channel-workflow.ts:237-241`.

---

## Cron wake behavior

### 9. Partial cron jobs.json reads

`touchRunningSandbox()` reads `jobs.json` on every heartbeat. The code avoids writing empty/null records. **But what about a partial write?** If OpenClaw is mid-write when the heartbeat reads, we could persist a corrupted record. The SHA-256 comparison prevents overwriting with the same hash, but not with a different-but-corrupted hash.

**Context:** `lifecycle.ts:1714-1740` — heartbeat cron persistence.

### 10. Cron wake key retained on certain outcomes

After waking a sandbox, the watchdog only clears `cronNextWakeMs` if the outcome is `no-store-jobs`, `already-present`, or `restored-verified`. If the outcome is `store-invalid` or undefined, the key is retained, meaning the watchdog will try to wake again on the next tick. **Is this intentional retry behavior or a potential infinite wake loop?**

**Context:** `watchdog/run.ts:366-391` — cron wake clear logic.

### 11. Disabled cron jobs treatment

`stopSandbox()` clears cron jobs from the store when there are no jobs. But if all jobs are disabled, `readCronNextWakeFromSandbox` finds no enabled jobs with `nextRunAtMs`, while `buildCronRecord` still sees `parsed.jobs.length > 0`. So disabled jobs get persisted but don't generate a wake time. **Should disabled jobs be treated as "no jobs"?**

**Context:** `lifecycle.ts:700-717` — `readCronNextWakeFromSandbox()`.

---

## Platform interaction edge cases

### 12. Timeout estimation vs SDK reality

The timeout estimate uses `lastAccessedAt + sleepAfterMs - now`. But the platform's actual timeout is the SDK's `sandbox.timeout` property. These can diverge if `extendTimeout()` fails, the platform clock differs, or another process resumed the sandbox. **Is estimation good enough?** Currently the live SDK check only happens with `?health=1`.

**Context:** `timeout.ts:39-48` — `estimateSandboxTimeoutRemainingMs()`.

### 13. Hot-spare pre-creation during snapshotting

After `stopSandbox()`, the code calls `preCreateHotSpare()` before the snapshot has finished (status is `snapshotting`). The hot-spare just pre-creates a blank persistent sandbox, not from the snapshot. **Is it safe to create a hot-spare while the primary sandbox is still snapshotting?**

**Context:** `lifecycle.ts:805-823` — post-stop hot-spare.

### 14. Pending sandbox status on resume

When `get()` returns a handle with status `pending`, it's not in the `unhealthyStatuses` set (`failed`, `error`, `aborted`). A sandbox stuck in `pending` would be treated as resumable, and every subsequent `runCommand` would presumably hang. **Should `pending` be considered unhealthy?**

**Context:** `lifecycle.ts:2695-2696` — `unhealthyStatuses`.

---

## Config reconciliation

### 15. Dirty flag race with restore oracle

`ensureRunningSandboxDynamicConfigFresh()` sets `restorePreparedStatus = "dirty"` before the rewrite succeeds. The watchdog's restore oracle checks this flag. **Can the oracle snapshot the sandbox in the window between the dirty flag and the actual config rewrite completing?**

**Context:** `lifecycle.ts:1131-1147` — dirty flag timing.

### 16. Gateway restart readiness check

`syncGatewayConfigToSandbox()` polls `curl localhost:3000 | grep 'openclaw-app'` with a 15-second timeout after restart. **Is 15 seconds enough? And does the root marker guarantee that specific new routes (e.g., `/slack/events`) are registered?**

**Context:** `lifecycle.ts:972-987` — config sync readiness poll.

---

## Token refresh

### 17. Circuit breaker duration

The circuit breaker opens after 3 failures and stays open for 30 seconds. During those 30 seconds, all requests needing a fresh token fail. **Is 30 seconds the right duration?** If OIDC is down for longer, the breaker creates a burst pattern (close → fail 3x → open 30s → repeat) rather than graceful degradation.

**Context:** `lifecycle.ts:168-169` — `BREAKER_FAILURE_THRESHOLD = 3`, `BREAKER_OPEN_DURATION_MS = 30_000`.

### 18. Token TTL survives reset

`clearSandboxRuntimeStateForReset()` doesn't clear `lastTokenExpiresAt`. If metadata is carried forward through a reset, **could stale TTL values cause wrong refresh decisions?**

**Context:** `lifecycle.ts:3279-3312` — `clearSandboxRuntimeStateForReset()`.

---

## Testing gaps

### 19. No test for touchRunningSandbox detecting sandbox gone via SDK status

The test at line 3475 covers `controller.get()` throwing, but not the case where `get()` succeeds but `sandbox.status !== "running"` (line 1626-1635). This is how the platform auto-sleep is detected.

### 20. No test for gateway 410 → reconcileSandboxHealth

The route-scenarios tests cover auth, waiting page, and proxy pass-through, but not the 410 recovery path.

### 21. No test for ensureSandboxRunning when running but timeout expired

The code at line 355-378 checks timeout and calls `reconcileSandboxHealth`. This is how the app discovers platform auto-sleep during a gateway request.

### 22. No test for gateway sandbox_lost_after_touch path

When `touchRunningSandbox` marks the sandbox unavailable and the gateway re-calls `ensureSandboxRunning` (line 133-143).

### 23. No test for channel webhook → sandbox wake flow

The `reconcileStaleRunningStatus()` → `drainChannelWorkflow.ensureSandboxReady()` path is the primary way Telegram/Slack messages wake a sleeping sandbox.

### 24. No test for reconcileSnapshottingStatus stale guardrail

The test at line 477 checks that status stays `snapshotting` when SDK is still in progress, but doesn't test the >5 minute stale guardrail forcing transition to `stopped`.

### 25. No test for hot-spare promotion fallthrough

The hot-spare promotion path in `createAndBootstrapSandboxWithinLifecycleLock` (line 2653-2677) falls through on failure, but there's no test verifying fallthrough to normal `get()`/`create()`.

---

## Telegram webhook specifics

### 26. Suspicious empty 200 detection

The webhook route flags responses where `status === 200 && fastPathDurationMs < 150 && bodyLength === 0` as suspicious. It logs but still returns 200. **Is this heuristic correct?** A legitimate empty 200 could come from a message type the handler doesn't respond to. Should it trigger a fallback to the workflow?

**Context:** `src/app/api/channels/telegram/webhook/route.ts:222-245`.

### 27. Non-2xx from native handler still returns 200 to Telegram

Even 400/500 responses cause the webhook to return `{ ok: true }` to Telegram, preventing redelivery. Only network failures (fetch throws) fall through to the workflow. **Is it safe to assume the native handler "handled" the payload on any HTTP response?**

**Context:** `telegram/webhook/route.ts:225-257`.

### 28. Dedup lock TTL is 24 hours

If the first attempt succeeds, the lock persists for 24h. A legitimate Telegram redelivery within 24h would be silently dropped. **Is 24h the right window?**

**Context:** `telegram/webhook/route.ts:130` — `acquireLock(dedupKey, 24 * 60 * 60)`.

### 29. telegramListenerReady race with status

The fast path only activates when `lastRestoreMetrics.telegramListenerReady === true`. But `lastRestoreMetrics` is cleared on stop (telegramListenerReady set to false). **Is there a race between the sandbox becoming "running" and the metrics being recorded during fast-restore?**

**Context:** `telegram/webhook/route.ts:203-205` and `lifecycle.ts:797-802`.

### 30. Boot message not cleaned up on workflow start failure

The webhook sends "Waking up..." before starting the workflow. If the workflow start fails (500), the boot message persists but nothing happens. The dedup lock is released for redelivery, but the stale message stays. **Should it be cleaned up?**

**Context:** `telegram/webhook/route.ts:282-324` and `363-392`.

---

## Restore attestation and decision logic

### 31. Dead fallback code in attestation

Attestation uses `snapshotDynamicConfigHash ?? snapshotConfigHash` as a fallback. But `ensureMetaShape` already performs this fallback during hydration (types.ts:576-578), so `snapshotDynamicConfigHash` should always be populated. **Is the attestation-level fallback dead code?**

**Context:** `restore-attestation.ts:55-56`.

### 32. Duplicate reasons in restore decision

`buildRestoreDecision` starts with `attestation.reasons` and conditionally pushes runtime reasons. A consumer could see both `restore-target-dirty` and `snapshot-config-stale`. **Are these always redundant, or can they be independent?**

**Context:** `restore-attestation.ts:209-231`.

### 33. Oracle CAS check vs distributed lock

`beginOracleRun` throws on `status === "running"` as a CAS check via `mutateMeta`. For Redis this uses optimistic locking. **Can two concurrent watchdog invocations both read `status !== "running"` and both proceed?** If so, two destructive prepares could run simultaneously.

**Context:** `restore-oracle.ts:126-141`.

### 34. Launch-verify forces oracle with minIdleMs: 0

This bypasses the 5-minute idle check, meaning launch-verify can destructively snapshot a sandbox actively serving user traffic. **Is there a guard against disrupting an active session?** The sandbox stops during snapshot, breaking active WebSocket connections.

**Context:** `src/app/api/admin/launch-verify/route.ts:300-306`.

### 35. Legacy snapshots never considered reusable

`compareHash` returns `null` when the hash is empty/null ("unknown" freshness). Reusability requires `snapshotConfigFresh === true`. **So a snapshot from before hash tracking can never be reusable**, even if it's actually fresh. Is this intentional (force re-prepare of legacy snapshots)?

**Context:** `restore-attestation.ts:30-37` and `96-101`.

---

## HTML injection and heartbeat

### 36. Heartbeat only runs with open WebSockets

If the user has the OpenClaw UI open but no active chat (no WebSocket), the heartbeat never fires. The admin UI polls `GET /api/status` (5s), but GET does NOT call `touchRunningSandbox()` — only POST does. **So viewing the admin UI without an active chat won't keep the sandbox alive.** Is this intentional?

**Context:** `src/server/proxy/htmlInjection.ts:44-46` — `shouldHeartbeat()`.

### 37. Gateway token in WebSocket sub-protocol

The token is passed as `openclaw.gateway-token.<encoded_token>` in the Sec-WebSocket-Protocol header. **This may be logged by intermediate proxies or CDNs.** Is this an acceptable security trade-off?

**Context:** `htmlInjection.ts:109-118`.

---

## Redis and metadata

### 38. ensureMetaShape throws on instance ID mismatch

If Redis contains metadata from a different `OPENCLAW_INSTANCE_ID`, `ensureMetaShape` throws instead of returning null. **This would crash the app on every request until Redis is manually cleared.** Should this be a warning + null return instead?

**Context:** `src/shared/types.ts:550-554`.

---

## Worker sandboxes

### 39. Worker sandbox orphan cleanup

`executeWorkerSandbox` calls `sandbox.stop()` in a `finally` block. If the Vercel Function is killed mid-execution (timeout), the finally block may not run, leaving an orphaned worker running until its timeout (up to 45 min). **Is there a sweeper for orphaned workers?**

**Context:** `src/server/worker-sandboxes/execute.ts:199`.

### 40. Worker auth tied to main sandbox gatewayToken

`buildWorkerSandboxBearerToken()` hashes the main sandbox's `gatewayToken`. **If the main sandbox resets (new token), all in-flight worker requests become unauthorized.** Is this a concern for long-running tasks?

**Context:** `src/server/worker-sandboxes/auth.ts:5-11`.

---

## Snapshot history

### 41. Manual snapshot bypasses stopSandbox

`POST /api/admin/snapshots` calls `sandbox.snapshot()` directly — no pre-snapshot cleanup, no cron persistence, no hot-spare pre-creation. **Is this intentional?** The snapshot includes logs, temp files, and npm cache that the stop flow would have cleaned.

**Context:** `src/app/api/admin/snapshots/route.ts:49-70`.

### 42. Snapshot restore is a no-op in persistent model

`POST /api/admin/snapshots/restore` sets `snapshotId` but the v2 persistent model uses `get({ sandboxId })` which auto-resumes. **The snapshotId is never passed to the SDK.** "Restoring from snapshot X" actually just resumes the persistent sandbox, which may have diverged. Is this feature vestigial?

**Context:** `src/app/api/admin/snapshots/restore/route.ts:42-53`.

### 43. Duplicate snapshot IDs in history

`collectTrackedSnapshotIds` deduplicates, but during `resetSandbox`, if two history entries point to the same snapshotId, the second delete call would 404 (handled gracefully, but unnecessary).

**Context:** `lifecycle.ts:3184-3191`.
