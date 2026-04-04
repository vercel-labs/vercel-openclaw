# Error Handling & Observability Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: PASS (6 of 9 findings resolved; 1 P2 watchdog logging + 2 P3 items remain)

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

### PASS — Deployment contract evaluation now visible in ring buffer (RESOLVED)

- **Evidence**: `deployment-contract.ts:396` — `logInfo("deployment_contract.built", ...)`
- **Detail**: Previously `logDebug` (invisible in ring buffer). Now `logInfo`, so contract evaluation results are visible in the admin logs panel. The `deployment_contract.cron_secret_evaluated` log was also elevated from `logDebug` to `logInfo` at `deployment-contract.ts:169`.

### PASS — `resolvePublicOrigin` exception now logged in deploy-preflight (RESOLVED)

- **Evidence**: `deploy-preflight.ts:491-498` — try/catch with `logWarn("public_origin.resolution_failed", { error })` at line 494
- **Detail**: The bare `catch {}` in `buildDeployPreflight()` now logs the exception at warn level before setting `publicOriginResolution` to null. Operators see `public_origin.resolution_failed` in the ring buffer with the error message, including the request URL for correlation. Note: `deployment-contract.ts:87-107` (`checkPublicOrigin`) still uses a bare catch, but that path produces a structured requirement with a descriptive message, so the silent swallow there is acceptable.
- **Operator consequence**: Without this fix, a broken origin resolution (e.g. malformed `NEXT_PUBLIC_APP_URL`) would silently degrade the preflight payload — `publicOrigin` would be `null` and `publicOriginResolution` would be `null` with no log entry explaining why. Operators would see a failing `public-origin` check but no breadcrumb pointing to the root cause.

### PASS — Blocking preflight failure now logged at `warn` severity (RESOLVED)

- **Evidence**: `deploy-preflight.ts:463` — `logWarn("launch_verify.blocking_check", { blocking: true, ... })`; `deploy-preflight.ts:439` — `logInfo("launch_verify.blocking_check", { blocking: false, ... })`
- **Detail**: Previously both blocking and non-blocking outcomes were logged at `logInfo`. Now the `getLaunchVerifyBlocking()` function at `deploy-preflight.ts:424-478` splits severity: a blocking preflight failure (failing checks present) is logged at `logWarn` (line 463), while a non-blocking result is logged at `logInfo` (line 439). This makes true launch-stoppers stand out in the ring buffer and log aggregation filters.
- **Operator consequence**: Without this split, operators filtering logs by severity would not be able to distinguish "preflight passed, proceeding to runtime phases" from "preflight failed, all runtime phases skipped". In a ring buffer with 1000 entries, blocking events at info level could be buried by routine polling logs.

### WARN — Watchdog route has zero logging

- **Evidence**: `watchdog/route.ts` (entire file, 36 lines)
- **Severity**: P2 (medium)
- **Detail**: The cron watchdog route does not import or call any function from `@/server/log`. Authorization failures (brute-force, misconfigured cron) are invisible in the ring buffer. Watchdog start, outcome, and thrown exceptions produce no structured log entries at the route level. A watchdog crash propagates as an unstructured 500 via Next.js's default error boundary.
- **Recommended fix**: Add `logInfo` at entry, `logInfo`/`logWarn` at exit based on `report.status`, and `logError` in a try/catch around `runSandboxWatchdog()`. Add `logWarn` for unauthorized attempts.

### PASS — `getAiGatewayAuthMode()` now failure-tolerant in contract builder (RESOLVED)

- **Evidence**: `deployment-contract.ts:370-378` — try/catch with `logWarn("deployment_contract.ai_gateway_auth_failed", ...)` at line 374; fallback to `"unavailable"`
- **Detail**: Previously an unhandled throw from `getAiGatewayAuthMode()` would propagate through `buildDeploymentContract()` → `buildDeployPreflight()` (line 488) → `/api/admin/preflight`, producing an unstructured 500. Now the call is wrapped in a try/catch that logs the error at warn level and falls back to `"unavailable"`, allowing preflight to return a structured diagnostic payload even when OIDC resolution fails.
- **Operator consequence**: Without this fix, a transient OIDC endpoint failure would take down the entire preflight API with no structured error output. Operators would see an unstructured 500 in their browser with no actionable log entry explaining the root cause.

### PASS — `logWarn` now actively used in preflight and contract files (RESOLVED)

- **Evidence**: `deployment-contract.ts:10` imports `logWarn`; `deploy-preflight.ts:20` imports `logWarn`
- **Detail**: Both files now use `logWarn` for conditions that need operator attention: AI Gateway auth failure (`deployment-contract.ts:374`), public origin resolution failure (`deploy-preflight.ts:494`), blocking preflight check (`deploy-preflight.ts:463`), and unmapped requirement IDs (`deploy-preflight.ts:207`).

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

### PASS — `contractRequirementToAction` now warns on unmapped requirements (RESOLVED)

- **Evidence**: `deploy-preflight.ts:206-211` — `logWarn("deploy_preflight.action_mapping_missing", { requirementId, requirementStatus })` inside `contractRequirementToAction()` at line 193
- **Detail**: When a failing requirement ID is not in the `idMap` (line 198-203) and not in `EXPLICITLY_HANDLED_REQUIREMENT_IDS` (line 185-191: `public-origin`, `webhook-bypass`, `store`, `ai-gateway`, `cron-secret`), a warn log is emitted. This catches future contract requirements that lack a corresponding action mapping without false-positives for requirements handled by `pushRequirementAction`.
- **Operator consequence**: Without this warning, a new deployment contract requirement (e.g. a future `session-rotation` check) that fails but lacks a preflight action mapping would silently disappear from the operator's remediation list. The check would show as failing, but no action would tell the operator how to fix it.

#### Remediation mapping coverage analysis

All 9 `DeploymentRequirementId` values defined in `src/shared/deployment-requirements.ts:6-15` are accounted for in `contractRequirementToAction()` at `deploy-preflight.ts:193-222`:

| Requirement ID | Handling mechanism | Location |
|---|---|---|
| `public-origin` | `EXPLICITLY_HANDLED_REQUIREMENT_IDS` + `pushRequirementAction` | `deploy-preflight.ts:186,255` |
| `webhook-bypass` | `EXPLICITLY_HANDLED_REQUIREMENT_IDS` + conditional push | `deploy-preflight.ts:187,260-270` |
| `store` | `EXPLICITLY_HANDLED_REQUIREMENT_IDS` + `pushRequirementAction` | `deploy-preflight.ts:188,256` |
| `ai-gateway` | `EXPLICITLY_HANDLED_REQUIREMENT_IDS` + `pushRequirementAction` | `deploy-preflight.ts:189,257` |
| `cron-secret` | `EXPLICITLY_HANDLED_REQUIREMENT_IDS` + `pushRequirementAction` | `deploy-preflight.ts:190,258` |
| `openclaw-package-spec` | `idMap` → `configure-openclaw-package-spec` | `deploy-preflight.ts:199` |
| `oauth-client-id` | `idMap` → `configure-oauth` | `deploy-preflight.ts:200` |
| `oauth-client-secret` | `idMap` → `configure-oauth` | `deploy-preflight.ts:201` |
| `session-secret` | `idMap` → `configure-oauth` | `deploy-preflight.ts:202` |

**Verdict**: No current requirement ID can silently disappear. The `logWarn("deploy_preflight.action_mapping_missing")` guard at line 206-211 is a safety net for future requirement IDs added to `DeploymentRequirementId` without a corresponding action mapping. On the current codebase, this warn path is unreachable — all IDs are mapped. Severity: **informational** (no fix needed, defensive code is already in place).

### PASS — Log correlation keys support cross-request tracing

- **Evidence**: `log.ts:155` (`matchesLogEntry`)
- **Detail**: `opId`, `requestId`, `channel`, `sandboxId`, `messageId` are all supported as correlation keys for filtering. This enables tracing a webhook delivery from ingress through driver to workflow completion.

### PASS — Log source inference from message prefix

- **Evidence**: `log.ts:17-41`
- **Detail**: Source is inferred from the dot-separated prefix of the message string (e.g., `"channels.wake_requested"` → source `"channels"`). This is a lightweight convention that avoids requiring callers to specify source explicitly. The fallback to `"system"` for unrecognized prefixes is safe.

## Recommended Fixes (ranked by severity)

### P2 — Address before launch

1. ~~**Contract evaluation logging**: Change `logDebug` → `logInfo` for `deployment_contract.built`.~~ **RESOLVED** (`deployment-contract.ts:396`)
2. ~~**Public origin exception logging**: Add `logWarn` inside the catch blocks.~~ **RESOLVED** (`deploy-preflight.ts:494`)
3. ~~**Blocking preflight severity**: Use `logWarn` when `blocking: true`.~~ **RESOLVED** (`deploy-preflight.ts:463`)
4. **Watchdog route logging**: Add entry/exit/error logs. (`watchdog/route.ts`) — still open
5. ~~**AI Gateway auth mode error handling**: Wrap in try/catch with fallback to `"unavailable"`.~~ **RESOLVED** (`deployment-contract.ts:370-378`)

### P3 — Post-launch improvements

6. ~~**Adopt `logWarn` in preflight/contract**: Use the middle severity tier.~~ **RESOLVED** (both files now import and use `logWarn`)
7. **Require explicit `ok` in phase returns**: Prevent false-positive pass results. (`launch-verify/route.ts:88`)
8. **Handle unknown `details.kind` in log summary**: Include raw `kind` value. (`launch-verify/route.ts:96-115`)
9. ~~**Log unmapped contract requirement IDs**: Prevent silent action drops.~~ **RESOLVED** (`deploy-preflight.ts:206-211`)

## Release Recommendation

**Release-safe**: The deployment-contract → deploy-preflight → launch-verify seam is now failure-tolerant and observable. `getAiGatewayAuthMode()` throwing no longer takes down preflight with an unstructured 500 (`deployment-contract.ts:370-378`). Public origin resolution failures are logged at warn level (`deploy-preflight.ts:494`). Blocking preflight is distinguishable by log severity — `logWarn` at `deploy-preflight.ts:463` vs `logInfo` at `deploy-preflight.ts:439`. Contract evaluation is visible in the ring buffer (`deployment-contract.ts:396`). Unmapped requirement IDs are warned (`deploy-preflight.ts:207`). The one remaining P2 item (watchdog route logging) is isolated to the cron path and does not affect the operator-facing diagnostic pipeline.
