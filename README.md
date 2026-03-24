<p align="center">
  <img src="public/openclaw-logo.svg" width="80" height="80" alt="OpenClaw" />
</p>

<h1 align="center">Deploy OpenClaw on Vercel</h1>

<p align="center">
  Get a personal OpenClaw instance running in a Vercel Sandbox — with one click.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw.git&env=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN&envDescription=Recommended%20for%20durable%20state.%20AI%20Gateway%20uses%20OIDC%20on%20Vercel%20by%20default.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw%23setup&project-name=openclaw&repository-name=openclaw"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

---

## Setup

The deploy button asks for the two Upstash Redis variables because durable state is the only external dependency the template cannot infer. A working Vercel deployment still needs an auth configuration and `CRON_SECRET` before launch verification passes.

| Variable | Where to get it |
| -------- | --------------- |
| `UPSTASH_REDIS_REST_URL` | Upstash console → your database → REST API → Endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console → your database → REST API → Token |

AI Gateway auth is handled automatically via OIDC on deployed Vercel environments.

## First visit

1. Choose an auth mode:
   - default: set `ADMIN_SECRET`
   - optional: set `VERCEL_AUTH_MODE=sign-in-with-vercel` plus `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, and `SESSION_SECRET`
2. Set `CRON_SECRET`.
3. Open the deployment and sign in.
4. Visit `/gateway` or use the admin panel to start the sandbox.
5. Run launch verification before connecting channels.

## What you can do

- **Use OpenClaw** — the full OpenClaw UI is proxied at `/gateway`.
- **Stop & restore** — save a snapshot of your sandbox and restore it later. Useful if you want to roll back after experimenting.
- **Connect channels** — wire up Slack, Telegram, or Discord so people can talk to your OpenClaw instance from chat. Configure each one from the admin panel. Normal channel delivery uses Workflow DevKit. Deployment verification is triggered via `POST /api/admin/launch-verify`, which internally probes the private `/api/queues/launch-verify` consumer.
- **Firewall** — the app can learn which domains your agent talks to, then lock egress down to only those domains.

## Required on Vercel

| Variable | When required | Purpose |
| -------- | ------------- | ------- |
| `CRON_SECRET` | Always | Authenticates `/api/cron/watchdog` and the optional `/api/cron/drain-channels` diagnostic backstop. Missing on Vercel is a hard failure in the deployment contract. |
| `ADMIN_SECRET` | `admin-secret` mode (default) | Secret exchanged for an encrypted session cookie via `/api/auth/login`. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | `sign-in-with-vercel` mode | OAuth client ID. |
| `VERCEL_APP_CLIENT_SECRET` | `sign-in-with-vercel` mode | OAuth client secret. |
| `SESSION_SECRET` | `sign-in-with-vercel` mode on Vercel | Explicit cookie encryption secret. Do not rely on derivation from the Upstash token. |

`VERCEL_AUTH_MODE` defaults to `admin-secret` when unset. AI Gateway auth uses Vercel OIDC automatically on deployed Vercel environments. If OIDC is unavailable outside Vercel, set `AI_GATEWAY_API_KEY` as an optional fallback.

## Optional: pin the OpenClaw version

By default the app installs `openclaw@latest`, which is non-deterministic across deploys. On Vercel deployments, the deployment contract **warns** — it does not fail — when `OPENCLAW_PACKAGE_SPEC` is unset or unpinned (e.g. `openclaw@latest`). The runtime still falls back to `openclaw@latest`, but restores are non-deterministic. Pin to an exact version like `openclaw@1.2.3`.

| Variable | Purpose |
| -------- | ------- |
| `OPENCLAW_PACKAGE_SPEC` | Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox restores and comparable benchmarks. When unset, the runtime falls back to `openclaw@latest` and the deployment contract warns on Vercel. |
| `OPENCLAW_SANDBOX_VCPUS` | vCPU count for sandbox create/restore (1, 2, 4, or 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |

## Optional: Deployment Protection and webhooks

`VERCEL_AUTOMATION_BYPASS_SECRET` is diagnostic-only: missing it does not fail preflight by itself, but protected third-party webhooks can be blocked before app auth runs.

| Variable | Purpose |
| -------- | ------- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Lets protected webhook requests reach the app when Vercel Deployment Protection is enabled. |

Channel behavior:
- Slack and Discord webhook URLs include the bypass query parameter when the secret is configured.
- Telegram intentionally does not include the bypass query parameter. Telegram validates via the `x-telegram-bot-api-secret-token` header, and adding the bypass query parameter can cause `setWebhook` to silently drop registration.

## Optional: override the public origin

The app resolves its canonical public URL from Vercel system variables automatically. If you need to override it (e.g. custom domain, non-Vercel host), set one of:

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_APP_URL` | Full origin override, e.g. `https://my-app.example.com` |
| `NEXT_PUBLIC_BASE_DOMAIN` | Preferred external host for webhook URLs |
| `BASE_DOMAIN` | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN` |

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `POST /api/admin/launch-verify` returns a `LaunchVerificationPayload`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

## Local development

```bash
npm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
npm run dev                      # http://localhost:3000
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, testing, and development workflows.
