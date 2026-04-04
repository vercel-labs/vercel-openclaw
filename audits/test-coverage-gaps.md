# Test Coverage Gaps Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit

## Scope

- Test file inventory vs source module inventory
- Critical subsystem coverage assessment
- Test infrastructure and tooling
- Security-sensitive untested paths

## Findings

### Overview

- **194 source modules** (excluding tests)
- **122 test files** exist
- **Estimated coverage**: ~63% of modules have corresponding tests
- **Test framework**: Node.js built-in `--test` runner via `scripts/test.mjs`
- **No coverage tooling** configured (no c8, nyc, or jest --coverage)

### PASS — Well-tested subsystems

| Subsystem | Test Files | Status |
|---|---|---|
| Firewall (policy, domains, state, sync) | 5+ test files | ✅ Comprehensive |
| Public URL resolution | 3 test files | ✅ Comprehensive |
| Deploy preflight & contract | 3 test files | ✅ Comprehensive |
| Sandbox lifecycle (create, resume, stop) | lifecycle.test.ts + controller tests | ✅ Core paths covered |
| Channel core (queue, history, driver, state) | Multiple test files | ✅ Good coverage |
| Channel adapters (Slack, Telegram, WhatsApp) | adapter.test.ts per channel | ✅ Good coverage |
| Auth enforcement (session, CSRF, route-auth) | auth-enforcement.test.ts | ✅ Integration tests |
| Watchdog | run.test.ts | ✅ Tested |
| Proxy / HTML injection | proxy-route-utils.test.ts, htmlInjection.test.ts | ✅ Tested |

### FAIL — Discord channel has zero test coverage

- **Evidence**: No test files exist for any Discord module
- **Files untested**:
  - `src/server/channels/discord/adapter.ts` (392 lines) — Ed25519 signature verification, message extraction
  - `src/server/channels/discord/application.ts` (141 lines) — API integration, token validation
  - `src/server/channels/discord/discord-api.ts` (45+ lines) — message sending, rate limiting
  - `src/server/channels/discord/commands.ts` — command registration
  - `src/server/channels/discord/reconcile.ts` (24+ lines) — state reconciliation
  - `src/app/api/channels/discord/webhook/route.ts` — webhook endpoint
- **Risk**: Signature spoofing, silent message loss, untested error paths
- **Severity**: P2 (Discord is marked "experimental" which mitigates risk, but signature verification is security-critical)

### WARN — Auth core modules lack direct tests

- **Evidence**: No dedicated test file for `admin-auth.ts` or `rate-limit.ts`
- **Files untested**:
  - `src/server/auth/admin-auth.ts` (179 lines) — bearer validation, session encryption, CSRF enforcement, login flow
  - `src/server/auth/rate-limit.ts` (112 lines) — sliding window rate limiting, IP extraction
- **Mitigating factor**: `auth-enforcement.test.ts` provides integration coverage of the auth layer at the route level
- **Risk**: Edge cases in timing-safe comparison, CSRF bypass, rate limit window math
- **Severity**: P2

### WARN — Upstash store has no direct tests

- **Evidence**: No test file for `src/server/store/upstash-store.ts`
- **Detail**: All Lua scripts (lock acquire, renewal, release, compare-and-swap) are untested
- **Mitigating factor**: Upstash only activates on deployed Vercel runtimes (`isVercelDeployment()`); CI always uses memory store. Testing requires a real Upstash instance or mock.
- **Risk**: Data corruption from lock race conditions in production
- **Severity**: P2

### WARN — No code coverage tooling

- **Evidence**: No c8, nyc, jest, or `--experimental-test-coverage` in package.json or scripts
- **Impact**: Cannot measure actual line/branch coverage. Gap analysis is module-level only.
- **Severity**: P3

### INFO — Other untested modules (lower priority)

| Module | Lines | Risk | Notes |
|---|---|---|---|
| `src/server/channels/slack/auth.ts` | ~50 | Medium | Bot token validation |
| `src/server/gateway/auth-recovery.ts` | ~50 | Medium | Auth failure recovery |
| `src/server/sandbox/snapshot-delete.ts` | ~8 | Low | Simple delegation |
| `src/server/openclaw/restore-assets.ts` | — | Medium | Manifest-based asset sync |
| `src/server/channels/telegram/commands.ts` | — | Low | Command registration |
| `src/server/observability/state-snapshot.ts` | — | Low | Diagnostic only |

## Recommended Fixes (ranked)

### P2 — Address before or shortly after launch

1. **Discord adapter tests**: Write tests for Ed25519 signature verification in `discord/adapter.ts`. This is the minimum security coverage needed even for an experimental channel.
2. **Auth core tests**: Add dedicated tests for `admin-auth.ts` covering bearer validation, session encrypt/decrypt round-trip, and CSRF enforcement edge cases.
3. **Rate limit tests**: Add tests for `rate-limit.ts` window math and concurrent request handling.

### P3 — Post-launch improvements

4. **Add coverage tooling**: Enable `--experimental-test-coverage` or install c8 to get line-level visibility.
5. **Upstash store tests**: Add integration tests against a test Upstash instance, or mock-based unit tests for Lua script logic.
6. **Slack auth tests**: Cover bot token validation and API error handling.

## Release Readiness

**No hard launch blockers** — the critical path (lifecycle, proxy, firewall, Slack/Telegram/WhatsApp channels, deploy contract) is well-tested. Discord's experimental status mitigates the zero-test-coverage risk. Auth core has integration coverage through `auth-enforcement.test.ts` even though direct unit tests are missing.

**Recommended**: Add Discord signature verification tests before promoting Discord from experimental to stable.
