# Deploy Button & Onboarding Flow Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit

## Scope

- README.md deploy button URL and Getting Started instructions
- `.env.example` completeness for first-run
- `/api/setup` bootstrap endpoint security
- `/api/auth/login` first-run login flow
- `src/server/deploy-preflight.ts` and `src/server/deployment-contract.ts` readiness checks
- `src/components/admin-shell.tsx` initial state rendering

## Findings

### PASS — Deploy button URL is correct

- **Evidence**: `README.md:14`
- Repository URL points to `vercel-labs/vercel-openclaw` (matches `git remote -v`)
- Integration ID `oac_V3R1GIpkoJorr6fqyiwdhl17` auto-provisions Upstash Redis
- Only `ADMIN_SECRET` is prompted at deploy time (correct — other vars have safe defaults or are optional)
- `envDescription` explains CRON_SECRET fallback behavior

### PASS — Getting Started instructions are accurate

- **Evidence**: `README.md:25-31`
- All five steps (Deploy, Sign in, Use OpenClaw, Verify, Connect channels) match actual behavior
- Boot timing documented correctly: ~1 min first boot, ~10s resume from snapshot
- Preflight correctly described as config-readiness only (not runtime proof)
- Channel experimental status (WhatsApp, Discord) consistently labeled

### PASS — Bootstrap endpoint sealed on Vercel

- **Evidence**: `src/app/api/setup/route.ts:18-31`
- Returns 410 Gone on Vercel deployments (prevents credential exposure)
- Local dev: reveals auto-generated secret (necessary — no other discovery mechanism)
- No bootstrap exposure risk in production

### PASS — Login flow is secure

- **Evidence**: `src/app/api/auth/login/route.ts:1-56`, `src/server/auth/admin-auth.ts:150-171`
- Uses `timingSafeEqual()` for secret comparison
- Rate limiting applied to POST endpoint
- Encrypted session cookie issued on success
- First-write-wins for auto-generated secrets on concurrent cold starts (`admin-secret.ts:39-40`)

### PASS — Admin panel renders correct initial state

- **Evidence**: `src/app/page.tsx:16-97`, `src/components/admin-shell.tsx:455-502`
- Unauthenticated users see login form
- After login: shows `uninitialized`/`stopped` status with "Start" button
- Polling starts on mount (2s for transitional states, 5s otherwise)
- All channels appear unconfigured until operator configures them

### PASS — Deployment contract covers all requirements

- **Evidence**: `src/server/deployment-contract.ts:343-384`
- Checks: public-origin, webhook-bypass, store, cron-secret, ai-gateway, openclaw-package-spec, OAuth vars (conditional), session-secret (conditional)
- Upstash missing is hard fail on Vercel, warn locally (appropriate)
- CRON_SECRET falls back to ADMIN_SECRET (documented in deploy button `envDescription`)

### WARN — cronSecretConfigured preflight signal is misleading

- **Evidence**: `src/server/deploy-preflight.ts:449-451` vs `src/server/deployment-contract.ts:165`
- **Detail**: Preflight reads `process.env.CRON_SECRET` directly and reports `cronSecretConfigured: false` when only `ADMIN_SECRET` is set. The deployment contract uses `getCronSecret()` which correctly falls back to `ADMIN_SECRET`.
- **Impact**: Operators see a false negative in preflight diagnostics. Cron auth actually works via the fallback. No functional impact — cosmetic confusion only.
- **Severity**: P3

### WARN — NEXT_PUBLIC_SANDBOX_SCOPE/PROJECT undocumented in env docs

- **Evidence**: `.env.example:72-73`, `CLAUDE.md:488`
- **Detail**: These optional vars pre-fill the `npx sandbox connect` command in the Terminal tab. Present in `.env.example` and referenced in `CLAUDE.md` but missing from `docs/environment-variables.md`.
- **Impact**: Operators needing team/project scoping won't find these in formal docs. UI-only impact.
- **Severity**: P3

## Recommended Fixes (ranked)

1. **P3** — Align `cronSecretConfigured` in `deploy-preflight.ts:449` to use `getCronSecret()` instead of reading `process.env.CRON_SECRET` directly, or add a note that the field reflects explicit configuration rather than effective auth.
2. **P3** — Add `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` to `docs/environment-variables.md` under a "Terminal / SSH" section.

## Release Readiness

**No launch blockers.** The deploy-button and onboarding flow are accurate, secure, and complete. Two minor P3 documentation improvements can be addressed post-launch.
