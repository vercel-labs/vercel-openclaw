# Test Coverage Gaps Audit

**Date**: 2026-04-04 (updated)
**Auditor**: Automated pre-launch audit
**Verdict**: WARN — no launch blockers; several P2 gaps in experimental and infrastructure modules

## Scope

- Test file inventory vs source module inventory
- Critical subsystem coverage assessment
- Test infrastructure and tooling
- Security-sensitive untested paths

## Findings

### Overview

- **~194 source modules** (excluding tests)
- **~66 test files** exist
- **Estimated coverage**: ~63% of modules have corresponding tests
- **Test framework**: Node.js built-in `--test` runner via `scripts/test.mjs`
- **No coverage tooling** configured (no c8, nyc, or jest --coverage)

### PASS — Well-tested subsystems

| Subsystem | Test Files | Status |
|---|---|---|
| Firewall (policy, domains, state, sync, logging) | 5 test files | Comprehensive |
| Public URL resolution | 3 test files (contract, diagnostics, unit) | Comprehensive |
| Deploy preflight & contract | 3 test files | Comprehensive |
| Sandbox lifecycle (create, resume, stop, timeout, cron) | lifecycle.test.ts, controller.test.ts, cron-persistence.test.ts, hot-spare.test.ts, timeout.test.ts | Core paths covered |
| Channel core (queue, history, driver, state, keys, webhook-urls) | 8+ test files | Good coverage |
| Channel adapters (Slack, Telegram, WhatsApp) | adapter.test.ts + bot-api.test.ts per channel | Good coverage |
| Auth enforcement (session, CSRF, route-auth, vercel-auth) | 5 test files including auth-enforcement.test.ts | Integration + unit |
| Store (memory, keyspace, contract) | 4 test files | Good coverage |
| OpenClaw config & bootstrap | config.test.ts, bootstrap.test.ts, restore-assets.test.ts | Good coverage |
| Proxy / HTML injection | proxy-route-utils.test.ts, htmlInjection.test.ts, waitingPage.test.ts | Tested |
| Observability | operation-context.test.ts | Partial |

### PASS — Auth CSRF ordering is correct and covered by integration tests

- **Evidence**: `src/server/auth/admin-auth.ts:69-120` — `resolveAdminCredential()` checks cookie presence at line 89-98 before calling `verifyCsrf()` at line 102-111
- **Detail**: The mutation auth path correctly returns 401 for cookieless requests and only enforces CSRF when a session cookie is present. Bearer requests skip CSRF entirely. Integration tests in `src/app/api/auth/auth-enforcement.test.ts` exercise the route-level auth dispatch at `src/server/auth/route-auth.ts:13-24`.
- **Gap**: No dedicated unit test for `admin-auth.ts` — the integration tests cover the happy path and basic error cases, but edge cases like malformed cookie values, expired sessions hitting CSRF before decryption, and concurrent bearer+cookie headers are untested.

### FAIL — Discord channel has zero test coverage

- **Evidence**: No test files exist for any Discord module
- **Files untested**:
  - `src/server/channels/discord/adapter.ts` (~392 lines) — Ed25519 signature verification, message extraction
  - `src/server/channels/discord/application.ts` (~141 lines) — API integration, token validation
  - `src/server/channels/discord/discord-api.ts` (~45 lines) — message sending, rate limiting
  - `src/server/channels/discord/commands.ts` — command registration
  - `src/server/channels/discord/reconcile.ts` (~24 lines) — state reconciliation
  - `src/app/api/channels/discord/webhook/route.ts` — webhook endpoint
  - `src/app/api/channels/discord/register-command/route.ts` — command registration endpoint
  - `src/app/api/channels/discord/route.ts` — channel config endpoint
- **Risk**: Signature spoofing, silent message loss, untested error paths
- **Severity**: P2 (Discord is marked "experimental" which mitigates risk, but Ed25519 signature verification is security-critical)

### WARN — Auth core modules lack direct unit tests

- **Evidence**: No dedicated test file for `src/server/auth/admin-auth.ts` (211 lines) or `src/server/auth/rate-limit.ts` (~112 lines)
- **Mitigating factor**: `src/app/api/auth/auth-enforcement.test.ts` provides integration coverage of the auth layer at the route level
- **Untested edge cases**:
  - `admin-auth.ts:35-38` — `timingSafeStringEqual()` with empty strings, equal-length non-matching buffers
  - `admin-auth.ts:41-45` — `extractBearerToken()` with malformed Authorization headers (double spaces, missing scheme)
  - `admin-auth.ts:48-57` — `readAdminSession()` with corrupted/expired JWE payloads
  - `rate-limit.ts` — sliding window boundary conditions, concurrent access patterns, cold-start reset behavior
- **Severity**: P2

### WARN — Upstash store has no direct tests

- **Evidence**: No test file for `src/server/store/upstash-store.ts`
- **Detail**: All Lua scripts (lock acquire, renewal, release, compare-and-swap) are untested
- **Mitigating factor**: Upstash only activates on deployed Vercel runtimes (`isVercelDeployment()`); CI always uses memory store. Testing requires a real Upstash instance or mock.
- **Risk**: Data corruption from lock race conditions in production
- **Severity**: P2

### WARN — Infrastructure modules lack tests

| Module | Risk | Notes |
|---|---|---|
| `src/server/env.ts` | Medium | Core env resolution — `getSessionSecret()`, `getCronSecret()`, `getAiGatewayAuthMode()` untested directly |
| `src/server/log.ts` | Medium | Ring buffer overflow, debug exclusion, request ID extraction untested |
| `src/server/watchdog/state.ts` | Low | Watchdog state persistence |
| `src/server/watchdog/run.ts` | Low | Health check orchestration (has `run.test.ts` — covered) |
| `src/server/sandbox/resources.ts` | Low | `getSandboxVcpus()` env var validation |
| `src/server/sandbox/setup-progress.ts` | Low | Setup progress tracking |
| `src/server/sandbox/snapshot-delete.ts` | Low | Simple delegation (~8 lines) |
| `src/server/channels/slack/auth.ts` | Medium | Bot token validation |
| `src/server/channels/slack/install-config.ts` | Low | Slack app install config |
| `src/server/observability/state-snapshot.ts` | Low | Diagnostic state capture |
| `src/server/queues/retry.ts` | Medium | Queue retry logic |
| `src/server/launch-verify/queue-probe.ts` | Low | Queue loopback probe |
| `src/server/proxy/pending-response.ts` | Low | Timeout handling, response streaming |

### WARN — 27 untested API route handlers

**Admin routes** (4 untested):
- `src/app/api/admin/channel-forward-diag/route.ts`
- `src/app/api/admin/preflight/route.ts`
- `src/app/api/admin/restore-target/route.ts`
- `src/app/api/admin/watchdog/route.ts`

**Auth routes** (4 untested — covered by auth-enforcement integration tests):
- `src/app/api/auth/authorize/route.ts`
- `src/app/api/auth/callback/route.ts`
- `src/app/api/auth/login/route.ts`
- `src/app/api/auth/signout/route.ts`

**Firewall routes** (4 untested):
- `src/app/api/firewall/ingest/route.ts`
- `src/app/api/firewall/learned/route.ts`
- `src/app/api/firewall/report/route.ts`
- `src/app/api/firewall/sync/route.ts`

**Channel routes** (3 untested — all Discord, experimental):
- `src/app/api/channels/discord/register-command/route.ts`
- `src/app/api/channels/discord/route.ts`
- `src/app/api/channels/discord/webhook/route.ts`

**Debug routes** (9 — intentionally diagnostic, no test expected):
- `src/app/api/debug/after-timing/route.ts` through `src/app/api/debug/upstash-timing/route.ts`

**Other** (3 untested):
- `src/app/api/setup/route.ts` (has `setup-security.test.ts` but not route-level)
- `src/app/api/queues/launch-verify/route.ts`
- `src/app/api/cron/watchdog/route.ts`

### INFO — No code coverage tooling

- **Evidence**: No c8, nyc, jest, or `--experimental-test-coverage` in package.json or scripts
- **Impact**: Cannot measure actual line/branch coverage. Gap analysis is module-level only.
- **Severity**: P3

### INFO — No test.skip or test.todo found

All 66 test files are actively running. No skipped or placeholder tests.

## Issues Summary

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| TC-1 | P2 | Discord channel has zero test coverage | Open |
| TC-2 | P2 | Auth core (`admin-auth.ts`, `rate-limit.ts`) lacks direct unit tests | Open |
| TC-3 | P2 | Upstash store Lua scripts untested | Open |
| TC-4 | P2 | 27 API route handlers lack dedicated tests | Open |
| TC-5 | P2 | Infrastructure modules (`env.ts`, `log.ts`, `queues/retry.ts`) untested | Open |
| TC-6 | P3 | No code coverage tooling configured | Open |

## Recommended Fixes (ranked)

### P2 — Address before or shortly after launch

1. **TC-1 — Discord adapter tests**: Write tests for Ed25519 signature verification in `discord/adapter.ts`. Minimum security coverage needed even for experimental channel.
2. **TC-2 — Auth core tests**: Add dedicated tests for `admin-auth.ts` covering bearer validation, session encrypt/decrypt round-trip, CSRF enforcement ordering, and `rate-limit.ts` window math.
3. **TC-3 — Upstash store tests**: Add integration tests against a test Upstash instance, or mock-based unit tests for Lua script logic.
4. **TC-5 — Infrastructure tests**: Prioritize `env.ts` (session secret resolution) and `log.ts` (ring buffer behavior).

### P3 — Post-launch improvements

5. **TC-6 — Add coverage tooling**: Enable `--experimental-test-coverage` or install c8 for line-level visibility.
6. **TC-4 — Route handler tests**: Prioritize admin and firewall routes; debug routes can remain untested.

## Release Readiness

**No hard launch blockers** — the critical path (lifecycle, proxy, firewall, Slack/Telegram/WhatsApp channels, deploy contract) is well-tested. Discord's experimental status mitigates the zero-test-coverage risk. Auth core has integration coverage through `auth-enforcement.test.ts` even though direct unit tests are missing. The CSRF ordering in `admin-auth.ts` is correct (`resolveAdminCredential` checks cookie presence before CSRF enforcement).

**Recommended**: Add Discord signature verification tests before promoting Discord from experimental to stable.
