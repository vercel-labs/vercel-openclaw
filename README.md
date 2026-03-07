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

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw&env=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN,SESSION_SECRET,VERCEL_AUTH_MODE&envDescription=Required%20environment%20variables%20for%20OpenClaw&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw%23environment-variables&project-name=openclaw&repository-name=openclaw)

Clicking the button will prompt you for the required environment variables:

| Variable | Description |
| -------- | ----------- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint. Required for production persistence. Provision via [Vercel Marketplace](https://vercel.com/marketplace/upstash-redis) or the Upstash console. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token, paired with the URL above. |
| `SESSION_SECRET` | Random 32+ character secret for encrypting session cookies. Generate with `openssl rand -hex 32`. |
| `VERCEL_AUTH_MODE` | Set to `sign-in-with-vercel` (recommended) or `deployment-protection`. |

### After deploying

- **If you chose `sign-in-with-vercel`**: you must create a Vercel OAuth application at [vercel.com/account/oauth-apps](https://vercel.com/account/oauth-apps) and set `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` and `VERCEL_APP_CLIENT_SECRET` as additional environment variables in your Vercel project settings. Set the callback URL to `https://<your-domain>/api/auth/callback`.
- **If you chose `deployment-protection`**: enable Vercel Authentication on the deployment under your project's Security settings. No additional OAuth configuration is needed, but set `ALLOW_PLATFORM_ONLY_AUTH=true` in environment variables to acknowledge you are relying on platform-level protection.
- **Upstash Redis is required for production**. Without it, the app falls back to in-memory state that is lost on every function cold start. You can provision Upstash directly from the [Vercel Marketplace](https://vercel.com/marketplace/upstash-redis) for integrated billing.
- **AI Gateway** (optional): enable AI Gateway in your Vercel project settings and add `AI_GATEWAY_API_KEY` if you want LLM access through the sandbox.

## Quickstart

## Prerequisites

- Node.js 20 or newer
- pnpm
- access to Vercel Sandboxes
- an auth strategy

Use one of these auth strategies:

- **Deployment Protection**: Set `VERCEL_AUTH_MODE=deployment-protection` and protect the deployment with Vercel Authentication.
- **Sign in with Vercel**: Set `VERCEL_AUTH_MODE=sign-in-with-vercel` and provide OAuth credentials.

## Install dependencies

```bash
pnpm install
```

## Configure environment variables

Create a local `.env.local` from `.env.example`.

Minimum production setup with persistent state:

```bash
VERCEL_AUTH_MODE=deployment-protection
UPSTASH_REDIS_REST_URL=your_upstash_rest_url_here
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token_here
AI_GATEWAY_API_KEY=your_ai_gateway_api_key_here
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
pnpm dev
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
- The first restorable snapshot is manual. The app does not auto-snapshot immediately after the first bootstrap yet.

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
2. the request is acknowledged quickly
3. the payload is queued in the control-plane store
4. a channel-specific drainer restores the sandbox if needed
5. the drainer sends the message to `POST /v1/chat/completions` on the OpenClaw gateway
6. the app delivers the reply back to the originating channel

Current behavior:

- Slack uses threaded replies and supports Slack app manifest generation plus bot-token validation
- Telegram validates bot tokens with `getMe`, rotates webhook secrets, and replies through the Bot API
- Discord can configure the interactions endpoint, register the `/ask` command, and patch deferred interaction responses
- queue durability depends on the selected store backend; use Upstash for production
- `GET` or `POST /api/cron/drain-channels` can be called with `CRON_SECRET` auth to replay deferred work on a schedule

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
| `UPSTASH_REDIS_REST_URL`           | Recommended | Primary persistent store endpoint. |
| `UPSTASH_REDIS_REST_TOKEN`         | Recommended | Primary persistent store token. |
| `KV_REST_API_URL`                  | Optional | Alias for REST store URL. |
| `KV_REST_API_TOKEN`                | Optional | Alias for REST store token. |
| `AI_GATEWAY_API_KEY`               | Optional | Static Vercel AI Gateway credential for local dev or explicit runtime configuration. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | Sign-in mode | OAuth client ID. |
| `VERCEL_APP_CLIENT_SECRET`         | Sign-in mode | OAuth client secret. |
| `SESSION_SECRET`                   | Sign-in mode | Cookie encryption secret. |
| `NEXT_PUBLIC_APP_URL`              | Optional | Base origin for OAuth callback generation. Useful behind custom domains. |
| `NEXT_PUBLIC_BASE_DOMAIN`          | Optional | Preferred external host for Discord endpoint generation and manifest links. |

If no REST store variables are present, the app falls back to in-memory state. That is useful for local testing but not safe for persistent production behavior.

## Commands

```bash
pnpm dev
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Tests use Node's built-in `node:test` runner through `tsx --test`.

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
| `/api/cron/drain-channels` | Replay queued channel work |
| `/api/admin/ensure` | Trigger create or restore |
| `/api/admin/stop` | Snapshot and stop |
| `/api/admin/snapshot` | Snapshot and stop |
| `/api/firewall` | Read or update firewall mode |
| `/api/firewall/allowlist` | Add or remove allowlist domains |
| `/api/firewall/promote` | Promote learned domains to enforcing |
| `/api/auth/*` | Sign in with Vercel flow |

## Verification

Run the full verification gate before you deploy changes:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Limitations and sharp edges

- The initial bootstrap does not create a snapshot automatically.
- The in-memory store is not production-safe and loses state on process recycle.
- Firewall learning depends on shell command logging. It does not inspect every possible network path inside the sandbox.
- The startup script and restore script assume the OpenClaw gateway runs on port `3000`.
- Channel queues persist only as long as the backing store does. In-memory mode is not suitable for production webhooks.
