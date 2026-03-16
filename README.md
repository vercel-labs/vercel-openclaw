# vercel-openclaw

Run one persistent OpenClaw instance on a Vercel Sandbox, serve it through your app domain at `/gateway`, and tighten egress from learning mode to an enforced allowlist.

## Overview

This repository is the single-instance extraction of the larger `moltbot-on-vercel` dashboard. It keeps the hard parts:

- OpenClaw bootstrap on a Vercel Sandbox
- reverse proxying through the Next.js app
- HTML injection for WebSocket rewriting and gateway token handoff
- auto-create and auto-restore on demand
- hypervisor-level firewall enforcement through `sandbox.updateNetworkPolicy()`
- Slack, Telegram, and Discord channel entry points backed by durable queues

It removes the fleet concerns:

- no multi-sandbox dashboard
- no per-sandbox password gate
- no admin bearer token

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw&env=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN&envDescription=Recommended%20for%20durable%20state.%20AI%20Gateway%20uses%20OIDC%20on%20Vercel%20by%20default.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw%23environment-variables&project-name=openclaw&repository-name=openclaw)

Clicking the button will prompt you for the recommended environment variables:

| Variable | Description |
| -------- | ----------- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint. Required for production persistence. Provision via [Vercel Marketplace](https://vercel.com/marketplace/upstash-redis) or the Upstash console. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token, paired with the URL above. |

### After deploying

- **`deployment-protection` (default)**: no extra setup needed — Vercel's built-in Deployment Protection handles auth. Ensure Deployment Protection is enabled in your project's Security settings (it is on by default).
- **`sign-in-with-vercel` (optional upgrade)**: create a Vercel OAuth application at [vercel.com/account/oauth-apps](https://vercel.com/account/oauth-apps) and set `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` and `VERCEL_APP_CLIENT_SECRET` as additional environment variables. Set the callback URL to `https://<your-domain>/api/auth/callback`.
- **Upstash Redis is required for production**. Without it, the app falls back to in-memory state that is lost on every function cold start. You can provision Upstash directly from the [Vercel Marketplace](https://vercel.com/marketplace/upstash-redis) for integrated billing.
- **AI Gateway on Vercel uses OIDC by default.** You do not need `AI_GATEWAY_API_KEY` on Vercel unless you explicitly want to override that behavior.

### Deployment Protection + channel webhooks

If you keep `VERCEL_AUTH_MODE=deployment-protection`, enable **Protection Bypass for Automation** in Vercel.

When `VERCEL_AUTOMATION_BYPASS_SECRET` is available, vercel-openclaw will automatically append `x-vercel-protection-bypass` to the generated Slack, Telegram, and Discord webhook URLs so those platforms can reach your protected deployment.

## Production launch contract

A deployment is not channel-ready until launch verification passes. The authoritative check is `POST /api/admin/launch-verify`, which runs:

1. **Preflight** — config checks (public origin, webhook bypass, durable store, AI Gateway OIDC)
2. **Queue delivery** — publishes a loopback probe through Vercel Queues and waits for the private callback at `/api/queues/launch-verify`
3. **Sandbox ensure** — starts or restores the sandbox
4. **Chat completions** — sends a test message through the OpenClaw gateway
5. **Wake from sleep** *(destructive mode)* — stops the sandbox, then verifies a queue-delivered job can wake it and complete a chat round-trip

A deployment passes when all phases return `"status": "pass"` or `"skip"`.

**Do not connect Slack, Telegram, or Discord until launch verification passes.**

### Verifying deployed readiness

Run the full launch verification against your deployed instance:

```bash
OPENCLAW_BASE_URL="https://your-project.vercel.app" \
  node scripts/check-deploy-readiness.mjs --json-only
```

For `deployment-protection` mode, also supply the bypass secret:

```bash
OPENCLAW_BASE_URL="https://your-project.vercel.app" \
  VERCEL_AUTOMATION_BYPASS_SECRET="$VERCEL_AUTOMATION_BYPASS_SECRET" \
  node scripts/check-deploy-readiness.mjs --json-only
```

The script POSTs to `/api/admin/launch-verify`, validates the launch contract, and exits 0 only when all phases pass. Use `--preflight-only` for a lightweight config-only check via `GET /api/admin/preflight`. Secrets are redacted in all output.

### Requirements for channel-capable deployments

- **Upstash Redis** — in-memory state loses queue data, credentials, and sandbox metadata on cold starts. Channels require durable state.
- **AI Gateway OIDC** — `AI_GATEWAY_API_KEY` is for local development only. Do not set it in Vercel project environment variables. Deployed environments authenticate to AI Gateway through OIDC automatically.
- **Protection Bypass for Automation** — if `VERCEL_AUTH_MODE=deployment-protection`, enable Protection Bypass in your Vercel project settings before connecting channels. Without it, Slack, Telegram, and Discord webhooks will be blocked.

## Quickstart

## Prerequisites

- Node.js 20 or newer
- npm
- access to Vercel Sandboxes
- an auth strategy

Use one of these auth strategies:

- **Deployment Protection**: Set `VERCEL_AUTH_MODE=deployment-protection` and protect the deployment with Vercel Authentication.
- **Sign in with Vercel**: Set `VERCEL_AUTH_MODE=sign-in-with-vercel` and provide OAuth credentials.

## Install dependencies

```bash
npm install
```

## Configure environment variables

Create a local `.env.local` from `.env.example`.

Minimum production setup with persistent state:

```bash
VERCEL_AUTH_MODE=deployment-protection
UPSTASH_REDIS_REST_URL=your_upstash_rest_url_here
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token_here
# AI_GATEWAY_API_KEY is optional — on Vercel, OIDC is used automatically.
```

If you use `VERCEL_AUTH_MODE=sign-in-with-vercel`, also set:

```bash
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=your_vercel_app_client_id_here
VERCEL_APP_CLIENT_SECRET=your_vercel_app_client_secret_here
SESSION_SECRET=your_session_secret_here
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Start the app

```bash
npm run dev
```

Open `http://localhost:3000`.

## How it works

## Architecture

The app has two planes:

- **Control plane**: A single metadata record stored in Upstash Redis REST or an in-memory fallback. It tracks sandbox ID, snapshot ID, lifecycle status, cached port URLs, firewall state, and the OpenClaw gateway token.
- **Enforcement plane**: The `@vercel/sandbox` SDK creates, restores, snapshots, and updates the sandbox network policy.

The core request path is:

1. A user opens `/gateway`.
2. The app authenticates the request.
3. If no sandbox is running, the app schedules create or restore work with `after()` and returns a waiting page.
4. Once the sandbox is ready, the app proxies the request to the sandbox route for port `3000`.
5. HTML responses are modified so the browser:
   - rewrites WebSocket connections from `/gateway` to the sandbox origin
   - appends the gateway token as a WebSocket subprotocol
   - briefly injects `?token=...` so the OpenClaw client can initialize
   - strips the token from the visible URL again

## Lifecycle model

The sandbox metadata uses these states:

- `uninitialized`
- `creating`
- `setup`
- `booting`
- `running`
- `stopped`
- `restoring`
- `error`

Important lifecycle behavior:

- `POST /api/admin/ensure` or the first request to `/gateway` starts create or restore work in the background.
- `POST /api/admin/stop` creates a snapshot and leaves the sandbox in `stopped`.
- `POST /api/admin/snapshot` currently has the same snapshot-and-stop behavior.
- The first successful bootstrap automatically creates a recovery snapshot, so later `ensure` calls can restore instead of rebuilding from scratch.

## Firewall model

The firewall state is stored with the sandbox metadata and maps to network policy like this:

- `disabled` -> `allow-all`
- `learning` -> `allow-all`
- `enforcing` -> `{ allow: [...] }`

Learning mode currently works by:

1. adding shell hooks in the sandbox startup script
2. writing executed shell commands to `/tmp/shell-commands-for-learning.log`
3. ingesting that log during status polling
4. extracting domains from observed commands

The admin UI lets you:

- change firewall mode
- add or remove allowlist domains
- review learned domains and hit counts
- promote learned domains into the allowlist and switch to enforcing

## Channels

The app can expose the same single OpenClaw sandbox through:

- Slack Events API
- Telegram webhooks
- Discord interactions

Channel flow:

1. the public webhook route validates the platform signature or secret
2. the handler publishes a message to a Vercel Queue topic (`channel-slack`, `channel-telegram`, or `channel-discord`)
3. a private queue consumer route under `/api/queues/channels/*` restores the sandbox if needed
4. the consumer sends the message to `POST /v1/chat/completions` on the OpenClaw gateway
5. the app delivers the reply back to the originating channel

Private queue consumers are configured in `vercel.json` and are not publicly reachable on Vercel. `/api/cron/drain-channels` is an optional diagnostic backstop when `CRON_SECRET` is configured — it is not the primary delivery path.

Current behavior:

- Slack uses threaded replies and supports Slack app manifest generation plus bot-token validation
- Telegram validates bot tokens with `getMe`, rotates webhook secrets, and replies through the Bot API
- Discord can configure the interactions endpoint, register the `/ask` command, and patch deferred interaction responses

### Local queue development

```bash
vercel link
vercel env pull
```

This writes the OIDC credentials that `@vercel/queue` needs for local `send` and `handleCallback` calls. On deployed Vercel environments, queue auth is automatic.

## Auth modes

## `deployment-protection`

This is the default mode if `VERCEL_AUTH_MODE` is unset.

Use Vercel Deployment Protection and Vercel Authentication to protect the app externally. The app does not maintain its own human session in this mode.

## `sign-in-with-vercel`

This mode adds app-level OAuth:

- `/api/auth/authorize` starts the flow
- `/api/auth/callback` exchanges the code and sets an encrypted cookie session
- `/api/auth/signout` clears the session

Session details:

- the session is stored in an encrypted cookie
- the ID token is verified against Vercel's JWKS
- access tokens are refreshed before expiry
- refresh failure clears the session and forces a new login

## Environment variables

| Variable                           | Required | Purpose |
| ---------------------------------- | -------- | ------- |
| `VERCEL_AUTH_MODE`                 | No       | `deployment-protection` or `sign-in-with-vercel`. Defaults to `deployment-protection`. |
| `UPSTASH_REDIS_REST_URL`           | Required    | Primary persistent store endpoint. Required for channel-capable deployments. |
| `UPSTASH_REDIS_REST_TOKEN`         | Required    | Primary persistent store token. Required for channel-capable deployments. |
| `KV_REST_API_URL`                  | Optional | Alias for REST store URL. |
| `KV_REST_API_TOKEN`                | Optional | Alias for REST store token. |
| `AI_GATEWAY_API_KEY`               | Local dev only | Static AI Gateway credential for local development. Do not set on deployed Vercel environments — OIDC is used automatically. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | Sign-in mode | OAuth client ID. |
| `VERCEL_APP_CLIENT_SECRET`         | Sign-in mode | OAuth client secret. |
| `SESSION_SECRET`                   | Sign-in mode | Cookie encryption secret. Must be explicitly set on deployed Vercel environments — do not rely on silent derivation from the Upstash token. |
| `OPENCLAW_PACKAGE_SPEC`            | Vercel   | Pinned OpenClaw version (e.g. `openclaw@1.2.3`). Required on Vercel for deterministic builds. Local dev falls back to `openclaw@latest`. |
| `VERCEL_AUTOMATION_BYPASS_SECRET`  | Conditional | Required when `VERCEL_AUTH_MODE=deployment-protection` and channel webhooks are used. Enable Protection Bypass for Automation in Vercel. |
| `CRON_SECRET`                      | Optional | Enables `/api/cron/drain-channels` as a diagnostic backstop. Not required for production — Vercel Queues is the primary delivery path. |
| `NEXT_PUBLIC_APP_URL`              | Optional | Base origin for OAuth callback generation. Useful behind custom domains. |
| `NEXT_PUBLIC_BASE_DOMAIN`          | Optional | Preferred external host for Discord endpoint generation and manifest links. |

If no REST store variables are present, the app falls back to in-memory state. That is useful for local testing but not safe for persistent production behavior.

## Commands

```bash
npm run dev
npm run lint
npm test
npm run typecheck
npm run build
```

Tests use Node's built-in `node:test` runner. Run `npm test` or use `node scripts/verify.mjs --steps=test`.

## Project structure

```text
src/
├── app/
│   ├── api/                    # Auth, admin, firewall, status, health
│   ├── gateway/[[...path]]/    # Reverse proxy route
│   ├── admin/                  # Admin page
│   └── page.tsx                # Root page
├── components/
│   └── admin-shell.tsx         # Admin UI
├── server/
│   ├── auth/                   # Session cookies and Vercel OAuth
│   ├── channels/               # Channel adapters, queue driver, public state
│   ├── firewall/               # Domain parsing, state, policy mapping
│   ├── openclaw/               # Config generation and bootstrap
│   ├── proxy/                  # HTML injection, waiting page, proxy helpers
│   ├── sandbox/                # Lifecycle orchestration
│   └── store/                  # Upstash and in-memory backends
└── shared/
    ├── http.ts                 # API error helpers
    └── types.ts                # Single-instance metadata and firewall types
```

## Routes

| Route | Purpose |
| ----- | ------- |
| `/` | Admin shell |
| `/admin` | Same admin shell on a stable path |
| `/gateway` | Proxied OpenClaw UI |
| `/api/status` | Current sandbox state and heartbeat `POST` |
| `/api/channels/slack` | Slack config CRUD |
| `/api/channels/slack/test` | Slack bot-token validation |
| `/api/channels/slack/manifest` | Slack app manifest helper |
| `/api/channels/slack/webhook` | Public Slack webhook |
| `/api/channels/telegram` | Telegram config CRUD |
| `/api/channels/telegram/preview` | Telegram bot-token preview |
| `/api/channels/telegram/webhook` | Public Telegram webhook |
| `/api/channels/discord` | Discord config CRUD |
| `/api/channels/discord/register-command` | Register Discord `/ask` |
| `/api/channels/discord/webhook` | Public Discord interactions endpoint |
| `/api/queues/launch-verify` | Private Vercel Queues consumer for launch verification probes |
| `/api/queues/channels/slack` | Private Vercel Queues consumer for Slack delivery |
| `/api/queues/channels/telegram` | Private Vercel Queues consumer for Telegram delivery |
| `/api/queues/channels/discord` | Private Vercel Queues consumer for Discord delivery |
| `/api/cron/drain-channels` | Optional diagnostic backstop — not the primary delivery path |
| `/api/admin/ensure` | Trigger create or restore |
| `/api/admin/stop` | Snapshot and stop |
| `/api/admin/snapshot` | Snapshot and stop |
| `/api/admin/preflight` | Deployment readiness checks (config-only) |
| `/api/admin/launch-verify` | Full launch verification (preflight + runtime phases) |
| `/api/firewall` | Read or update firewall mode |
| `/api/firewall/allowlist` | Add or remove allowlist domains |
| `/api/firewall/promote` | Promote learned domains to enforcing |
| `/api/auth/*` | Sign in with Vercel flow |

## Verification

### Local verification

Use this command for all local automation and CI:

```bash
node scripts/verify.mjs
```

This runs `lint`, `test`, `typecheck`, and `build`, emits JSON lines, and exits non-zero on the first failing step. Do not invoke bare `npm` or `tsx` directly from automation.

Run a subset of steps:

```bash
node scripts/verify.mjs --steps=test,typecheck
```

### Deployed readiness verification

After deploying, verify the instance is channel-ready before connecting Slack, Telegram, or Discord:

```bash
OPENCLAW_BASE_URL="https://your-project.vercel.app" \
  node scripts/check-deploy-readiness.mjs --json-only
```

This POSTs to `/api/admin/launch-verify` and validates the full launch contract. Use `--preflight-only` for a lightweight config-only check. See [Production launch contract](#production-launch-contract) for details.

## Limitations and sharp edges

- The initial bootstrap now creates a recovery snapshot automatically.
- The in-memory store is not production-safe and loses state on process recycle.
- Firewall learning depends on shell command logging. It does not inspect every possible network path inside the sandbox.
- The startup script and restore script assume the OpenClaw gateway runs on port `3000`.
- Channel queues persist only as long as the backing store does. In-memory mode is not suitable for production webhooks.
