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

The deploy button will ask you for two environment variables. Both come from **Upstash Redis**, which you can provision for free through the [Vercel Marketplace](https://vercel.com/marketplace/upstash-redis):

| Variable | Where to get it |
| -------- | --------------- |
| `UPSTASH_REDIS_REST_URL` | Upstash console → your database → REST API → Endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console → your database → REST API → Token |

That's it. AI Gateway auth is handled automatically via OIDC — no API keys needed.

## First visit

1. Set `ADMIN_SECRET` in your Vercel project's environment variables (Settings → Environment Variables). Use a strong, random value.
2. Open your new deployment.
3. Use that secret to log in from the main page.
4. The app will create your sandbox automatically on first use.

## What you can do

- **Use OpenClaw** — the full OpenClaw UI is proxied at `/gateway`.
- **Stop & restore** — save a snapshot of your sandbox and restore it later. Useful if you want to roll back after experimenting.
- **Connect channels** — wire up Slack, Telegram, or Discord so people can talk to your OpenClaw instance from chat. Configure each one from the admin panel. Messages are delivered reliably through Workflow DevKit. Launch verification runs through `/api/queues/launch-verify`.
- **Firewall** — the app can learn which domains your agent talks to, then lock egress down to only those domains.

## Optional: sign in with Vercel

By default the app uses a simple admin secret. If you'd prefer OAuth login through Vercel, set these additional environment variables:

| Variable | Purpose |
| -------- | ------- |
| `VERCEL_AUTH_MODE` | Set to `sign-in-with-vercel` |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | From [vercel.com/account/oauth-apps](https://vercel.com/account/oauth-apps) |
| `VERCEL_APP_CLIENT_SECRET` | From the same OAuth app |
| `SESSION_SECRET` | Any random string for cookie encryption |

Set the OAuth callback URL to `https://<your-domain>/api/auth/callback`.

## Optional: pin the OpenClaw version

By default the app installs `openclaw@latest`, which is non-deterministic across deploys. On Vercel deployments the deployment contract **fails** when `OPENCLAW_PACKAGE_SPEC` is unset or unpinned (e.g. `openclaw@latest`). The runtime still falls back to `openclaw@latest` with a warning log, but the contract marks the deployment as unhealthy.

| Variable | Purpose |
| -------- | ------- |
| `OPENCLAW_PACKAGE_SPEC` | Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox restores and comparable benchmarks. When unset, the runtime falls back to `openclaw@latest` but the deployment contract fails on Vercel. |
| `OPENCLAW_SANDBOX_VCPUS` | vCPU count for sandbox create/restore (1, 2, 4, or 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |
| `CRON_SECRET` | Required on Vercel for the watchdog cron (`/api/cron/watchdog`, every 5 min) to authenticate. Generate with `openssl rand -hex 32`. Without this, the watchdog silently returns 401 and never fires. The deployment contract fails when missing on Vercel. |

## Optional: override the public origin

The app resolves its canonical public URL from Vercel system variables automatically. If you need to override it (e.g. custom domain, non-Vercel host), set one of:

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_APP_URL` | Full origin override, e.g. `https://my-app.example.com` |
| `NEXT_PUBLIC_BASE_DOMAIN` | Preferred external host for webhook URLs |
| `BASE_DOMAIN` | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN` |

## Local development

```bash
npm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
npm run dev                      # http://localhost:3000
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, testing, and development workflows.
