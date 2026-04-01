<p align="center"><strong>Research Preview</strong></p>

<p align="center">
  <img src="public/openclaw-logo.svg" width="80" height="80" alt="OpenClaw" />
</p>

<h1 align="center">Deploy OpenClaw on Vercel</h1>

<p align="center">
  Get a personal OpenClaw instance running in a Vercel Sandbox — with one click.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw.git&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17&env=ADMIN_SECRET&envDescription=Password%20for%20the%20admin%20UI.%20Also%20used%20to%20secure%20cron%20jobs%20unless%20CRON_SECRET%20is%20set%20separately.&project-name=openclaw&repository-name=openclaw"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

---

## What is this?

This is a Next.js app that wraps [OpenClaw](https://openclaw.vercel.app) in a full control plane — auth, persistent sandboxes, channel integrations, and an egress firewall — and runs it inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

Click **Deploy with Vercel** above, set a password, and you're up.

## Getting started

1. **Deploy** — the button auto-provisions an [Upstash Redis](https://vercel.com/marketplace/upstash-redis) database and asks for an `ADMIN_SECRET` (your password).
2. **Sign in** — open the deployment and enter your admin secret.
3. **Use OpenClaw** — visit `/gateway` or click **Start** in the admin panel. The first boot takes about a minute while OpenClaw is installed into the sandbox. After that, resuming from stop takes about 10 seconds (the sandbox auto-snapshots on stop and auto-resumes on get).
4. **Verify** — run destructive launch verification from the admin panel before connecting channels. Preflight is a config-readiness check. It does not prove the sandbox can complete a real channel delivery.
5. **Connect channels** — optionally wire up Slack or Telegram from the admin panel so people can chat with your instance. For Slack, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` to enable one-click OAuth install, or enter credentials manually. A deployment is channel-ready only after destructive launch verification passes and channelReadiness.ready is true.

## What you get

- **Full OpenClaw UI** proxied at `/gateway` with auth and WebSocket rewriting
- **Persistent sandboxes** — sandbox state is automatically preserved on stop and restored on resume
- **Slack & Telegram** — channel integrations with durable delivery
- **Egress firewall** — learn which domains your agent talks to, then lock it down
- **Auto-wake** — a cron watchdog wakes your sandbox when scheduled OpenClaw jobs are due

## Built with

| Technology | Role |
| ---------- | ---- |
| [Next.js](https://nextjs.org) | App framework |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) | Runs the OpenClaw instance (persistent sandboxes with auto-snapshot on stop, auto-resume on get) |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | OIDC-authenticated model access for the agent |
| [Upstash Redis](https://vercel.com/marketplace/upstash-redis) | Persistent state — metadata, snapshots, channel config |
| [Vercel Workflow](https://vercel.com/docs/workflow) | Durable channel message delivery (Slack, Telegram) |
| [Vercel Queues](https://vercel.com/docs/queues) | Launch verification probe delivery |
| [Vercel Cron](https://vercel.com/docs/cron-jobs) | Watchdog health checks and scheduled wake |

## Configuration

The only required variable is `ADMIN_SECRET`. Everything else is auto-configured:

- **Upstash Redis** — provisioned by the deploy button
- **AI Gateway auth** — handled via Vercel OIDC on deployed environments
- **Cron secret** — falls back to `ADMIN_SECRET` if `CRON_SECRET` is not set separately

See [docs/environment-variables.md](docs/environment-variables.md) for the full reference, including optional tuning (vCPU count, sleep timeout, version pinning) and alternative auth modes.

## Local development

```bash
npm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
npm run dev                      # http://localhost:3000
```

## Documentation

| Document | Contents |
| -------- | -------- |
| [Architecture](docs/architecture.md) | System overview and subsystem map |
| [Sandbox Lifecycle and Restore](docs/lifecycle-and-restore.md) | State transitions, persistent sandboxes, resume behavior |
| [Preflight and Launch Verification](docs/preflight-and-launch-verification.md) | Deployment readiness and runtime verification |
| [Channels and Webhooks](docs/channels-and-webhooks.md) | Slack/Telegram setup, readiness, protection behavior |
| [Environment Variables](docs/environment-variables.md) | Full env var reference |
| [API Reference](docs/api-reference.md) | Endpoint and payload reference |
| [Deployment Protection](docs/deployment-protection.md) | Bypass secret behavior and display-safe URLs |
| [Architecture Tradeoffs](docs/architecture-tradeoffs.md) | Why the codebase is shaped this way, alternatives explored |
| [Contributing](CONTRIBUTING.md) | Architecture, routes, testing, development workflows |
