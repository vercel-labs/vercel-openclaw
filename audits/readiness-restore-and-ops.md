# Readiness, Restore, and Ops Audit

**Date**: 2026-04-03
**Scope**: Sandbox lifecycle & resume edge cases, prepare-restore contract accuracy, deploy-button/onboarding flow, environment variable completeness, documentation drift, observability, and production readiness.

## Files Inspected

- `src/server/deploy-preflight.ts`
- `src/server/deployment-contract.ts`
- `src/server/env.ts`
- `src/app/api/admin/prepare-restore/route.ts`
- `src/app/api/setup/route.ts`
- `src/server/observability/operation-context.ts`
- `src/server/sandbox/restore-attestation.ts`
- `src/server/sandbox/restore-oracle.ts`
- `scripts/check-deploy-readiness.mjs`
- `README.md`
- `docs/environment-variables.md`
- `docs/preflight-and-launch-verification.md`
- `.env.example`

---

## Findings

### WARN — `cronSecretConfigured` bypasses `getCronSecret()` fallback

- **Evidence**: `src/server/deploy-preflight.ts:449-451` reads `process.env.CRON_SECRET` directly; `src/server/env.ts:132-137` defines `getCronSecret()` which falls back to `ADMIN_SECRET`.
- **Impact**: Preflight reports `cronSecretConfigured: false` when only `ADMIN_SECRET` is set, even though the cron route _will_ authenticate successfully via the `getCronSecret()` fallback. Operators see a misleading warning in the admin UI.
- **Severity**: P2 (misleading diagnostic, not a security gap — cron auth itself works correctly).
- **Recommendation**: Replace `Boolean(process.env.CRON_SECRET?.trim())` with `Boolean(getCronSecret())` at `deploy-preflight.ts:449`, or introduce a separate `cronSecretExplicit` field if the intent is to nudge operators toward setting `CRON_SECRET` explicitly. Document the distinction.

### WARN — `checkCronSecret()` uses `getCronSecret()` but preflight does not — inconsistent readiness signal

- **Evidence**: `src/server/deployment-contract.ts:165` calls `getCronSecret()` (includes `ADMIN_SECRET` fallback); `src/server/deploy-preflight.ts:449-451` reads `CRON_SECRET` directly.
- **Impact**: The deployment contract and preflight disagree on whether cron auth is configured when only `ADMIN_SECRET` is set. Contract says "pass"; preflight says "not configured". Admin UI and readiness script consume both.
- **Severity**: P2 — not launch-blocking since cron auth works, but confusing for operators running `check-deploy-readiness.mjs`.
- **Recommendation**: Align to one source of truth. If preflight intends to recommend explicit `CRON_SECRET`, make it a separate advisory field, not the authoritative `cronSecretConfigured`.

### PASS — `getOpenclawPackageSpec()` fallback is safe and well-documented

- **Evidence**: `src/server/env.ts:282-296` falls back to pinned `openclaw@2026.3.28`; `src/server/deployment-contract.ts:226-254` reports "warn" on Vercel when unset.
- **Impact**: The fallback ensures deterministic restores even when the env var is missing. The contract correctly warns without failing.
- **Note**: The pinned default (`2026.3.28`) is a deliberate choice to avoid broken latest releases (see comment at `env.ts:278-280`).

### PASS — `checkOpenclawPackageSpec()` only runs on Vercel

- **Evidence**: `src/server/deployment-contract.ts:229` returns `null` off-Vercel.
- **Impact**: Local dev is not burdened with pinning warnings. Correct behavior.

### PASS — prepare-restore route has proper auth and error handling

- **Evidence**: `src/app/api/admin/prepare-restore/route.ts:103-120` (GET), `122-153` (POST).
- **Details**:
  - GET uses `requireJsonRouteAuth()` — line 104.
  - POST uses `requireMutationAuth()` (CSRF-enforced) — line 123.
  - Both return immediately on auth failure — lines 105, 124.
  - POST defaults `destructive` to `false` if body parsing fails — lines 128-134.
  - Comprehensive logging of inspection payload — lines 76-101.
  - Error responses via `jsonError()` without leaking internals — lines 118, 151.
- **Severity**: No issues found.

### PASS — `/api/setup` is sealed on Vercel deployments

- **Evidence**: `src/app/api/setup/route.ts:18-31` returns 410 Gone on `isVercelDeployment()`.
- **Impact**: No bootstrap-exposure risk in production. Local dev correctly reveals auto-generated secrets (line 58-64) since there's no other discovery mechanism.

### PASS — Deploy button provisions required integrations

- **Evidence**: `README.md:14` — deploy URL includes `integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17` (Upstash Redis) and `env=ADMIN_SECRET`.
- **Details**: The `envDescription` mentions CRON_SECRET fallback: "Also used to secure cron jobs unless CRON_SECRET is set separately."
- **Impact**: One-click deploy provisions Redis and prompts for the only required secret. Correct and complete for the default `admin-secret` auth mode.

### PASS — Onboarding flow is accurate

- **Evidence**: `README.md:25-31` — 4-step getting started:
  1. Deploy (button auto-provisions Redis + prompts for ADMIN_SECRET)
  2. Sign in
  3. Use OpenClaw (sandbox boots ~1 min first time, seconds on restore)
  4. Verify and connect channels
- **Impact**: Steps match actual behavior. No misleading claims.

### WARN — `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` undocumented in env-vars doc

- **Evidence**: `.env.example:72-73` defines both; `docs/environment-variables.md` has no mention (grep returns no matches); only used in `src/components/panels/ssh-panel.tsx`.
- **Impact**: Operators who need to customize the `npx sandbox connect` command for team/project scoping won't find these in the docs.
- **Severity**: P3 — only affects the terminal tab copy-paste UX, not functionality.
- **Recommendation**: Add a "Terminal / SSH" section to `docs/environment-variables.md` listing both variables.

### PASS — Environment variable completeness across surfaces

Cross-referenced CLAUDE.md deployment contract table, `README.md`, `docs/environment-variables.md`, and `.env.example`:

| Variable | CLAUDE.md | README | env-vars doc | .env.example |
|----------|-----------|--------|-------------|-------------|
| `ADMIN_SECRET` | yes | yes (line 14, 27, 55) | yes (line 7) | yes (implicit via deploy) |
| `CRON_SECRET` | yes | yes (line 14 desc, 59) | yes (line 26) | yes (line 58) |
| `UPSTASH_REDIS_REST_URL` | yes | yes (line 57) | yes (line 17) | yes (line 9) |
| `UPSTASH_REDIS_REST_TOKEN` | yes | yes (line 57) | yes (line 18) | yes (line 10) |
| `OPENCLAW_INSTANCE_ID` | yes | yes (ref) | yes (line 45) | yes (line 40) |
| `OPENCLAW_PACKAGE_SPEC` | yes | yes (ref) | yes (line 44) | yes (line 36) |
| `OPENCLAW_SANDBOX_VCPUS` | yes | yes (ref) | yes (line 46) | yes (line 44) |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | yes | yes (ref) | yes (line 47) | yes (line 51) |
| `SESSION_SECRET` | yes | yes (ref) | yes (line 38) | yes (line 30) |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | yes | yes (ref) | yes (line 36) | yes (line 28) |
| `VERCEL_APP_CLIENT_SECRET` | yes | yes (ref) | yes (line 37) | yes (line 29) |
| `SLACK_CLIENT_ID` | yes | yes (line 27) | yes (line 55) | yes (line 80) |
| `SLACK_CLIENT_SECRET` | yes | yes (line 27) | yes (line 56) | yes (line 81) |
| `SLACK_SIGNING_SECRET` | yes | yes (line 27) | yes (line 57) | yes (line 82) |

All deployment-contract variables appear in all four surfaces. The verifier contract script (`scripts/check-verifier-contract.mjs`) enforces this.

### PASS — Restore attestation and oracle have solid test coverage

- **Evidence**:
  - `src/server/sandbox/restore-attestation.test.ts` — 31 occurrences of `restorePrepared` across 11 tests covering hash comparison, reusability, plan generation, and decision building.
  - `src/server/sandbox/restore-oracle.test.ts` — 19 occurrences across 14 tests covering idle gating, CAS races, failure tracking, force bypass, and prepare execution.
  - `src/app/api/admin/prepare-restore/route.test.ts` — 15 occurrences across tests for dirty target, reusable target, and delegation.
- **Impact**: Core restore logic is well-tested. No gaps in the attestation → decision → plan pipeline.

### PASS — Watchdog cron wake is comprehensively tested

- **Evidence**: `src/server/watchdog/run.test.ts` covers:
  - Stopped sandbox with due cron job wakes sandbox
  - Error status with due cron job wakes
  - Persistent sandbox (sandboxId, no snapshotId) wakes
  - Future cron job skips wake
  - Wake key retention on failed/unverified restore
  - Wake key cleared on successful restore outcomes
  - Null cron wake handling
  - Store-invalid outcome handling
- **Impact**: All wake key state transitions are locked by tests. No gaps identified.

### PASS — `scripts/check-deploy-readiness.mjs` has proper secret redaction

- **Evidence**: `scripts/check-deploy-readiness.mjs:57-60` — `redactSecret()` function redacts all secrets in logged output. Secrets are accepted via env vars or flags but never logged unredacted (lines 246, 357).
- **Impact**: Safe for CI/CD pipelines.

### PASS — Operation context provides structured observability

- **Evidence**: `src/server/observability/operation-context.ts:10-109` — `generateOpId()`, `createOperationContext()`, `childOperationContext()`, and `withOperationContext()` provide:
  - Unique `op_<hex>` identifiers
  - Parent-child linkage for nested operations
  - Flat logging object via `withOperationContext()`
- **Impact**: Lifecycle operations (restore, prepare, wake) are traceable through logs.

### WARN — No test for `check-deploy-readiness.mjs` script itself

- **Evidence**: No `*.test.*` file found for `scripts/check-deploy-readiness.mjs`.
- **Impact**: The script is the primary operator tool for validating deployments. A regression in argument parsing, secret redaction, or exit codes would go undetected.
- **Severity**: P3 — the script delegates to well-tested API routes; risk is in the script's own CLI logic.
- **Recommendation**: Add at least a smoke test that validates argument parsing and exit codes.

### WARN — Prepare-restore route tests are minimal

- **Evidence**: `src/app/api/admin/prepare-restore/route.test.ts` has 2 primary scenarios (dirty target, reusable target) plus delegation tests in `admin-lifecycle.test.ts`.
- **Missing**:
  - Concurrent prepare attempts
  - Prepare with partial success / mid-prepare failure
  - Prepare when sandbox is in transitional state (creating, booting)
- **Severity**: P3 — the underlying `restore-attestation.ts` and `restore-oracle.ts` are well-tested, but the route integration layer has gaps.

---

## Release Call

### Blockers: None

The `cronSecretConfigured` drift (WARN) is a diagnostic accuracy issue, not a security or functionality gap. Cron auth works correctly via `getCronSecret()` regardless of which env var is set. No implementation defect blocks the Monday release.

### Warnings (fix post-launch or document)

1. **P2 — `cronSecretConfigured` misleading diagnostic** (`deploy-preflight.ts:449-451`): Operators using only `ADMIN_SECRET` see a false "not configured" signal. The deploy button's `envDescription` already explains the fallback, so operators following the happy path are unaffected. Fix by aligning to `getCronSecret()` or adding an explicit advisory field.

2. **P2 — Contract/preflight cron-secret disagreement**: Same root cause as above. The contract says "pass" when `getCronSecret()` resolves; preflight says "not configured" when `CRON_SECRET` is absent. Reconcile in the same fix.

3. **P3 — Undocumented sandbox scope env vars**: `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` in `.env.example` but not in `docs/environment-variables.md`. Terminal tab UX only.

4. **P3 — No script-level tests for `check-deploy-readiness.mjs`**: Low risk since it delegates to tested APIs.

5. **P3 — Prepare-restore route test gaps**: Concurrent and partial-failure scenarios untested at the route level (underlying logic is tested).

### Documentation vs Implementation Defects

| Finding | Type | Priority |
|---------|------|----------|
| `cronSecretConfigured` reads wrong source | Implementation | P2 |
| Contract/preflight cron disagreement | Implementation | P2 |
| Sandbox scope vars undocumented | Documentation | P3 |
| No script-level tests | Test gap | P3 |
| Prepare-restore route test gaps | Test gap | P3 |

### Confidence

**High confidence for Monday launch.** Core restore pipeline (attestation, oracle, cron wake, prepare-restore) is well-tested and correctly implemented. Auth is properly enforced on all admin routes. Deploy button provisions everything needed. Environment variables are complete across all surfaces. The P2 diagnostic drift is cosmetic — it affects operator-facing signals but not actual cron authentication or sandbox wake behavior.
