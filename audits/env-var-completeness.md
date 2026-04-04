# Environment Variable Completeness Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit

## Scope

- All `process.env.*` references in source code
- `.env.example` completeness
- `docs/environment-variables.md` coverage
- `CLAUDE.md` and `README.md` consistency
- `src/server/deployment-contract.ts` validation coverage
- `scripts/check-verifier-contract.mjs` enforcement

## Findings

### PASS — Deployment contract variables fully documented

- **Evidence**: `scripts/check-verifier-contract.mjs` passes; all 11 deployment-contract vars appear in `.env.example`, `docs/environment-variables.md`, `CLAUDE.md`, and `CONTRIBUTING.md`
- **Variables**: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CRON_SECRET, AI_GATEWAY_API_KEY, OPENCLAW_PACKAGE_SPEC, OPENCLAW_INSTANCE_ID, OPENCLAW_SANDBOX_VCPUS, OPENCLAW_SANDBOX_SLEEP_AFTER_MS, NEXT_PUBLIC_VERCEL_APP_CLIENT_ID, VERCEL_APP_CLIENT_SECRET, SESSION_SECRET

### PASS — Core operator variables complete across all surfaces

- **Evidence**: Cross-reference of `.env.example`, `docs/environment-variables.md`, `README.md`
- ADMIN_SECRET, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, BASE_DOMAIN, VERCEL_AUTOMATION_BYPASS_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET — all documented consistently

### WARN — Experimental/debug variables undocumented

- **Severity**: P3 (non-blocking — these are internal/experimental)

| Variable | Used In | Missing From |
|---|---|---|
| `OPENCLAW_HOT_SPARE_ENABLED` | `src/server/sandbox/hot-spare.ts:4,27` | docs, .env.example |
| `OPENCLAW_OWNER_ALLOW_FROM` | `src/server/openclaw/config.ts:349-351` | all documentation |
| `ENABLE_DEBUG_ROUTES` | `src/server/auth/debug-guard.ts:13,27` | all documentation |
| `DEBUG_SANDBOX_SNAPSHOT_ID` | `src/app/api/debug/sandbox-timing/route.ts:13,16` | all documentation |

- **Impact**: These are internal development/experimental features. Operators don't need them for launch. They should be documented eventually for contributor clarity.

### WARN — SMOKE_AUTH_COOKIE partially documented

- **Evidence**: Documented in `CLAUDE.md:53-58` but missing from `docs/environment-variables.md` and `.env.example`
- **Impact**: Only relevant for remote smoke testing. Not needed for deployment.
- **Severity**: P3

### WARN — NEXT_PUBLIC_SANDBOX_SCOPE/PROJECT missing from env docs

- **Evidence**: `.env.example:72-73` has these vars but `docs/environment-variables.md` does not
- **Impact**: Terminal tab UI hint variables. Cosmetic only.
- **Severity**: P3

## Recommended Fixes (ranked)

1. **P3** — Add `OPENCLAW_HOT_SPARE_ENABLED` to `CLAUDE.md` under a "Current sharp edges" or "Experimental" note so contributors know it exists.
2. **P3** — Add `OPENCLAW_OWNER_ALLOW_FROM` to `docs/environment-variables.md` with a brief description.
3. **P3** — Add `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` to `docs/environment-variables.md`.
4. **P3** — Add `SMOKE_AUTH_COOKIE` to `docs/environment-variables.md` under a "Testing" section.
5. **P3** — Optionally document `ENABLE_DEBUG_ROUTES` and `DEBUG_SANDBOX_SNAPSHOT_ID` in `CONTRIBUTING.md` for contributor awareness.

## Release Readiness

**No launch blockers.** All operator-facing variables are fully documented. Only internal/experimental/debug variables have documentation gaps, none of which affect deployment or runtime behavior.
