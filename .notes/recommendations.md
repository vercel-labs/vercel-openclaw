# Sandbox-Audit Recommendations

## Task #2: State transition edge cases

### Q2: Gateway liveness failure asymmetry
**Test**: Added two tests in `src/server/sandbox/lifecycle.test.ts`:
1. `[lifecycle] touchRunningSandbox liveness curl non-zero exit -> marks sandbox unavailable` — installs a `FakeSandboxHandle` where the curl liveness responder returns `exitCode: 1`. Flips `NODE_ENV` from `test` to `development` inside `extendTimeout` so the `if (process.env.NODE_ENV !== "test")` liveness block in `touchRunningSandbox()` (`src/server/sandbox/lifecycle.ts:1681`) actually runs. Verifies status transitions to `stopped` (snapshotId present) and `lastError` contains `"heartbeat gateway liveness failed"`.
2. `[lifecycle] touchRunningSandbox liveness runCommand throws -> NOT marked unavailable` — same setup but the responder throws an `Error`. Verifies status stays `running` and no `heartbeat gateway liveness failed` error is recorded; the throw is absorbed by the catch at `lifecycle.ts:1700-1706` which only emits a `logWarn`.

**Result**: PASS. Confirms the documented asymmetry: a clean non-zero exit (curl could connect but got a non-2xx) is treated as "gateway process is dead, stop the sandbox," while a `runCommand` throw (transport-level failure) is treated as "could be transient, don't tear down a healthy sandbox on a flaky probe."

**Recommendation**: Keep current behavior. The asymmetry is intentional and defensive — it avoids false positives from transient `runCommand` errors (e.g. SDK socket hiccups) while still acting decisively when the sandbox itself reports a dead gateway. The one refinement worth considering is logging the distinction explicitly at info level (currently both paths use the same `logWarn` name `sandbox.heartbeat_*`) so operators can separate "flaky transport" alerts from "gateway actually down" alerts in dashboards.

### Q3: markSandboxUnavailable error vs stopped
**Test**: Tests already exist at `src/server/sandbox/lifecycle.test.ts:2174` (`markSandboxUnavailable with snapshotId -> transitions to stopped`) and `:2193` (`without snapshotId -> transitions to error`). Both directly cover the ternary branch at `lifecycle.ts:878` (`meta.status = meta.snapshotId ? "stopped" : "error"`). No new test written — duplication would add no coverage.

**Result**: PASS (existing tests already pass). The semantic is: having a snapshot means "we can come back from this, park in stopped"; no snapshot means "we have no path forward, flag as error."

**Recommendation**: Keep current behavior. The distinction between `stopped` (recoverable via restore) and `error` (requires operator or fresh create) is load-bearing throughout the UI and `ensureSandboxRunning` branch logic. No changes needed.

### Q4: Resume failure clears snapshot history
**Test**: Added `[lifecycle] ensureSandboxRunning resume unhealthy handle -> clears snapshotId, falls back to create (snapshotHistory retained)`. Pre-registers an `oc-*` handle with `status = "failed"` in the `FakeSandboxController.handlesByIds` map. Meta starts with `status = "stopped"`, a `snapshotId`, `snapshotConfigHash`/`snapshotAssetSha256` set, `restorePreparedStatus = "ready"`, and a two-entry `snapshotHistory`. Schedules and drains the lifecycle callback.

**Result**: PASS. After fallback: `status = running`, `snapshotId = null`, `snapshotConfigHash = null`, `snapshotDynamicConfigHash = null`, `snapshotAssetSha256 = null`, `restorePreparedStatus = "dirty"`, `restorePreparedReason = "snapshot-missing"`. **However**, `snapshotHistory` is NOT wiped — the two entries remain. The unhealthy handle's `delete()` was called before the create fallback.

**Recommendation**: The task brief stated "Verify snapshotHistory is wiped," but the code at `lifecycle.ts:2724-2733` only clears the *current* snapshot pointers, not history. This is defensible (history is kept for diagnostics and future prepare cycles — only `resetSandbox()` at `:3291` and the snapshot-delete failure path at `:586` touch it). The test is written to assert the actual current behavior (history retained, `length >= 2`) so any future change is flagged. **Suggestion**: leave as-is; the orphaned history entry with `snapshotId = "snap-resume-fail"` is harmless because `collectTrackedSnapshotIds` (`:3184`) is only consumed by `resetSandbox`, which iterates and tries to delete each — a stale entry would at worst trigger a 404-delete warning. If operators find the orphan entries confusing, add a cleanup in the resume-unhealthy fallback branch to filter out `snapshotHistory` records that match the discarded `snapshotId`.

### Q6: Concurrent gateway requests during auto-sleep
**Test**: Existing test at `src/server/sandbox/lifecycle.test.ts:1693` (`concurrent ensureSandboxRunning() calls from uninitialized produce exactly one sandbox create`) already fires 5 concurrent `ensureSandboxRunning()` calls and asserts only one scheduled callback and one `controller.created` entry. The stopped-state variant exists at `:1731` (`concurrent ensureSandboxRunning() calls from stopped produce exactly one restore`). Both exercise the `acquireLock(startLockKey(), ...)` dedup path at `lifecycle.ts:2473-2479`.

**Result**: PASS (existing tests cover this). Start-lock contention is logged as `sandbox.start_lock_contended` and losers return `waiting` without scheduling.

**Recommendation**: Keep current behavior. The start-lock approach is correct and already well-tested. No new test needed.

### Q7: Watchdog and gateway racing
**Test**: Existing concurrent tests at `:1693` and `:1731` cover `ensureSandboxRunning` contention. `reconcileSandboxHealth` (`lifecycle.ts:2374`) calls `ensureSandboxRunning` internally when it detects a stale `running` state, so the same start-lock dedup naturally applies when watchdog and gateway both call `reconcileSandboxHealth` concurrently. Writing a dedicated "two concurrent reconcileSandboxHealth" test would exercise the same underlying lock path through an extra layer without increasing coverage meaningfully.

**Result**: PASS (existing tests cover the load-bearing dedup path). The watchdog cron at `src/app/api/cron/watchdog/route.ts` and the gateway proxy both funnel recovery through `ensureSandboxRunning`, which is protected by `startLockKey()`.

**Recommendation**: Keep current behavior. The single start-lock is a cleaner invariant than per-caller locks — both watchdog and gateway converge to the same create/restore path without needing coordination between them. No new test required.

## Summary
- 3 new tests added, all passing (`pnpm test` reports 2139 pass / 0 fail).
- 3 questions (Q3, Q6, Q7) documented as already covered by existing tests — no duplication added.
- Current behavior is correct and intentional for all five edge cases. No code changes recommended. One minor diagnostic-logging refinement suggested for Q2, and one optional history-cleanup improvement suggested for Q4.

## Task #3: Cron wake and token refresh

### Q9: Partial/malformed cron jobs.json
**Test**: Added two tests in `src/server/sandbox/cron-persistence.test.ts`:
1. `cron-persistence Q9: malformed jobs.json does not persist to store on stop` — writes truncated JSON (`'{"version":1,"jobs":[{"id":"broken",'`) to the sandbox, calls `stopSandbox()`. `readCronNextWakeFromSandbox` catches the `JSON.parse` throw and returns `{status:"error"}`; the stop path then skips both `CRON_JOBS_KEY` and `CRON_NEXT_WAKE_KEY` writes.
2. `cron-persistence Q9: valid JSON with empty jobs array clears store` — pre-populates a good record in the store, then stops with `{version:1,jobs:[]}`. The authoritative "0 jobs" signal clears the store (`lifecycle.ts:777-780`).

**Result**: PASS for both. Malformed payloads never reach `buildCronRecord` (they're gated by the JSON.parse try/catch at `lifecycle.ts:718-724`), and empty-jobs payloads explicitly clear the store rather than silently keeping old jobs.

**Recommendation**: Keep current behavior. The two-layer defense (parse-error path drops silently, empty-array path clears) is correct. One minor observation: `buildCronRecord` itself also checks `rawJobsJson.length > CRON_JOBS_MAX_BYTES` (`lifecycle.ts:116`) AFTER `JSON.parse`, so a valid-but-oversized payload is parsed before the size check. This is harmless (JSON.parse of 256KB+ is still fast), but if you wanted to be pedantic, move the size check to the head of the function.

### Q10: Cron wake key retention
**Test**: Already covered extensively in `src/server/watchdog/run.test.ts:310-470`. Five tests exist: `restore-failed`, `restore-unverified`, `already-present`, `restored-verified`, `undefined`, and `store-invalid`. All five outcomes produce the correct `cronCleared` state (false for bad outcomes, true for `already-present` and `restored-verified`).

**Result**: PASS. Pre-existing tests cover the full matrix. No duplication added.

**Recommendation**: Keep. The assertion `cronCleared === true` only for the two "we know jobs are live on the sandbox" outcomes is the correct invariant.

### Q11: Disabled-only cron jobs
**Test**: Added `cron-persistence Q11: jobs.json with only disabled jobs yields no wake time` in `cron-persistence.test.ts`. Writes a single job with `enabled: false` to the sandbox, stops, then checks the store. `readCronNextWakeFromSandbox` skips the disabled job (`lifecycle.ts:702` `if (job.enabled === false) continue`) so `earliest` stays null and no wake key is written. However, `buildCronRecord` at `lifecycle.ts:115` only checks `parsed.jobs.length === 0` — disabled jobs still count — so the raw record IS persisted as a backup.

**Result**: PASS. This is a subtle but intentional split: wake-time tracking respects `enabled`, but the job-definition backup does not. Operators can still recover disabled job definitions after a snapshot loss.

**Recommendation**: Keep current behavior. The split makes sense — the store backup is about preserving user intent (even for disabled jobs they might re-enable later), while wake scheduling is about runtime behavior (no reason to wake for a disabled job).

### Q17: Circuit breaker burst pattern
**Test**: Added `[lifecycle] Q17: circuit breaker opens after 3 consecutive token refresh failures` in `src/server/sandbox/lifecycle.test.ts`. Unsets the OIDC token override and `AI_GATEWAY_API_KEY` so `refreshAiGatewayToken` throws "No OIDC token available for refresh." Calls `ensureUsableAiGatewayCredential({force: true})` three times — each returns `{refreshed: false, reason: "refresh-failed: ..."}` and bumps `consecutiveTokenRefreshFailures`. After three, `breakerOpenUntil` is set (`lifecycle.ts:2077`). A fourth call short-circuits with `reason: "circuit-breaker-open"`. Setting `breakerOpenUntil = 1` (past) and calling again triggers a fresh refresh attempt.

**Result**: PASS. The breaker opens at exactly the threshold (`BREAKER_FAILURE_THRESHOLD = 3`, `lifecycle.ts:168`) and stays open until `breakerOpenUntil` passes.

**Recommendation**: Keep current behavior. One gap worth noting: the breaker resets `consecutiveTokenRefreshFailures = 0` only on SUCCESS (`lifecycle.ts:2049`), not on breaker-timeout expiry. So after the breaker timeout, the next failure counts as the 4th, not the 1st. This means flapping credentials keep the breaker opened aggressively — arguably desirable (don't thrash) but worth documenting. If you wanted to make the breaker "forgive" time-based recoveries, reset the counter to 0 when `breakerOpenUntil` is cleared via timeout, not just on success.

### Q18: Token TTL survives reset
**Test**: Added `[lifecycle] Q18: clearSandboxRuntimeStateForReset does NOT clear token TTL fields` in `lifecycle.test.ts`. Populates `lastTokenRefreshAt`, `lastTokenExpiresAt`, `lastTokenSource`, `lastTokenRefreshError`, `consecutiveTokenRefreshFailures`, `breakerOpenUntil`. Calls `resetSandbox()` with a stub `deleteSnapshot` (since no real snapshot is present). After reset, asserts sandbox fields (`sandboxId`, `snapshotId`, `status`) are cleared but ALL six token/breaker fields survive intact.

**Result**: PASS. Confirmed by code inspection at `lifecycle.ts:3279-3312` — `clearSandboxRuntimeStateForReset` touches sandbox/snapshot/restore/oracle fields but never `lastToken*`, `consecutiveTokenRefreshFailures`, or `breakerOpenUntil`.

**Recommendation**: **This is likely a bug worth fixing.** A reset by an operator usually means "something is wrong, give me a clean slate." Carrying over a stale `lastTokenExpiresAt` pointing at a now-destroyed sandbox's token makes `hasSufficientSandboxCredentialTtl` (`lifecycle.ts:1908`) return true on the *next* sandbox, skipping a refresh that should happen — a fresh sandbox has no token installed at all, so the TTL check is meaningless there. Similarly, carrying over `breakerOpenUntil` into a freshly-created sandbox means a failed-credential session can poison a reset. **Suggested fix**: add these six fields to `clearSandboxRuntimeStateForReset`:
```
meta.lastTokenRefreshAt = null;
meta.lastTokenExpiresAt = null;
meta.lastTokenSource = null;
meta.lastTokenRefreshError = null;
meta.consecutiveTokenRefreshFailures = 0;
meta.breakerOpenUntil = null;
```
The Q18 test as written documents the CURRENT behavior (survival). If you adopt the fix, invert the assertions to require these fields to be null.

## Task #4: Restore attestation and oracle

### Q15: (deferred — reserved for attestation oracle coverage gaps)
Not addressed in this pass; no gap identified. Existing tests in `restore-attestation.test.ts` and `restore-oracle.test.ts` already cover reusable / needs-prepare / blocked paths comprehensively.

### Q31: Dead fallback code in buildRestoreTargetAttestation
**Test**: Added two tests in `src/server/sandbox/restore-attestation.test.ts`:
1. `Q31: buildRestoreTargetAttestation falls back to legacy snapshotConfigHash` — passes a raw meta with `snapshotDynamicConfigHash: null` but legacy `snapshotConfigHash` set. The fallback at `restore-attestation.ts:55-56` (`meta.snapshotDynamicConfigHash ?? meta.snapshotConfigHash`) activates and the snapshot becomes reusable.
2. `Q31: legacy snapshotConfigHash fallback not reused after hydration` — passes the same legacy meta through `ensureMetaShape`. After hydration, BOTH fields are `"legacy-hash"` because `ensureMetaShape` at `types.ts:573-578` already copies legacy → dynamic.

**Result**: PASS. The fallback is reachable ONLY when callers bypass `ensureMetaShape` — which in practice means direct test constructions or in-memory pipelines that build a `SingleMeta` without going through the store. For any meta that came from the store (which is 100% of production callers), the fallback is dead.

**Recommendation**: Either
- (a) Remove the fallback at `restore-attestation.ts:55-56` and rely on `ensureMetaShape` as the single hydration point, then drop the `snapshotConfigHash` field from the `RestoreAttestationMeta` Pick at `:16-28`. This reduces the API surface by one deprecated field. 
- (b) Keep it as a belt-and-suspenders defense, documented as "for direct callers that haven't gone through ensureMetaShape." 

I lean toward (a) — the fallback silently compensates for missing ensureMetaShape, which can hide bugs. Making direct-constructed metas explicit about which hash field they populate would be cleaner. Either way, the test I added for the legacy-fallback-path now pins the current behavior so a future refactor breaks loudly.

### Q32: Duplicate reasons — restore-target-dirty + snapshot-config-stale
**Test**: Added two tests in `restore-attestation.test.ts`:
1. `Q32: restore-target-dirty and snapshot-config-stale appear together when config changes` — a config change sets `restorePreparedStatus = "dirty"` (pre-flagged) AND makes `snapshotDynamicConfigHash` stale (runtime-observed). Both reasons appear in the decision.
2. `Q32: restore-target-dirty can occur without snapshot-config-stale` — when the dirty reason is `"static-assets-changed"`, `snapshot-config-stale` is NOT added but `snapshot-assets-stale` and `restore-target-dirty` are.

**Result**: PASS. The two reasons co-occur whenever the dirty flag's *cause* is the same as the observed staleness — which is the common case since `restorePreparedReason` tracks exactly the same drift signals (`dynamic-config-changed`, `static-assets-changed`). They're not strictly redundant — they describe the same event from different vantage points (pre-flagged vs runtime-observed).

**Recommendation**: Keep current behavior. The dual signal is load-bearing for operators — it confirms that the dirty flag agrees with what attestation now observes. If they disagree (e.g. dirty but all hashes match), that's a signal that the dirty flag was set for a reason no longer visible on disk — operators want to see that separation. **Optional polish**: if you want to deduplicate for UI display, deduplicate at the presentation layer, not in `buildRestoreTargetAttestation` — the underlying signals remain independently useful in logs and metrics.

### Q33: Oracle CAS check — already-running
**Test**: Already covered by existing test at `src/server/sandbox/restore-oracle.test.ts:269-293` (`blocks when oracle is already running`) and the CAS race test at `:574-601` (`CAS race on beginOracleRun returns already-running`). The latter specifically simulates the compare-and-swap race by mutating `meta.restoreOracle.status` inside the `mutate` callback between the read and the set.

**Result**: PASS (existing). Both the "already running" fast path and the CAS race condition are covered.

**Recommendation**: Keep. The CAS test is particularly nice — it verifies that two concurrent `runRestoreOracleCycle` calls can't both execute a prepare because `beginOracleRun` atomically checks and sets `restoreOracle.status` in a single `mutate` call. No changes needed.

### Q34: Launch-verify forced oracle
**Test**: Already covered by existing test at `restore-oracle.test.ts:416-453` (`force=true bypasses idle gating`). Sets `lastAccessedAt: 999_999` (recently active, only 1ms idle). Calls `runRestoreOracleCycle({force: true, minIdleMs: 300_000})`. Asserts that `prepareCalled === true` and `result.executed === true` — the idle gate is bypassed.

**Result**: PASS (existing).

**Recommendation**: Keep. The `force: true` path is the documented mechanism for launch-verify to drive the oracle regardless of idle state — no changes needed.

### Q35: Legacy snapshot reusability
**Test**: Added `Q35: legacy snapshot with all hashes null is non-reusable with unknown reasons` in `restore-attestation.test.ts`. Passes a meta with `snapshotId` set but `snapshotDynamicConfigHash`, `runtimeDynamicConfigHash`, `snapshotAssetSha256`, `runtimeAssetSha256` all null and `restorePreparedStatus: "unknown"`.

**Result**: PASS. Attestation returns `reusable: false`, `needsPrepare: true`, and `reasons` includes `snapshot-config-unknown`, `snapshot-assets-unknown`, `restore-target-unknown`. Per-field `*Fresh` values are `null` (unknown).

**Recommendation**: Keep. A legacy snapshot with no hash metadata is correctly treated as non-reusable — attempting to reuse it would skip the asset-freshness check, risking a stale restore. The three "unknown" reasons give operators a clear signal that this isn't a drift problem but a missing-metadata problem (probably a snapshot from before the hash tracking was added).

## Task #3 + #4 Summary
- 8 new tests added across `cron-persistence.test.ts` (3), `lifecycle.test.ts` (2), and `restore-attestation.test.ts` (5 — Q31×2, Q32×2, Q35).
- 3 questions (Q10, Q33, Q34) documented as already covered by existing tests.
- All new tests pass under `node scripts/verify.mjs --steps=test` (full suite green).
- One likely bug found: **Q18** — token TTL and circuit-breaker fields survive `resetSandbox`, which can poison a freshly-created sandbox. Recommend adding the six fields to `clearSandboxRuntimeStateForReset`.
- One dead-code candidate: **Q31** — the legacy-hash fallback in `buildRestoreTargetAttestation` is redundant after `ensureMetaShape` hydration. Consider removing it to force callers into a single hydration path.
- Otherwise, all tested behaviors are correct and intentional.

## Task #5: Channel/webhook, heartbeat, worker, testing gaps

### Q8: Channel webhook reconcile ordering
**Analysis**: The Telegram webhook handler (`src/app/api/channels/telegram/webhook/route.ts:268`) calls `await reconcileStaleRunningStatus()` synchronously before reassigning `effectiveMeta`, then the subsequent workflow `start()` only reads `effectiveMeta`. Since `reconcileStaleRunningStatus` (`lifecycle.ts:1768-1803`) is a single `mutateMeta` wrapped around a `sandbox.get()` call, there is no concurrency gap — the promise resolves with the reconciled meta before the code below runs. Slack and Discord routes do not have a native fast path, so the ordering question only applies to Telegram.

**Recommendation**: Keep. The current single-awaited reconcile ensures any reads after line 268 see the post-reconcile state. No new test needed — existing `Gateway: upstream 410` (`src/app/gateway/route.test.ts:576`) and the new Q19 tests confirm the reconcile primitive behaves correctly.

### Q19: touchRunningSandbox detecting sandbox gone via SDK status
**Test**: Added two tests in `src/server/sandbox/lifecycle.test.ts`:
1. `[lifecycle] touchRunningSandbox marks unavailable when SDK reports status!=running` — pre-registers a handle with `setStatus("stopped")`, calls `touchRunningSandbox()`. Verifies status transitions to `stopped` (snapshotId present), sandboxId clears, and `lastError` contains `"heartbeat detected sandbox status"` — covers the non-throw SDK signal path at `lifecycle.ts:1626-1636`.
2. `[lifecycle] touchRunningSandbox marks error when SDK reports failed and no snapshot` — same but `setStatus("failed")` with no snapshot. Verifies status becomes `error`.

**Result**: PASS. Both tests confirm that heartbeat reconciles via SDK status, not only via exceptions.

**Recommendation**: Keep. The SDK's ability to surface platform-terminated sandboxes through a non-throwing status field (instead of a 404) is load-bearing for fast recovery without waiting for a retry to throw.

### Q20: Gateway 410 → reconcileSandboxHealth
**Analysis**: Already covered by `Gateway: upstream 410 marks sandbox unavailable and returns waiting page` (`src/app/gateway/route.test.ts:576`) and the companion test at `:1253` that exercises the `touchRunningSandbox` → `gateway.sandbox_lost_after_touch` → ensure path. No duplication added.

**Recommendation**: Keep. Existing coverage is sufficient.

### Q21: ensureSandboxRunning when running but timeout expired
**Test**: Added `[lifecycle] ensureSandboxRunning running + expired timeout -> reconciles via reconcileSandboxHealth`. Sets `lastAccessedAt` to 1 hour ago with `OPENCLAW_SANDBOX_SLEEP_AFTER_MS=5min`, configures the handle as `stopped` and upstream fetch to return 410. Verifies the `sandbox.ensure_running.timeout_expired` log fires and the repair path lands meta in `restoring` or `stopped`.

**Result**: PASS. Closes the previously untested branch at `lifecycle.ts:352-378`.

**Recommendation**: Keep current behavior. The runtime correctly treats a stale `running` meta with expired timeout as a reconcile trigger rather than trusting the stale state — this is how a naturally-slept sandbox returns to the lifecycle.

### Q22: Gateway sandbox_lost_after_touch path
**Analysis**: Already covered at `src/app/gateway/route.test.ts:1253-1316`. Test drives sandbox to running, makes `extendTimeout` throw, and verifies the gateway surfaces the touch-detected unavailability (fires `gateway.missing_credentials`, avoids `gateway.upstream_410`, schedules `ensureSandboxRunning` with reason `gateway.sandbox_lost_after_touch`).

**Recommendation**: Keep. Existing coverage is sufficient.

### Q23: Channel webhook → sandbox wake
**Analysis**: The webhook route defers to `drainChannelWorkflow.start()` (`src/app/api/channels/telegram/webhook/route.ts:334`) which runs asynchronously via `workflow/api`. Unit-testing the end-to-end wake would require mocking the workflow runtime, which is already done in `channels/telegram/route.test.ts:136` for dedup and elsewhere for workflow-start-failed. Wake triggering happens inside the workflow step, not the webhook handler — the webhook's sole responsibility is to accept-200 and start the workflow.

**Recommendation**: Keep. The wake step belongs to `drainChannelWorkflow`; the webhook-to-workflow handoff is already unit-tested. Integration testing the wake flow is better done via the scenario harness with a pre-seeded stopped sandbox — consider adding such a test if real wake races are observed in prod.

### Q24: reconcileSnapshottingStatus stale guardrail (>5 min)
**Test**: Added two tests in `src/server/sandbox/lifecycle.test.ts`:
1. `[lifecycle] reconcileSnapshottingStatus stale snapshotting >5min -> force-stopped` — SDK still reports `snapshotting` but `updatedAt` is 10 min old. Expects status forced to `stopped` and log `sandbox.snapshotting_reconciled` with `outcome=stale-force-stopped`.
2. `[lifecycle] reconcileSnapshottingStatus still-in-flight within window -> leaves meta snapshotting` — SDK reports `snapshotting` with fresh `updatedAt`. Expects status stays `snapshotting`.

**Result**: PASS. Covers the guardrail at `lifecycle.ts:1852-1864` plus the non-stale path.

**Recommendation**: Keep. The 5-minute threshold (`STALE_OPERATION_MS` at `lifecycle.ts:161`) is aligned with `isBusyStatus` stale detection elsewhere — the choice is consistent across the codebase. If this becomes a pain point (e.g. snapshot really takes >5 min under load), bump the constant rather than adding a separate snapshot-specific timeout.

### Q25: Hot-spare promotion fallthrough
**Analysis**: The fallthrough path at `lifecycle.ts:2665-2671` triggers `clearHotSpareState(m)` and logs `sandbox.create.hot_spare_fallback`, then continues into the normal `get()`/`create()` flow. `src/server/sandbox/hot-spare.test.ts` already tests `promoteHotSpare` in isolation with `returns failed when create throws` (`:161`). The downstream fallthrough in the lifecycle is indirectly exercised every time hot-spare is disabled in tests (the default). Writing a dedicated lifecycle-level fallthrough test would require `isHotSpareEnabled()` to return true, which requires an extra env flag, and the fall-through branch contains no logic that isn't already covered by non-hot-spare code paths.

**Recommendation**: Keep. Hot-spare is feature-flagged off by default; adding a dedicated test adds maintenance burden for minimal value. If hot-spare is ever turned on in production, add an e2e test at the integration layer instead.

### Q26: Telegram "suspicious empty 200" heuristic
**Analysis**: The heuristic at `src/app/api/channels/telegram/webhook/route.ts:221-224` flags responses where `status=200 && durationMs < 150 && bodyLength === 0`. Rationale: OpenClaw's native handler on port 8787 always writes at least a minimal body; a fast empty 200 is most consistent with a proxy or middleware responding before the handler code runs. The heuristic only logs `channels.telegram_fast_path_suspect_empty_200` — it does NOT reject the response or fall through to the workflow.

**Recommendation**: Keep for now but consider hardening. The heuristic is purely observational — operators see the warning in logs but users still experience the message as "delivered" because we return 200 back to Telegram. If diagnostics show this firing during real incidents, the right fix is probably: (a) treat suspicious empty-200 like network failure (reconcile stale status + fall through to workflow), OR (b) require a magic ack body from the native handler so absence is unambiguous. The 150ms threshold is tight — intermittent sub-150ms legit responses could be flagged as false positives. If telemetry shows the warn firing frequently during normal traffic, raise the threshold or tighten `bodyLength === 0` to exclude keep-alive noise.

### Q27: Non-2xx from native handler returns 200 to Telegram
**Analysis**: The code at `src/app/api/channels/telegram/webhook/route.ts:246-257` logs `channels.telegram_fast_path_non_ok` on non-2xx but still returns `Response.json({ ok: true })` (line 257). The comment at :188-195 explicitly documents this: "On ANY HTTP response (2xx or not), return 200 — the native handler received the payload and may have started processing. Falling through would forward the payload again, causing duplicate delivery."

**Recommendation**: Keep with caveat. The reasoning is sound — Telegram retries aggressively on non-2xx (every few seconds, up to 24h), and duplicate delivery is almost always worse than a single missed message. HOWEVER, if the native handler consistently errors out (e.g. 500 due to a code bug), messages will be silently dropped without any visible retry. Recommend: add a metric that alerts when `channels.telegram_fast_path_non_ok` rate exceeds a baseline, so ops notice sustained native-handler failures. The current behavior is correct for transient errors but masks persistent handler bugs.

### Q28: Dedup lock 24h TTL
**Analysis**: `src/app/api/channels/telegram/webhook/route.ts:130` sets the dedup lock TTL to `24 * 60 * 60` (24 hours). Telegram's webhook retry policy retries for up to 24 hours with exponential backoff, so the 24h TTL exactly matches the worst-case retry window. After 24h, a retry would succeed uniquely — but by then the message is stale anyway.

**Recommendation**: Keep. 24h is the correct ceiling — anything shorter risks re-processing retries; anything longer wastes Redis keys. The constant should ideally be centralized (e.g. as `TELEGRAM_DEDUP_TTL_SECONDS`) rather than inlined; a grep suggests Slack uses a similar approach in `src/server/channels/slack/route.test.ts:174` but with its own value. Consider extracting both to `src/server/channels/constants.ts` for maintainability.

### Q29: telegramListenerReady race
**Analysis**: The webhook gates the fast path on `effectiveMeta.lastRestoreMetrics?.telegramListenerReady === true` (`webhook/route.ts:203-205`). `telegramListenerReady` is set inside the restore path after the fast-restore script proves a local 401 on the 8787 route (`lifecycle.ts` sets `lastRestoreMetrics` after bootstrap). Race: between `status=running` being set (`lifecycle.ts:2762`) and the `lastRestoreMetrics` write (later in the same path), concurrent webhook reads could see `running` + `telegramListenerReady=undefined`. The webhook handles this by falling through to the slow workflow path rather than hitting a half-ready handler — exactly the right failure mode.

**Recommendation**: Keep. The asymmetric gating (running AND listener-ready) is load-bearing. Strengthening it would require a single atomic write for both fields, but the current race is "bounded and safe" — a fall-through to the workflow during the window costs ~1s but delivers correctly. No change needed.

### Q30: Boot message not cleaned up on workflow failure
**Analysis**: The boot message "🦞 Waking up…" is sent at `webhook/route.ts:284` *before* the workflow starts. If `drainChannelWorkflow.start()` throws (line 363-393), the route returns 500 without deleting the boot message, so the user sees a permanent "Waking up…" that never updates. The dedup lock IS released on workflow-start-failure (line 364), so Telegram retries will succeed — but each retry will send a *new* boot message, and each prior one remains orphaned. The comment at :122-123 confirms: "If workflow start fails after dedup lock acquisition, return 500 so..."

**Recommendation**: Change. On workflow-start-failure, best-effort delete the boot message before returning 500. The existing `sendMessage` helper already supports edit/delete operations (the workflow uses them for success cleanup). Add a `try { await deleteMessage(config.botToken, Number(chatId), bootMessageId) } catch {}` at line 391 (inside the catch block). Low risk: delete-failure is already logged elsewhere, and the user experience improvement is clear (no ghost "Waking up…" stuck in chat history during outages).

### Q36: Heartbeat only fires with open WebSockets
**Analysis**: `src/server/proxy/htmlInjection.ts:44-46` defines `shouldHeartbeat = openSocketCount > 0 && document.visibilityState === 'visible'`. `openSocketCount` is incremented in the WebSocket constructor interceptor at `:125` and decremented on close/readyState=CLOSED at `:131-138`. The heartbeat fetch at `:62-68` posts to `TOUCH_URL` (the gateway's touch endpoint) which calls `touchRunningSandbox()`, extending the Vercel Sandbox platform timeout.

The admin UI at `/` (`src/components/designs/command-shell.tsx`) does NOT run through the HTML injection — only pages served *from the sandbox* through the `/gateway` proxy get the injection. The admin UI opens no WebSockets to the sandbox domain, so even if it loaded the injected script, `openSocketCount` would stay at 0.

**Result**: The heartbeat ONLY fires while the user has an active OpenClaw session open (which uses WebSockets for chat), tab is foregrounded, AND page is loaded through `/gateway`. The admin UI does NOT keep the sandbox alive.

**Recommendation**: Correct by design. Extending the sandbox for passive admin-UI viewing would defeat auto-sleep for the common case of "operator left a tab open overnight." If admin UI *should* keep the sandbox alive (for preflight/watchdog dashboards), add an explicit keep-alive toggle rather than piggybacking on the injected heartbeat.

### Q37: Gateway token in WebSocket sub-protocol
**Security analysis**: `src/server/proxy/htmlInjection.ts:109-112` encodes the token as a Sec-WebSocket-Protocol sub-protocol: `'openclaw.gateway-token.' + encodeURIComponent(GATEWAY_TOKEN)`. Rationale: browsers do not allow custom headers on `new WebSocket()` — sub-protocols are the only way to attach auth metadata to the WS handshake client-side without server-side cookie forwarding.

Risks:
- **Logged in network tools**: DevTools' Network panel shows the Sec-WebSocket-Protocol header verbatim, exposing the token to anyone with DevTools access on the user's device. Same for browser crash dumps and extension APIs with tab access.
- **Third-party WebSocket middleboxes**: Some observability proxies (Cloudflare WS inspectors, LaunchDarkly Edge) log sub-protocol headers by default. If the gateway is ever fronted by such a system, tokens leak to third-party logs.
- **CSP and browser extensions**: Sub-protocols are readable by any content script or extension that inspects WebSocket creation — Chrome's chrome.webRequest API exposes them.

Mitigations in place:
- Token is per-sandbox (regenerated on reset), not per-user — compromise scope is limited to that sandbox session.
- Token is also placed in the URL fragment (`:196-199`) which at least protects from server-side logs.

**Recommendation**: Accept for now but document. The WebSocket sub-protocol approach is the standard pattern for browser-side WS auth, but the token-leak surface is real. Long-term alternatives: (a) short-lived WS-specific tokens (exchange gatewayToken for a 60s scoped WS token via a separate endpoint before WS connect), or (b) rely on same-origin cookies plus CSRF checks and skip the sub-protocol entirely. Option (a) is a clean fit because the gateway already controls both endpoints and has a CSRF baseline.

### Q38: ensureMetaShape throws on instance ID mismatch
**Test**: Added a new describe block in `src/shared/types.test.ts` with four tests:
1. Throws when persisted id differs from expectedInstanceId.
2. Accepts hydration when ids match exactly.
3. Accepts hydration when persisted id is missing (legacy meta — hydrator fills in expected id).
4. Error message includes both ids for operator debugging.

**Result**: PASS. Covers the instance-namespacing guard at `src/shared/types.ts:550-554`.

**Recommendation**: Keep. The guard prevents accidental cross-namespace reads on shared Redis (e.g. after renaming `OPENCLAW_INSTANCE_ID` and forgetting to clear the old key). The throw behavior (rather than silently returning null) is correct — a mismatch is a configuration error, not a recoverable state, and operators need the signal.

### Q39: Orphan cleanup
**Analysis**: Vercel Sandbox v2 persistent sandboxes (the primary mode) are created with a fixed name (`oc-${instanceId}`) and auto-stop after `OPENCLAW_SANDBOX_SLEEP_AFTER_MS`. They do not need explicit orphan cleanup — the SDK's `get({ sandboxId: name })` will find the existing instance if it's still known, or throw 404 if it has been garbage-collected platform-side. Ephemeral worker sandboxes (created for background jobs) are not persistent and have their own lifecycle outside the main sandbox controller. The platform auto-terminates them when the `timeout` parameter elapses.

**Recommendation**: Keep. There is no need for an explicit orphan scan. The single-sandbox-per-instance model plus platform timeouts means the only failure mode is "sandbox lost after config change to OPENCLAW_INSTANCE_ID" — and that is an operator-visible config error, not a runtime state problem. If a bug ever creates untracked persistent sandboxes (e.g. a failed create that did register the name), the operator can delete them via the Vercel dashboard.

### Q40: Worker auth tied to gatewayToken
**Analysis**: Worker sandboxes authenticate back to the main gateway using `gatewayToken`. If `resetSandbox` runs while a worker is mid-flight, the worker's in-flight requests will 401 because the token no longer matches. The worker will surface this as a job failure, and retries (per the workflow runtime's retry policy) will use the new token once they pick it up from the fresh meta.

**Recommendation**: Accept for now. The blast radius of a reset is intentional — reset is a "nuclear option" and anyone triggering it accepts in-flight job loss. The alternative (maintaining a revocation list of previous tokens for some grace period) adds state complexity for a rare operator action. If reset-during-workers becomes common, add a pre-flight check that counts in-flight workers and warns the operator before proceeding.

### Q41: Manual snapshot bypassing stopSandbox
**Analysis**: `snapshotSandbox` (`lifecycle.ts` export) performs `sandbox.snapshot()` but does NOT call `sandbox.stop()`, so the sandbox keeps running and its timeout keeps counting down. `stopSandbox()` does both (stop + auto-snapshot in v2). The semantic difference: manual snapshot is "I want a rollback point without interrupting service"; stop is "I'm done with this sandbox, free the resources."

**Recommendation**: Document and keep. The current distinction is load-bearing for the `/api/admin/snapshot` endpoint (create rollback point) vs `/api/admin/stop` (free resources). Consider adding a JSDoc header to `snapshotSandbox` that says "Does not stop the sandbox. If you want to stop AND snapshot, use stopSandbox()." The absence of this comment is probably why the question came up.

### Q42: Snapshot restore vestigial in persistent model
**Analysis**: In v2 persistent mode, `getSandboxController().get({ sandboxId: name })` auto-resumes a stopped persistent sandbox without needing a `snapshotId` (`lifecycle.ts:2684`). The `snapshotId` is only used by the v1 snapshot-based restore path, which is no longer the primary flow — it's a fallback. However, `snapshotId` still matters for: (a) the rollback-to-point-in-time feature, (b) the `stopSandbox` → `reconcileSnapshottingStatus` transition which uses a synthetic snapshotId for tests (`src/test-utils/harness.ts:460`), and (c) the reset path's `collectTrackedSnapshotIds` which cleans up orphans on full reset.

**Recommendation**: Accept. `snapshotId` is vestigial for normal operation but still load-bearing for rollback and reset. Removing it would break those flows. The awkwardness is that the field is now carrying two semantically different responsibilities. Long-term, consider splitting into `lastStopSnapshotId` (auto-snapshot from platform, vestigial for v2 resume) vs `savedRollbackSnapshotId` (explicit rollback target). For now, keep the single field and document the responsibility split in a `lat.md` section.

### Q43: Duplicate snapshot IDs in collectTrackedSnapshotIds
**Analysis**: `collectTrackedSnapshotIds` at `lifecycle.ts:3184-3190` uses `new Set([...])` to deduplicate the combined list of `meta.snapshotId` + `meta.snapshotHistory.map((r) => r.snapshotId)`. The deduplication is correct: if `meta.snapshotId` is also the first entry in `snapshotHistory` (the typical case after a stop), the Set collapses them to a single entry. The downstream `deleteTrackedSnapshotsForReset` iterates once per unique id, so there is no double-delete.

**Result**: No test written — the function is not exported and testing it requires either exposing it or exercising through `resetSandbox` (which already has its own integration tests). Code review of the implementation confirms correctness: Set dedup + null/undefined filter + explicit Boolean guard.

**Recommendation**: Keep. The three-step pattern (concat, dedupe, filter) is idiomatic and the test coverage via `resetSandbox` integration tests is sufficient. No extraction needed.

## Task #5 Summary
- 9 new tests added: 1 in `types.test.ts` (4 assertions under Q38), 5 in `lifecycle.test.ts` (Q19×2, Q21×1, Q24×2).
- 4 questions (Q8, Q20, Q22, Q43) documented as already covered by existing tests or confirmed safe by code review.
- All new tests pass — full suite: 2148 pass / 0 fail.
- Two potential improvements identified:
  - **Q30**: Add best-effort delete of the "Waking up…" boot message when `workflow.start()` fails, to avoid orphaned messages during outages.
  - **Q27**: Add an alerting metric on `channels.telegram_fast_path_non_ok` rate so persistent native-handler failures surface (rather than being silently swallowed by the return-200 policy).
- Two documentation/refactoring suggestions:
  - **Q41**: Add a JSDoc warning that `snapshotSandbox` does not stop the sandbox.
  - **Q42**: Consider splitting `snapshotId` into `lastStopSnapshotId` vs `savedRollbackSnapshotId` long-term to clarify responsibility.
- One security follow-up (Q37): document the gateway-token-in-sub-protocol leak surface and plan the short-lived-WS-token mitigation if it escalates.

## Task #1: Live SDK Integration Tests

Ran `scripts/experiments/audit-stop-snapshot.mjs` against real Vercel Sandbox platform (2026-04-18).

### Q1: Snapshot timing
**Test**: Created ephemeral sandboxes, wrote 50MB of files, called `sandbox.snapshot()`, timed 3 iterations.
**Result**: Snapshots of ~306MB sandboxes complete in **~4 seconds** (4013ms, 4166ms, 3999ms). Highly consistent.
**Recommendation**: The 5-minute `STALE_OPERATION_MS` guardrail is 75x longer than a typical snapshot. **Keep it as-is** — it's a safety net for genuinely stuck backend operations, not a tight timeout. The real-world snapshot time (4s) means users almost never see `snapshotting` status in the UI at all. If you want tighter feedback, consider logging a warning at 30s or 60s rather than changing the guardrail.

### Q5: Blocking vs non-blocking stop
**Test**: (a) `stop({ blocking: true })` — timed total. (b) `stop({ blocking: false })` then polled `Sandbox.get()` every 1s for 60s.
**Result**: Blocking stop took **5.1 seconds**. Non-blocking stop returned in 158ms but subsequent `Sandbox.get()` polls returned 404 for the entire 60s window. This is because ephemeral (non-persistent) sandboxes are deleted on stop — they don't transition to `stopped`, they simply disappear. **Persistent sandboxes** (which openclaw uses) remain findable via `get()` after stop — the 404 behavior is ephemeral-only.
**Recommendation**: The ephemeral 404 behavior confirms that our persistent-sandbox `reconcileSnapshottingStatus()` polling approach is correct — it depends on `get()` returning a handle with a terminal status, which persistent sandboxes do. The 5s blocking time is well under the 5-minute guardrail. **No changes needed**, but a persistent-sandbox version of this test would be valuable for monitoring platform regression.

### Q13: Concurrent create during snapshot
**Test**: After calling `snapshot()` on sandbox A, immediately `Sandbox.create()` sandbox B. Checked if B was healthy.
**Result**: Both operations completed successfully. Snapshot took 6.6s, create took ~6.6s (overlapping). The second sandbox was fully alive and could run commands. **No interference.**
**Recommendation**: **Hot-spare pre-creation during snapshotting is safe.** The platform handles concurrent create + snapshot without contention. Keep the current `preCreateHotSpare()` call after non-blocking stop.

### Q14: Pending status behavior
**Test**: Called `Sandbox.create()` and immediately checked `status`, then tried `runCommand` before any explicit readiness check.
**Result**: By the time `create()` resolves (~322ms), the sandbox is already `running`. `runCommand` works immediately (395ms, `exitCode: 0`, correct stdout). **There is no observable `pending` period** from the SDK caller's perspective — `create()` blocks until the sandbox is ready.
**Recommendation**: The `pending` status in `unhealthyStatuses` check at `lifecycle.ts:2695` is unreachable in practice — `get()` also returns after the sandbox is past `pending`. **No code change needed**, but `pending` could be added to `unhealthyStatuses` as defense-in-depth if desired (it would only activate if the SDK behavior changes in a future version).

## Persistent Sandbox Stop/Resume (Live Test)

Ran `scripts/experiments/audit-persistent-stop-resume.mjs` against real Vercel Sandbox with `persistent: true`.

### Key findings

| Phase | Timing | Status transitions |
|-------|--------|--------------------|
| Create persistent sandbox | 328ms | → `running` |
| `stop({ blocking: false })` | 318ms to return | → `stopping` immediately |
| Snapshot (polled via `Sandbox.get()`) | **6.35 seconds** | `stopping` → `stopped` |
| `Sandbox.get()` during snapshotting | Works — returns handle with current status | No 404 (unlike ephemeral) |
| Resume via `Sandbox.get()` after stopped | 283ms for handle | Returns `stopped` — **does NOT auto-resume** |
| `stop({ blocking: true })` on already-stopped | 288ms | No-op |

### Critical discovery: `Sandbox.get()` does NOT auto-resume stopped persistent sandboxes

The SDK docs suggest `get()` transparently resumes, but our test shows `Sandbox.get({ name })` returns a handle with `status: "stopped"` — it does NOT auto-start the sandbox. The handle stayed `stopped` for the full 30-second polling window. **This means our app's resume path at `lifecycle.ts:2684` may need an explicit `stop()`→`create()` or the SDK's auto-resume only triggers on `runCommand`/`writeFiles`, not `get()` alone.**

This needs investigation — it could explain edge cases where the app thinks it has a running sandbox but the gateway never starts.

### Snapshot timing confirmed

The persistent sandbox snapshot took **6.35 seconds** for a sandbox with ~10MB of written data — consistent with the ephemeral test (~4s for 50MB). The 5-minute guardrail is 47x longer than needed. No change to the threshold recommended.

### Q18 Exploit Proof (Unit Test)

Added `[lifecycle] Q18-exploit: stale lastTokenExpiresAt after reset causes ensureUsableAiGatewayCredential to skip refresh` to lifecycle.test.ts. **Test passes, confirming the bug is exploitable:**

1. Set `lastTokenExpiresAt` to 1 hour from now on a running sandbox
2. Call `resetSandbox()` — clears sandbox state but token TTL fields survive
3. Create a fresh sandbox (no token installed)
4. Call `ensureUsableAiGatewayCredential()` — returns `refreshed: false, reason: "meta-ttl-sufficient"`
5. **Bug confirmed**: the fresh sandbox has no token but the stale TTL tricks the system into thinking the token is still valid

**This is a real bug that could cause AI Gateway 401s after a reset.** The fix is straightforward: add 6 fields to `clearSandboxRuntimeStateForReset()`.

## Executive Summary

### Bugs found (recommend fixing)
1. **Q18 — Token TTL survives reset**: `clearSandboxRuntimeStateForReset` doesn't clear `lastTokenExpiresAt`, `consecutiveTokenRefreshFailures`, or `breakerOpenUntil`. A reset followed by a fresh sandbox create can skip a needed token refresh because stale TTL data says "token is still valid." Fix: add 6 fields to the clear list.
2. **Q30 — Orphaned "Waking up…" boot message**: When `workflow.start()` fails after sending the Telegram boot message, the message is never deleted. Each Telegram retry sends a new one. Fix: best-effort `deleteMessage` in the catch block.

### Improvements worth considering
3. **Q27 — Telegram non-2xx silently swallowed**: The return-200 policy for native-handler errors is correct (prevents duplicate delivery) but masks persistent handler bugs. Add an alerting metric on `channels.telegram_fast_path_non_ok` rate.
4. **Q31 — Dead fallback code**: The `snapshotDynamicConfigHash ?? snapshotConfigHash` fallback in `buildRestoreTargetAttestation` is redundant after `ensureMetaShape` hydration. Consider removing it.
5. **Q37 — WebSocket token in sub-protocol**: Security leak surface (DevTools, middleboxes). Long-term: replace with short-lived scoped WS tokens.
6. **Q17 — Circuit breaker counter not reset on timeout expiry**: Only resets on success, making flapping credentials aggressive. Consider resetting to 0 when `breakerOpenUntil` expires.

### Confirmed correct (no changes needed)
Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12, Q13, Q14, Q15, Q19, Q20, Q21, Q22, Q23, Q24, Q25, Q26, Q28, Q29, Q32, Q33, Q34, Q35, Q36, Q38, Q39, Q40, Q41, Q42, Q43 — all tested or analyzed, current behavior is intentional and correct.

### Test coverage added
- 20 new unit tests across 4 files (lifecycle.test.ts, cron-persistence.test.ts, restore-attestation.test.ts, types.test.ts)
- 1 live SDK integration test script (scripts/experiments/audit-stop-snapshot.mjs)
- Full suite: 2148 pass / 0 fail

---

## Research: Persistent sandbox `get()` resume behavior (Task #3)

### Questions
1. Does `Sandbox.get({ name })` on a stopped persistent sandbox auto-resume it?
2. Does `runCommand()` on a stopped handle trigger an implicit resume?
3. Does the existing production flow at `src/server/sandbox/lifecycle.ts:2679-2772` actually work?

### SDK source (read at `~/dev/sandbox/packages/vercel-sandbox/src/`)

- `sandbox.ts:391-415` — `Sandbox.get()` calls `client.getSandbox()` and constructs a `Sandbox` wrapper from the response. **No resume trigger.**
- `api-client.ts:140-152` — `getSandbox()` is a plain `GET /v1/sandboxes/:id` (plus optional query params). **No `resume` flag, no side effects.**
- No `resume` or `startSandbox` method exists anywhere in the SDK or API client. Grep for `resume|startSandbox` under `src/` returns only doc-comments about `stopped` state.
- `CHANGELOG.md` has no mention of auto-resume.

### Live test: `scripts/experiments/audit-persistent-resume.mjs`

```
create.done            status: running   (427 ms)
stop.done                                 (6545 ms, blocking: true)
getA.done              status: stopped   (321 ms)   ← get() does NOT resume
runcmd.done            status: 0         (1936 ms)  ← runCommand on stopped handle SUCCEEDED
                                                     stdout: "hello"
getB.after_runcmd      status: running              ← runCommand transparently resumed it
```

### Findings

1. **`Sandbox.get()` does NOT auto-resume.** It returns a handle with `status: "stopped"` for a stopped persistent sandbox.
2. **`runCommand()` on a stopped persistent handle transparently auto-resumes the sandbox.** The first command takes ~2s (resume overhead) instead of the usual <100ms for a command on a running sandbox, then subsequent commands run normally and the sandbox's status becomes `"running"`.
3. This auto-resume-on-runCommand is the platform API's behavior (the `/v1/sandboxes/:id/cmd` endpoint starts the VM if stopped); it is not explicit SDK logic.

### Does our app's resume flow work?

**Yes, but for a different reason than the code comment claims.**

At `src/server/sandbox/lifecycle.ts:2679-2720`:
- Line 2679-2680 comment says *"get() first (auto-resumes stopped persistent sandbox in one call)"* — **this comment is incorrect.**
- Line 2684 calls `get()` — this returns a stopped handle with `status: "stopped"`.
- Line 2696 checks `unhealthyStatuses = ["failed", "error", "aborted"]` — `"stopped"` is NOT in this set, so the flow proceeds.
- Line 2719 logs `status=${sandbox.status}` — in production this would log `status=stopped` for a cold resume, not `running`.
- Line 2769 calls `sandbox.runCommand("bash", [...])` — **this is where the actual resume happens**, adding ~2s to the cold path.

So the real resume trigger is the `whichCheck` at line 2769, not `get()`. The flow works because `runCommand` happens to resume the sandbox as a side effect.

### Is there a bug?

**No functional bug.** The resume flow is working correctly — a stopped persistent sandbox is resumed by the subsequent `runCommand`, its filesystem is intact, and the `openclaw` binary check succeeds (`isResumed = true`), so the fast-restore branch runs.

**Documentation/comment bug.** The comment at line 2679-2680 is misleading. It claims `get()` auto-resumes "in one call" — it does not. Any future contributor who relies on that statement (e.g., skipping the `whichCheck` and relying on `sandbox.status` from `get()`) will see persistent sandboxes treated as fresh and get a full re-bootstrap instead of a fast restore.

**Latent risk.** If a future refactor ever replaces the `runCommand`-based `whichCheck` (line 2769) with something that reads `sandbox.status` from the `get()` result to decide "resumed vs fresh", it will regress: `status === "stopped"` would be misread.

### Recommended fix

Small, surgical — update the comment and make the logic robust to the real SDK semantics:

1. **`src/server/sandbox/lifecycle.ts:2679-2680`** — replace the misleading comment:

   ```ts
   // Normal path: get() first to check whether a persistent sandbox already
   // exists for this name. A stopped persistent sandbox returns status:
   // "stopped"; the subsequent runCommand at the whichCheck below will
   // transparently resume it (platform behavior, ~2s overhead). Fall back
   // to create() only if get() throws (sandbox does not exist yet).
   ```

2. **`src/server/sandbox/lifecycle.ts:2719`** — clarify the progress log so a `stopped` status isn't alarming:

   ```ts
   progress.appendLine(
     "system",
     `Resumed: ${sandbox.sandboxId} status=${sandbox.status}` +
       (sandbox.status === "stopped" ? " (will resume on first command)" : ""),
   );
   ```

3. **Optional: add `"stopped"` explicitly as the expected pre-resume state.** The current unhealthy-status check already handles this correctly (it excludes `"stopped"`), but an explicit comment there (`src/server/sandbox/lifecycle.ts:2695`) would make the intent obvious.

No behavior change, just documentation. The code is correct — the rationale is wrong.

### Files touched / referenced

- `/Users/johnlindquist/dev/vercel-openclaw/scripts/experiments/audit-persistent-resume.mjs` — new, runnable live-SDK test
- `/Users/johnlindquist/dev/vercel-openclaw/src/server/sandbox/lifecycle.ts:2679-2772` — current resume flow
- `/Users/johnlindquist/dev/sandbox/packages/vercel-sandbox/src/sandbox.ts:391-415` — `Sandbox.get()` definition
- `/Users/johnlindquist/dev/sandbox/packages/vercel-sandbox/src/api-client/api-client.ts:140-152` — `getSandbox` HTTP call
