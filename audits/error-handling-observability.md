# Error Handling & Observability Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: Prelaunch-warning (launch-critical paths are instrumented; several observability gaps identified)

## Scope

- `src/server/log.ts`
- `src/server/deploy-preflight.ts`
- `src/server/deployment-contract.ts`
- `src/app/api/admin/launch-verify/route.ts`
- `src/app/api/cron/watchdog/route.ts`

## Findings

### PASS — Ring buffer excludes debug entries to preserve operational logs

- **Evidence**: `log.ts:82-85`
- **Detail**: Debug-level entries go only to `console.debug` and are excluded from the 1000-entry ring buffer. This prevents high-frequency diagnostic logs (status polling, URL resolution) from evicting operationally important entries (lifecycle transitions, webhook events, workflow results).

### PASS — Launch verification has thorough error categorization

- **Evidence**: `launch-verify/route.ts:134-183` (`runPhase`)
- **Detail**: Controlled failures (`result.ok === false`) and thrown exceptions are both caught, logged via `logError` with structured `phase`, `durationMs`, `code`, and `error` fields. Phase skip is logged at `logInfo` with `code: "phase.skip"`. The `code` field provides filterable recovery signals.

### PASS — Channel driver logs structured events at each phase boundary

- **Evidence**: `driver.ts:162-168, 205-210, 241-247, 318-326, 338-339`
- **Detail**: `channels.wake_requested`, `channels.wake_ready`, `channels.gateway_request_started`, `channels.gateway_response_received`, `channels.delivery_success` — all logged with operation context correlation. Auth recovery (410 reconciliation) is also instrumented at `driver.ts:277-301`.

### WARN — Entire deployment contract evaluation is debug-only (invisible in ring buffer)

- **Evidence**: `deployment-contract.ts:367`
- **Severity**: P2 (medium)
- **Detail**: The only log call in `deployment-contract.ts` is `logDebug("deployment_contract.built", ...)`. Per `log.ts:85`, debug entries are excluded from the ring buffer. In production, the entire contract evaluation — including all 8 `check*` functions — produces zero log entries visible via `getServerLogs()` or the admin logs panel. An operator investigating why preflight failed has no contract-level breadcrumbs.
- **Recommended fix**: Change the `deployment_contract.built` log from `logDebug` to `logInfo`. This is a single-line change with high diagnostic value.

### WARN — `resolvePublicOrigin` exception silently swallowed in two locations

- **Evidence**: `deploy-preflight.ts:434-437`, `deployment-contract.ts:94`
- **Severity**: P2 (medium)
- **Detail**: Both files wrap `resolvePublicOrigin()` in a bare `catch {}` that discards the exception. Downstream, `publicOrigin` silently becomes `null`, and the operator sees a generic "unable to resolve public origin" check failure with no indication that an exception was thrown or what it contained.
- **Recommended fix**: Add `logWarn("public_origin.resolution_failed", { error: String(err) })` inside the catch blocks.

### WARN — Blocking preflight failure logged at `info`, not `warn` or `error`

- **Evidence**: `deploy-preflight.ts:406` (`getLaunchVerifyBlocking`)
- **Severity**: P2 (medium)
- **Detail**: A blocking preflight failure — one that will skip all runtime launch verification phases — is logged at `logInfo` with `blocking: true`. A clean pass is also logged at `logInfo` with `blocking: false`. There is no severity distinction. Operators must parse the `blocking` field in the JSON payload to detect the failure; log-level filtering alone won't surface it.
- **Recommended fix**: Use `logWarn` when `blocking: true`.

### WARN — Watchdog route has zero logging

- **Evidence**: `watchdog/route.ts` (entire file, 36 lines)
- **Severity**: P2 (medium)
- **Detail**: The cron watchdog route does not import or call any function from `@/server/log`. Authorization failures (brute-force, misconfigured cron) are invisible in the ring buffer. Watchdog start, outcome, and thrown exceptions produce no structured log entries at the route level. A watchdog crash propagates as an unstructured 500 via Next.js's default error boundary.
- **Recommended fix**: Add `logInfo` at entry, `logInfo`/`logWarn` at exit based on `report.status`, and `logError` in a try/catch around `runSandboxWatchdog()`. Add `logWarn` for unauthorized attempts.

### WARN — `getAiGatewayAuthMode()` has no error handling in contract builder

- **Evidence**: `deployment-contract.ts:350`
- **Severity**: P2 (medium)
- **Detail**: `getAiGatewayAuthMode()` is awaited without a try/catch. If it throws (e.g., due to a network fetch for an OIDC token), the exception propagates unhandled out of `buildDeploymentContract`. The caller (`buildDeployPreflight`) also has no error handling around the contract build call. The entire preflight response would fail with an unstructured 500.
- **Recommended fix**: Wrap the call in a try/catch that falls back to `"unavailable"` and logs a warning.

### WARN — `logWarn` is never used in preflight or contract files

- **Evidence**: `deploy-preflight.ts`, `deployment-contract.ts`
- **Severity**: P3 (low)
- **Detail**: The `warn` log level is functionally dead in the two most critical diagnostic files. `logWarn` is imported in `deploy-preflight.ts` but never called. `deployment-contract.ts` does not import it at all. The middle severity tier between `info` and `error` is unused, making it harder to filter for conditions that need attention but aren't hard failures.
- **Recommended fix**: Adopt `logWarn` for: blocking preflight, sync failures, missing optional config, and exception swallows.

### WARN — `normalizePhaseExecutionValue` defaults missing `ok` to `true`

- **Evidence**: `launch-verify/route.ts:88`
- **Severity**: P3 (low)
- **Detail**: When a phase function returns an object without an explicit `ok` field, the normalizer defaults to `true`. A phase returning `{ message: "something bad" }` without `ok: false` would be logged and reported as a pass. This is a false-positive risk for future phase implementations.
- **Recommended fix**: Require `ok` to be explicitly set in phase return types. TypeScript can enforce this at compile time.

### WARN — `summarizePhaseDetailsForLog` only handles one `kind`

- **Evidence**: `launch-verify/route.ts:96-115`
- **Severity**: P3 (low)
- **Detail**: The function only handles `kind: "restorePrepared"` — the `default` branch returns `undefined`. Any new `details.kind` values added in the future will silently lose their detail summary in log entries.
- **Recommended fix**: Add a `default` case that includes the raw `kind` value in the log summary.

### WARN — `contractRequirementToAction` silently drops unmapped requirements

- **Evidence**: `deploy-preflight.ts:133`
- **Severity**: P3 (low)
- **Detail**: When `idMap[req.id]` returns `undefined` for a failing requirement, the requirement is silently dropped from the action list. No log is emitted for the unmapped case. A new contract requirement added without a corresponding action mapping would be invisible to operators.
- **Recommended fix**: Add a `logWarn` for unmapped requirement IDs during action list construction.

### PASS — Log correlation keys support cross-request tracing

- **Evidence**: `log.ts:155` (`matchesLogEntry`)
- **Detail**: `opId`, `requestId`, `channel`, `sandboxId`, `messageId` are all supported as correlation keys for filtering. This enables tracing a webhook delivery from ingress through driver to workflow completion.

### PASS — Log source inference from message prefix

- **Evidence**: `log.ts:17-41`
- **Detail**: Source is inferred from the dot-separated prefix of the message string (e.g., `"channels.wake_requested"` → source `"channels"`). This is a lightweight convention that avoids requiring callers to specify source explicitly. The fallback to `"system"` for unrecognized prefixes is safe.

## Recommended Fixes (ranked by severity)

### P2 — Address before launch

1. **Contract evaluation logging**: Change `logDebug` → `logInfo` for `deployment_contract.built`. (`deployment-contract.ts:367`)
2. **Public origin exception logging**: Add `logWarn` inside the catch blocks. (`deploy-preflight.ts:434-437`, `deployment-contract.ts:94`)
3. **Blocking preflight severity**: Use `logWarn` when `blocking: true`. (`deploy-preflight.ts:406`)
4. **Watchdog route logging**: Add entry/exit/error logs. (`watchdog/route.ts`)
5. **AI Gateway auth mode error handling**: Wrap in try/catch with fallback to `"unavailable"`. (`deployment-contract.ts:350`)

### P3 — Post-launch improvements

6. **Adopt `logWarn` in preflight/contract**: Use the middle severity tier for conditions that need attention. (`deploy-preflight.ts`, `deployment-contract.ts`)
7. **Require explicit `ok` in phase returns**: Prevent false-positive pass results. (`launch-verify/route.ts:88`)
8. **Handle unknown `details.kind` in log summary**: Include raw `kind` value. (`launch-verify/route.ts:96-115`)
9. **Log unmapped contract requirement IDs**: Prevent silent action drops. (`deploy-preflight.ts:133`)

## Release Recommendation

**Prelaunch-warning**: Launch-critical paths (channel driver, lifecycle transitions, launch verification phases) have good structured instrumentation. The main gaps are in the diagnostic/preflight layer: the deployment contract evaluation is invisible in production logs, public origin failures are swallowed, and the watchdog cron has no logging at all. The P2 items are low-effort, high-value fixes (mostly adding `logWarn` or changing `logDebug` → `logInfo`) that would significantly improve operator visibility during and after launch.
