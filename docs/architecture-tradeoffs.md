# Architecture Tradeoffs

This document captures key architectural decisions in vercel-openclaw, the tradeoffs behind them, and alternatives explored by comparing with [moltworker](https://github.com/nichochar/moltworker) — a Cloudflare Workers implementation of the same OpenClaw hosting concept.

## Control plane channels vs container-native channels

vercel-openclaw owns the channel layer (Slack, Telegram) in the control plane. moltworker delegates channels entirely to OpenClaw inside the container.

### What "control plane channels" means

The app provides dedicated webhook routes (`/api/channels/telegram/webhook`, `/api/channels/slack/webhook`). When a message arrives:

1. The Vercel Function validates the platform signature (always running, even when sandbox is stopped).
2. For Telegram: sends an immediate "Starting up..." boot message so the user knows something is happening.
3. Starts a Vercel Workflow that durably holds the message payload.
4. The Workflow restores the sandbox if stopped, delivers the message to OpenClaw, and sends the reply back to the channel.
5. The Workflow deletes the boot message after delivery.

### What "container-native channels" means (moltworker approach)

Channel tokens are passed as environment variables to the container. OpenClaw handles webhook registration, message receipt, and replies natively. The worker is transparent to channel traffic — it just proxies requests to the container.

### Why vercel-openclaw owns channels

The sandbox sleeps after inactivity (default: 30 minutes). When it sleeps, there is nothing inside the sandbox to receive messages. The control plane webhook routes are Vercel Functions — they are always available, regardless of sandbox state. This is the only way to:

- Accept a webhook while the sandbox is stopped
- Send a boot message to the user immediately
- Durably queue the message until the sandbox is ready
- Guarantee delivery even if the resume takes seconds

Without control plane channels, messages sent to a sleeping sandbox would be lost or delayed with no user feedback.

### What you give up

The control plane channel layer accounts for roughly 10,000 lines of code: webhook routes, signature validation, dedup locks, boot messages, Workflow-based delivery, channel connectability checks, admin UI panels, and state management. moltworker achieves functional channel support with zero lines of channel code by delegating everything to OpenClaw.

### Could channels be configured inside OpenClaw instead?

Partially. A hybrid approach is possible:

1. Users configure channels inside OpenClaw (via its native UI or config).
2. The control plane syncs credentials FROM the sandbox on heartbeat (reading `openclaw.json`).
3. Webhook routes continue to handle wake-from-sleep using the synced credentials.

This would eliminate the channel admin UI and config API routes while preserving durable delivery. The `touchRunningSandbox()` heartbeat already piggybacks sandbox reads (cron jobs) and could add a config sync step using the same pattern.

The gap: if a user configures a channel and the sandbox stops before the next heartbeat syncs credentials, the webhook routes would not have the tokens needed for signature validation or boot messages until the next restore.

## Slack: HTTP webhooks vs Socket Mode

vercel-openclaw uses Slack in HTTP mode (inbound webhooks). moltworker uses Slack in Socket Mode (outbound WebSocket).

### HTTP mode (vercel-openclaw)

```json
{
  "mode": "http",
  "botToken": "xoxb-...",
  "signingSecret": "...",
  "webhookPath": "/slack/events"
}
```

Slack POSTs events to the app's webhook URL. The app validates the signing secret and processes the message. This is an **inbound** connection — Slack initiates the request.

### Socket Mode (moltworker)

```json
{
  "botToken": "xoxb-...",
  "appToken": "xapp-..."
}
```

OpenClaw opens a WebSocket to Slack's servers. Events arrive over that WebSocket. This is an **outbound** connection — the sandbox initiates and maintains it.

### The tradeoff

| Concern | HTTP mode | Socket Mode |
|---------|-----------|-------------|
| Wake-from-sleep | Works — webhook hits a Vercel Function | Broken — WebSocket dies with the sandbox |
| Deployment protection | Blocked — Slack can't reach the webhook | Works — no inbound requests needed |
| Message during sleep | Queued in Workflow, delivered on wake | Lost until sandbox reconnects |
| Boot message | Sent immediately on webhook receipt | Not possible (no trigger) |
| Complexity | ~1,500 lines (webhook route + adapter + workflow) | Zero (OpenClaw handles it) |

**You cannot have both wake-from-sleep and deployment protection with the same channel.** HTTP mode enables wake-from-sleep but breaks deployment protection. Socket Mode enables deployment protection but breaks wake-from-sleep.

## Telegram: no outbound-only option

Telegram supports two connection modes:

- **Webhooks** (inbound): Telegram POSTs updates to a URL you register via `setWebhook`. This is what both vercel-openclaw and moltworker use.
- **`getUpdates` long-polling** (outbound): Your app polls Telegram's API for new updates. Neither project uses this today.

### Why Telegram is harder than Slack

Slack offers Socket Mode as a first-class outbound alternative. Telegram's outbound option (`getUpdates`) requires a persistent polling loop inside the sandbox. If the sandbox sleeps, the polling loop dies, and messages accumulate on Telegram's side until the sandbox wakes and resumes polling.

Unlike Slack Socket Mode (where the SDK handles reconnection and Slack retries recent events), Telegram's `getUpdates` requires the app to track an offset and catch up manually. Messages are not lost — they remain in Telegram's queue for 24 hours — but there is no push notification to wake the sandbox.

### Telegram and deployment protection

Telegram webhook URLs cannot include the `x-vercel-protection-bypass` query parameter. Including it causes `setWebhook` to silently drop the registration. This means Telegram webhooks are incompatible with Vercel Deployment Protection unless a Deployment Protection Exception is configured for the webhook path.

See [Deployment Protection](deployment-protection.md) for the full breakdown.

## Always-on sandbox vs sleep/wake

moltworker defaults to `keepAlive: true` — the sandbox runs indefinitely. vercel-openclaw defaults to sleeping after 30 minutes of inactivity.

### Why moltworker stays always-on

An always-on sandbox eliminates the need for:

- Wake-from-sleep orchestration (~6,700 lines in vercel-openclaw)
- Durable channel delivery (Workflow, dedup locks, boot messages)
- Watchdog cron wake logic
- Cron job persistence across snapshots
- Setup progress tracking and waiting pages

moltworker's always-on container is 0.5 vCPU. The cost is constant but low.

### Why vercel-openclaw sleeps

Vercel Sandbox billing is usage-based. Sleeping the sandbox when idle reduces cost significantly for infrequent users. The tradeoff is the complexity of the wake path: resuming the persistent sandbox, syncing config, re-establishing channel connections, and handling messages that arrive during the transition.

The `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` variable controls the timeout (default: 1,800,000ms = 30 minutes). Setting it very high effectively mimics always-on behavior at higher cost.

## Auth: external vs app-owned

moltworker delegates auth to Cloudflare Access (~190 lines of app code). vercel-openclaw implements auth internally (~2,500 lines).

### Cloudflare Access (moltworker)

Cloudflare Access is a separate product configured in the Cloudflare dashboard. It sits as a reverse proxy in front of the worker, intercepting all requests. Unauthenticated users are redirected to a login page (Google, GitHub, email OTP, SAML, Okta). After login, Cloudflare sets a signed JWT cookie. The worker validates the JWT against Cloudflare's JWKS endpoint — 35 lines of code.

Setup: ~5 minutes in the Cloudflare Zero Trust dashboard. Zero app code for the login flow.

### Sign in with Vercel / admin-secret (vercel-openclaw)

Vercel does not offer an equivalent edge-level auth product that intercepts requests before they reach the app. The app implements:

- `admin-secret` mode (default): password exchanged for an encrypted session cookie
- `sign-in-with-vercel` mode: full OAuth + PKCE flow with token refresh
- CSRF protection on cookie-based mutations
- Rate limiting on auth endpoints

Setup: set `ADMIN_SECRET` (simple) or configure OAuth client credentials (more secure).

### Why the app can't use Vercel Deployment Protection as auth

Deployment Protection was attempted and abandoned. It blocks ALL unauthenticated requests — including channel webhooks from Slack and Telegram. It is also unavailable on Hobby plans. The bypass secret works for Slack but not for Telegram (see above).

## Firewall: enforced vs absent

vercel-openclaw has a firewall with three modes (disabled, learning, enforcing). moltworker has no firewall.

This is not a tradeoff — it is a feature gap. moltworker provides no egress control. The sandbox can reach any domain. vercel-openclaw's firewall learns which domains the agent contacts, then allows operators to lock down egress to only those domains via Vercel Sandbox NetworkPolicy.

## Summary of complexity by feature area

Approximate production lines (excluding tests):

| Feature | vercel-openclaw | moltworker | Primary driver of difference |
|---------|----------------|------------|------------------------------|
| Channels (app-owned) | ~10,700 | 0 | Sleep/wake requires control plane delivery |
| Sleep/wake orchestration | ~6,700 | ~200 | Always-on eliminates wake path |
| Config + bootstrap | ~6,700 | ~300 | Hash-verified config sync vs env vars |
| Firewall | ~3,900 | 0 | Feature not present in moltworker |
| Auth | ~2,600 | ~200 | External auth product vs app-owned |
| Deploy verification | ~2,500 | 0 | Feature not present in moltworker |
| **Total** | **~36,600** | **~4,300** | |

The largest single contributor is the channel layer (~30%), followed by sleep/wake (~18%). Together they account for roughly half the codebase difference.
