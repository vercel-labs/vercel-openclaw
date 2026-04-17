# Environment Variables

## Required

| Variable | Purpose |
| -------- | ------- |
| `ADMIN_SECRET` | Password for the admin UI. Also authenticates `/api/cron/watchdog` unless `CRON_SECRET` is set separately. |

AI Gateway auth uses Vercel OIDC automatically on deployed Vercel environments — no extra configuration needed.

## Persistent store (Redis)

Auto-provisioned by the deploy button via the Vercel Marketplace (Redis Cloud). Any Redis-wire-protocol endpoint works — self-hosted Redis, Redis Cloud, or any other provider.

| Variable | Purpose |
| -------- | ------- |
| `REDIS_URL` | Persistent store connection string (e.g. `redis://...` or `rediss://...`). Local dev uses the in-memory store when unset. |
| `KV_URL` | Legacy alias for `REDIS_URL` (set by the Vercel KV integration). The app prefers `REDIS_URL` but falls back to `KV_URL`. |

## Auth and cron

| Variable | Purpose |
| -------- | ------- |
| `CRON_SECRET` | Separate secret for `/api/cron/watchdog`. When unset, the runtime falls back to `ADMIN_SECRET`. On Vercel, missing both `CRON_SECRET` and `ADMIN_SECRET` is a hard failure in the deployment contract. Set `CRON_SECRET` separately if you want independent rotation for cron authentication. |
| `AI_GATEWAY_API_KEY` | Static fallback when Vercel OIDC is unavailable. Deployed Vercel still prefers OIDC first. The key is injected via network policy header transform at the sandbox firewall layer — it is never written inside the sandbox. |

### Experimental: sign-in-with-vercel

Set `VERCEL_AUTH_MODE=sign-in-with-vercel` to use Vercel OAuth instead of `ADMIN_SECRET`.

| Variable | Purpose |
| -------- | ------- |
| `VERCEL_AUTH_MODE` | `admin-secret` (default) or `sign-in-with-vercel`. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | OAuth client ID. |
| `VERCEL_APP_CLIENT_SECRET` | OAuth client secret. |
| `SESSION_SECRET` | Cookie encryption secret. Optional in `admin-secret` mode — the app auto-generates a 32-byte value on first login and persists it in Redis (same pattern as `ADMIN_SECRET`). Required and must be explicitly set for deployed `sign-in-with-vercel` mode. |

## OpenClaw version and sandbox tuning

| Variable | Purpose |
| -------- | ------- |
| `OPENCLAW_PACKAGE_SPEC` | Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox resumes and comparable benchmarks. When unset, the runtime falls back to a pinned known-good version (currently `openclaw@2026.4.12`) and the deployment contract warns on Vercel. |
| `OPENCLAW_INSTANCE_ID` | Optional Redis key namespace. On Vercel deployments, automatically uses `VERCEL_PROJECT_ID` when unset, giving each project its own namespace. Falls back to `openclaw-single` in local/non-Vercel environments. Can be set explicitly to override auto-detection. Changing it later points the app at a new namespace; it does not migrate existing state. |
| `OPENCLAW_SANDBOX_VCPUS` | vCPU count for sandbox create/resume (1, 2, 4, or 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |

## Slack OAuth install (optional)

When all three variables below are set, the admin panel offers a one-click "Install to Slack" OAuth flow. Create the Slack app once from the manifest flow, copy its credentials, and set them here.

| Variable | Purpose |
| -------- | ------- |
| `SLACK_CLIENT_ID` | Slack app client ID (from Basic Information → App Credentials). |
| `SLACK_CLIENT_SECRET` | Slack app client secret. |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (used for webhook signature verification). |

When these are not set, the admin panel falls back to manual credential entry (signing secret + bot token).

## Public origin override

The app resolves its canonical public URL from Vercel system variables automatically. Override with:

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_APP_URL` | Full origin override, e.g. `https://my-app.example.com`. |
| `NEXT_PUBLIC_BASE_DOMAIN` | Preferred external host for webhook URLs. |
| `BASE_DOMAIN` | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN`. |

## Terminal tab helpers

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_SANDBOX_SCOPE` | Optional team slug used to pre-fill `npx sandbox connect --scope ...` in the Terminal tab. |
| `NEXT_PUBLIC_SANDBOX_PROJECT` | Optional project name used to pre-fill `npx sandbox connect --project ...` in the Terminal tab. |

## Deployment protection

See [Deployment Protection](deployment-protection.md) for full details on bypass behavior.

| Variable | Purpose |
| -------- | ------- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Lets protected webhook requests reach the app when Vercel Deployment Protection is enabled. All channel webhook URLs include the bypass parameter when configured. |
