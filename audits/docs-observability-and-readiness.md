# Documentation Accuracy, Error Handling & Observability, Test Coverage, and Production Readiness Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit (iteration 3)
**Verdict**: **Ready for Monday launch** — no launch blockers; documentation drift and observability gaps are post-launch P2/P3

## Scope

This audit consolidates four concerns into a single document:

1. Documentation drift (README, CLAUDE.md, CONTRIBUTING.md, docs/)
2. Observability gaps (structured logging, error context, metrics)
3. Test coverage gaps (untested routes and server modules)
4. Overall production readiness verdict

Cross-references individual audit files where deeper detail exists.

---

## 1. Documentation Drift

### FAIL — `OPENCLAW_PACKAGE_SPEC` fallback docs say `openclaw@latest`; code uses pinned version

- **Evidence**: `src/server/env.ts:282` — `const OPENCLAW_DEFAULT_PACKAGE_SPEC = "openclaw@2026.3.28"`
- **Affected files**:
  - `CLAUDE.md:155` — "runtime falls back to `openclaw@latest`"
  - `CLAUDE.md:553` — "Defaults to `openclaw@latest` when unset"
  - `CONTRIBUTING.md:150` — "defaults to `openclaw@latest`"
  - `docs/environment-variables.md:44` — "falls back to `openclaw@latest`"
  - `.env.example:33-34` — "falls back to openclaw@latest"
- **Severity**: P2 — misleads operators about which OpenClaw version gets installed
- **Status**: Open (also tracked as EV-1 in [env-var-completeness.md](env-var-completeness.md))
- **Fix**: Update all references to say the fallback is a pinned known-good version.

### WARN — CLAUDE.md launch-verify phase list is incomplete

- **Evidence**: `CLAUDE.md:76` lists 5 phases; actual code in `src/app/api/admin/launch-verify/route.ts` implements 6 phases including `restorePrepared`
- **Detail**: Line 76 says "Runtime phases are `preflight`, `queuePing`, `ensureRunning`, `chatCompletions`, and `wakeFromSleep`" but omits `restorePrepared`. The docs/api-reference.md file correctly lists all 6.
- **Severity**: P3 — internal contributor doc, not operator-facing
- **Fix**: Add `restorePrepared` to the phase list at CLAUDE.md:76.

### WARN — Route tables are abridged

- **Evidence**: CLAUDE.md documents 13 of ~61 actual routes; CONTRIBUTING.md documents 20
- **Detail**: Many operational routes (`/api/auth/*`, `/api/firewall/*`, `/api/debug/*`, `/api/channels/*/`) are absent from the route tables. The tables cover the "core" routes accurately but give an incomplete picture.
- **Severity**: P3 — the missing routes are findable in the source tree
- **Fix**: Either expand the tables or add a note directing readers to `src/app/api/` for the complete list.

### WARN — `ADMIN_SECRET` missing from `.env.example`

- **Evidence**: `.env.example` does not include `ADMIN_SECRET` (not even commented)
- **Detail**: This is the "only required variable" per README. Auto-generation mitigates local dev, but operators who clone and configure manually miss it.
- **Severity**: P2 (also tracked as EV-2 in [env-var-completeness.md](env-var-completeness.md))
- **Fix**: Add `ADMIN_SECRET=` as the first entry in `.env.example`.

### PASS — CLI commands match package.json

- **Evidence**: All commands documented in README, CLAUDE.md, and CONTRIBUTING.md (`npm run dev`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `node scripts/verify.mjs`) exist in `package.json`.

### PASS — docs/ directory is comprehensive and accurate

- **Evidence**: 8 reference docs covering environment variables, API reference, deployment protection, channels, contributing, and more. Content aligns with code reality.

---

## 2. Observability Gaps

### PASS — Structured logging is the primary instrumentation

- **Evidence**: 579 structured log calls across non-test source files (322 `logInfo`, 180 `logWarn`, 55 `logError`, 22 `logDebug`)
- **Detail**: The ring buffer correctly excludes debug entries to preserve operational logs. Channel webhooks, lifecycle transitions, and workflow events are well-instrumented with operation context.

### WARN — Silent bare catch blocks in API routes

- **Evidence**: ~18 bare `catch {}` or `catch { return }` blocks in `src/app/api/` routes
- **Key locations**:
  - `src/app/api/admin/snapshots/delete/route.ts:25` — silent JSON parse
  - `src/app/api/admin/ssh/route.ts:28` — silent JSON parse
  - `src/app/api/admin/channel-secrets/route.ts:185` — silent JSON parse
  - `src/app/api/channels/telegram/webhook/route.ts:85` — silent webhook parse
  - `src/app/api/channels/whatsapp/webhook/route.ts:119` — silent webhook parse
  - `src/app/api/channels/slack/webhook/route.ts:168` — silent webhook parse
  - `src/app/api/channels/discord/webhook/route.ts:89` — silent webhook parse
- **Severity**: P3 — these are intentional "invalid JSON → return 200" patterns for webhook routes (provider retries are unnecessary for malformed payloads). Admin route silent parses are lower risk since they're auth-gated.
- **Fix**: Consider adding `logDebug` to admin route JSON parse failures for troubleshooting.

### WARN — `console.*` calls bypass structured logging

- **Evidence**:
  - `src/app/api/debug/sandbox-timing/route.ts:66` — `console.error`
  - `src/server/proxy/htmlInjection.ts:72,83,171` — `console.warn`
  - `src/server/openclaw/config.ts:486,603,799,899,905,986,1008-1010,1071,1077,1109` — multiple direct console calls
  - `src/server/smoke/remote-smoke.ts` — console-based reporting (intentional for CLI output)
- **Severity**: P3 — debug routes and smoke tests are not production-critical paths. `config.ts` console calls are during sandbox setup (not request-path).
- **Fix**: Convert `config.ts` console calls to structured logging when they contain operational information.

### WARN — `lastRestoreMetrics` only recorded on success

- **Evidence**: `src/server/sandbox/lifecycle.ts` — metrics are saved after successful restore only
- **Detail**: If restore fails mid-phase, no partial timing data is persisted. This makes debugging slow restores harder when the failure is intermittent.
- **Severity**: P3 — the error itself is logged; only the timing breakdown is lost.
- **Fix**: Consider recording partial metrics on failure with a `failedAtPhase` marker.

### PASS — Channel webhook routes have full operation context

- **Evidence**: All four channel webhook routes (Slack, Telegram, WhatsApp, Discord) create `OperationContext` and wrap log calls with `withOperationContext()`.

### PASS — Watchdog reports include per-check diagnostics

- **Evidence**: `WatchdogReport` contains `{ id, status, durationMs, message }` entries per check. `watchdog.run_completed` logs deployment ID, status, and consecutive failures.

---

## 3. Test Coverage Gaps

### Overview

- **61 API route files** — 34 tested (56%), 27 untested
- **~83 server modules** — 66 tested (79%), 17 untested
- **Test framework**: Node.js built-in `--test` runner via `scripts/test.mjs`

### WARN — Auth routes have zero test files

- **Untested**:
  - `src/app/api/auth/login/route.ts`
  - `src/app/api/auth/authorize/route.ts`
  - `src/app/api/auth/callback/route.ts`
  - `src/app/api/auth/signout/route.ts`
- **Mitigating**: Auth logic is tested indirectly through `src/server/auth/` module tests (session.ts, vercel-auth.ts, csrf.ts all have tests). Route-level auth is tested via the test harness `requireAdminAuth` integration.
- **Severity**: P2 — the auth modules themselves are tested; route handlers are thin wrappers.

### WARN — Discord has zero route-level tests

- **Untested**:
  - `src/app/api/channels/discord/webhook/route.ts`
  - `src/app/api/channels/discord/route.ts`
  - `src/app/api/channels/discord/register-command/route.ts`
- **Also untested server modules**: `discord/adapter.ts`, `discord/discord-api.ts`, `discord/commands.ts`, `discord/reconcile.ts`, `discord/application.ts`
- **Severity**: P2 — Discord is experimental, but Ed25519 signature verification is untested.
- **Status**: Open (also tracked as CW-5 in [channel-webhook-reliability.md](channel-webhook-reliability.md))

### WARN — Debug and firewall operational routes untested

- **Untested**: All 9 `/api/debug/*` routes, 4 of 9 `/api/firewall/*` routes (ingest, learned, report, sync)
- **Severity**: P3 — debug routes are gated behind `ENABLE_DEBUG_ROUTES`. Firewall core logic is tested; untested routes are thin wrappers.

### WARN — Upstash store (`upstash-store.ts`) untested

- **Evidence**: `src/server/store/upstash-store.ts` has no test file
- **Detail**: The memory store is tested, and the store interface contract tests exist, but the Upstash Lua scripts (lock, metadata operations) are not tested against a real or mocked Upstash instance.
- **Severity**: P2 — production store backend. Lua script correctness is assumed but not verified.

### PASS — Critical path has strong coverage

- **Evidence**: Sandbox lifecycle, channel webhooks (Slack/Telegram/WhatsApp), firewall core, proxy, public-url, deployment contract, and store contract all have comprehensive tests.

---

## 4. Production Readiness Verdict

### Launch Blockers

**None.** No FAIL-severity finding prevents a Monday launch.

### Near-Term Risks (P2 — fix soon after launch)

| # | Issue | Section | Risk |
|---|---|---|---|
| 1 | `OPENCLAW_PACKAGE_SPEC` docs say `@latest`, code pins `@2026.3.28` | Docs §1 | Operator confusion about installed version |
| 2 | `ADMIN_SECRET` missing from `.env.example` | Docs §1 | Manual-clone operators miss required variable |
| 3 | Discord channel has zero test coverage | Tests §3 | Ed25519 signature verification untested |
| 4 | Auth route handlers have no direct tests | Tests §3 | Route-level edge cases untested (modules are tested) |
| 5 | Upstash store Lua scripts untested | Tests §3 | Lock race conditions in production |

### Items That Can Safely Defer Past Monday

| Issue | Section | Why Deferrable |
|---|---|---|
| CLAUDE.md phase list incomplete | Docs §1 | Internal contributor doc, not operator-facing |
| Route tables abridged | Docs §1 | Routes are discoverable in source |
| Silent JSON parse catches in admin routes | Observability §2 | Auth-gated, low-risk |
| `console.*` bypasses in config.ts | Observability §2 | Setup-time only, not request-path |
| Partial restore metrics on failure | Observability §2 | Error is still logged; timing breakdown is nice-to-have |
| Debug/firewall route tests | Tests §3 | Behind feature flags or thin wrappers |

### What's Working Well

- **Channel webhook reliability**: Consistent dedup, signature validation, fast-path forwarding, and retryable 500 on failure across all channels. CW-1 through CW-4 are fixed with test coverage.
- **Auth system**: Encrypted sessions, timing-safe comparison, CSRF enforcement, PKCE, rate limiting.
- **Proxy security**: Auth gates HTML injection, redirects blocked, path traversal rejected.
- **Structured observability**: 579 structured log calls, ring buffer with debug exclusion, restore metrics, watchdog reports.
- **Deployment contract**: 11 env vars validated across 4 doc files with automated verifier script.
- **Test infrastructure**: 122 test files covering critical paths with comprehensive harness (fake sandbox controller, fake fetch, route caller).

### Conclusion

The codebase is **production-ready for Monday launch**. The critical path — deployment, authentication, sandbox lifecycle, proxy, channel webhooks, and firewall — is well-implemented and tested. Documentation drift (EV-1) is the most important post-launch fix because it directly affects operator expectations about which OpenClaw version gets installed. All other findings are hardening opportunities, not functional gaps.
