<p align="center"><strong>Research Preview</strong></p>

<p align="center">
  <img src="public/openclaw-logo.svg" width="80" height="80" alt="OpenClaw" />
</p>

<h1 align="center">Deploy OpenClaw on Vercel</h1>

<p align="center">
  Get a personal OpenClaw instance running in a Vercel Sandbox with one command.
</p>

<h2 align="center">Recommended: the <code>vclaw</code> CLI</h2>

<p align="center">
  <code>npx @vercel/vclaw create --scope your-team</code>
</p>

<p align="center">
  <strong>This is the only fully supported install path.</strong> Use it unless you have a specific reason not to.
</p>

### Why `vclaw` over the Deploy button

The Deploy button starts a project but stops short of a working OpenClaw. `vclaw` takes you end-to-end:

| Step | `vclaw create` | Deploy button |
| ---- | :-: | :-: |
| Clones `vercel-labs/vercel-openclaw` | yes | yes |
| Links a Vercel project in the scope you pick | yes | partial (browser flow) |
| Provisions Redis via the Marketplace integration | yes | yes |
| Prompts for and sets `ADMIN_SECRET` | yes | yes |
| Generates and sets `CRON_SECRET` (independent rotation) | yes | no |
| Enables Deployment Protection and wires `VERCEL_AUTOMATION_BYPASS_SECRET` | yes (`--deployment-protection`) | no |
| Runs a production deploy | yes | yes |
| Runs launch verification against the live URL | yes | no |
| Works headlessly with `VERCEL_TOKEN` | yes | no |

Result: after `vclaw create` finishes, channel webhooks can reach OpenClaw through protection, cron auth rotates independently from your admin login, and you have proof the sandbox can complete a real chat roundtrip. The Deploy button gets you a booted UI, nothing more.

### Prerequisites

- Node.js 20 or newer
- `git`
- The Vercel CLI: `npm i -g vercel`
- Authenticated: run `vercel login`, or export `VERCEL_TOKEN` for non-interactive runs

Check your environment before you start:

```bash
npx @vercel/vclaw doctor
```

### Quick start with `vclaw`

```bash
npx @vercel/vclaw create --scope your-team
```

This walks through the full setup:

1. Verifies local prerequisites.
2. Picks a Vercel scope (prompts if you have more than one).
3. Clones `vercel-labs/vercel-openclaw` into `./vercel-openclaw`.
4. Creates and links a Vercel project (prompts for a unique name if `openclaw` is taken).
5. Provisions Redis via the Redis Cloud Marketplace integration.
6. Optionally enables Deployment Protection (`sso` or `password`) and sets the automation bypass secret so webhooks still reach the app.
7. Prompts for `ADMIN_SECRET` (masked, confirmed). This is the password you will type into the admin UI.
8. Pushes managed env vars: `ADMIN_SECRET`, `CRON_SECRET` (if `--cron-secret` is set), `VERCEL_AUTOMATION_BYPASS_SECRET` (if protection is enabled).
9. Runs a production deploy.
10. Runs launch verification against the new URL and reports `channelReadiness`.
11. Optionally wires a Telegram bot and/or Slack app if you pass `--telegram` / `--slack` (see below).

### Common `vclaw` flows

Choose a project name and clone directory:

```bash
vclaw create --scope your-team --name my-openclaw --dir ~/dev/my-openclaw
```

Enable SSO deployment protection (auto-configures webhook bypass):

```bash
vclaw create --scope your-team --deployment-protection sso
```

Prepare a project but skip the deploy step:

```bash
vclaw create --scope your-team --skip-deploy
```

Wire up a Telegram bot in the same run:

```bash
vclaw create --scope your-team --telegram "123456:AA...BotFatherToken"
```

After launch verification passes, `vclaw` calls `PUT /api/channels/telegram` on the new deployment. The app validates the token via Telegram's `getMe`, generates a webhook secret, registers the Vercel URL with Telegram, and syncs slash commands — no admin-panel clicks needed.

Wire up a Slack app in the same run:

```bash
vclaw create --scope your-team \
  --slack "xoxb-..." \
  --slack-signing-secret "abcd1234..."
```

This calls `PUT /api/channels/slack`, which validates the bot token via Slack's `auth.test` and persists both credentials so the app can verify incoming events. You still have to paste the Request URL shown in the admin panel into your Slack app's Event Subscriptions page — Slack has no API for that outside the OAuth install flow. `--slack` and `--slack-signing-secret` must be passed together.

Both flags require a live deployment and are mutually exclusive with `--skip-deploy`.

Re-run launch verification against an existing deployment:

```bash
vclaw verify \
  --url https://my-openclaw.vercel.app \
  --admin-secret "$ADMIN_SECRET"
```

Full reference: [github.com/vercel-labs/vclaw](https://github.com/vercel-labs/vclaw).

---

<details>
<summary><strong>Alternative: Deploy button (not recommended)</strong></summary>

<br />

Use this only if you cannot install Node locally. It provisions Redis and prompts for `ADMIN_SECRET`, but leaves Deployment Protection, `CRON_SECRET`, and launch verification for you to do by hand afterward.

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw.git&env=ADMIN_SECRET&envDescription=Serves%20as%20your%20password%20for%20the%20admin%20UI.&project-name=openclaw&repository-name=openclaw&stores=%255B%257B%2522type%2522%253A%2522integration%2522%252C%2522integrationSlug%2522%253A%2522redis%2522%252C%2522productSlug%2522%253A%2522redis%2522%257D%255D"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

After the deploy finishes, you still need to:

1. Sign in with your `ADMIN_SECRET`.
2. Run destructive launch verification from the admin panel before connecting any channel.
3. Manually set `CRON_SECRET` if you want cron auth separate from admin login.
4. Manually enable Deployment Protection and set `VERCEL_AUTOMATION_BYPASS_SECRET` if you want protected previews that channels can still reach.

</details>

---

## What is this?

A Next.js app that wraps [OpenClaw](https://openclaw.vercel.app) in a full control plane (auth, persistent sandboxes, channel integrations, egress firewall) and runs it inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

## Getting started

After `vclaw create` finishes:

1. **Sign in.** Open the printed deployment URL and enter your `ADMIN_SECRET`.
2. **Use OpenClaw.** Visit `/gateway` or click **Start** in the admin panel. First boot takes about a minute while OpenClaw installs into the sandbox. Resumes after that take about 10 seconds (the sandbox auto-snapshots on stop and auto-resumes on get).
3. **Verify.** `vclaw` already ran launch verification once. Re-run it from the admin panel any time you change config. Preflight is only a config-readiness check; it does not prove the sandbox can complete a real channel delivery.
4. **Connect channels.** Wire up Slack, Telegram, WhatsApp (experimental), or Discord (experimental) from the admin panel — or pre-wire Telegram and Slack during `vclaw create` itself with `--telegram` / `--slack --slack-signing-secret`. For Slack OAuth install, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`, or enter credentials manually. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

## What you get

- **Full OpenClaw UI** proxied at `/gateway` with auth and WebSocket rewriting.
- **Persistent sandboxes.** State is preserved on stop and restored on resume.
- **Slack, Telegram, WhatsApp (experimental), and Discord (experimental)** channels with durable delivery.
- **Egress firewall.** Learn which domains your agent talks to, then lock it down.
- **Auto-wake.** A cron watchdog wakes your sandbox when scheduled OpenClaw jobs are due.

## Built with

| Technology | Role |
| ---------- | ---- |
| [Next.js](https://nextjs.org) | App framework |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) | Runs the OpenClaw instance (persistent sandboxes, auto-snapshot on stop, auto-resume on get) |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | OIDC-authenticated model access for the agent |
| [Redis Cloud](https://vercel.com/marketplace/redis) | Persistent state for metadata, snapshots, and channel config (any Redis-wire-protocol endpoint works) |
| [Vercel Workflow](https://vercel.com/docs/workflow) | Durable channel message delivery (Slack, Telegram; WhatsApp and Discord experimental) |
| [Vercel Queues](https://vercel.com/docs/queues) | Launch verification probe delivery |
| [Vercel Cron](https://vercel.com/docs/cron-jobs) | Watchdog health checks and scheduled wake |

## Configuration

For the default path (`VERCEL_AUTH_MODE=admin-secret`), the only value you must provide up front is `ADMIN_SECRET`. Everything else auto-configures:

- **Redis.** Provisioned by `vclaw` (or the Deploy button) via the Redis Cloud Marketplace integration, which sets `REDIS_URL`.
- **AI Gateway auth.** Handled via Vercel OIDC on deployed environments.
- **Cron secret.** Falls back to `ADMIN_SECRET` when `CRON_SECRET` is unset. Set `CRON_SECRET` separately on deployed environments if you want cron auth to rotate independently from admin login. `vclaw --cron-secret` sets this for you.
- **Watchdog cron.** Runs once daily by default so Hobby-plan deploys succeed. Pro plans can increase the schedule in `vercel.json` up to every minute for more responsive auto-wake.

Switching to `VERCEL_AUTH_MODE=sign-in-with-vercel` also requires `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, and `SESSION_SECRET`.

See [docs/environment-variables.md](docs/environment-variables.md) for the full reference, including optional tuning (vCPU count, sleep timeout, version pinning) and alternative auth modes.

## Local development

```bash
pnpm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
pnpm dev                         # http://localhost:3000
```

### Running locally against production data

To tweak the admin UI against real prod Redis/metadata without risking accidental mutations:

```bash
vercel env pull .env.local --environment=production
# then in .env.local:
#   VERCEL_ENV=development     # flips the Vercel-deployment gate so Redis connects
#   LOCAL_READ_ONLY=1          # blocks every admin mutation route with 403 LOCAL_READ_ONLY
#   unset VERCEL_AUTH_MODE     # use admin-secret auth locally
pnpm dev
```

With `LOCAL_READ_ONLY=1`, `POST /api/admin/stop`, `/ensure`, `/reset`, `/snapshot`, and channel config writes all return `403 { error: "LOCAL_READ_ONLY" }` before touching the sandbox SDK. Reads (`/api/status`, `/api/admin/preflight`, `/api/admin/logs`) still work. Unset the variable when you actually want to test a mutation.

## Documentation

| Document | Contents |
| -------- | -------- |
| [Architecture](docs/architecture.md) | System overview and subsystem map |
| [Sandbox Lifecycle and Restore](docs/lifecycle-and-restore.md) | State transitions, persistent sandboxes, resume behavior |
| [Preflight and Launch Verification](docs/preflight-and-launch-verification.md) | Deployment readiness and runtime verification |
| [Channels and Webhooks](docs/channels-and-webhooks.md) | Channel setup (Slack, Telegram, WhatsApp, Discord), readiness, protection behavior |
| [Environment Variables](docs/environment-variables.md) | Full env var reference |
| [API Reference](docs/api-reference.md) | Endpoint and payload reference |
| [Deployment Protection](docs/deployment-protection.md) | Bypass secret behavior and display-safe URLs |
| [Architecture Tradeoffs](docs/architecture-tradeoffs.md) | Why the codebase is shaped this way, alternatives explored |
| [Contributing](CONTRIBUTING.md) | Architecture, routes, testing, development workflows |
