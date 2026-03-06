# vercel-openclaw

Single-instance OpenClaw for Vercel Sandboxes.

This app takes the multi-sandbox dashboard approach from `moltbot-on-vercel` and strips it down to one persistent sandbox with:

- a single OpenClaw instance
- `/gateway` reverse proxying through the app domain
- auto-create / auto-restore on demand
- a learning -> enforcing egress firewall backed by `sandbox.updateNetworkPolicy()`
- Vercel-protected access, either through Deployment Protection or Sign in with Vercel

## What is implemented

- Next.js 16 App Router app
- single-record control plane with Upstash REST storage or in-memory fallback
- OpenClaw bootstrap that writes config, token, startup script, and restore script
- `/gateway/[[...path]]` proxy with HTML injection for WebSocket rewriting and token handoff
- minimal admin UI at `/` and `/admin`
- firewall APIs and UI for mode changes, allowlist updates, and learned-domain promotion

## Current behavior

- First request to `/gateway` or `POST /api/admin/ensure` starts sandbox creation in the background and returns a waiting page until the gateway is ready.
- `POST /api/admin/stop` snapshots the running sandbox and leaves it in `stopped` state.
- `POST /api/admin/snapshot` currently uses the same snapshot-and-stop behavior.
- Restore works from the latest stored snapshot.
- The initial bootstrap does not auto-snapshot yet. That means the first restorable snapshot is created when you manually snapshot or stop the sandbox.

## Auth modes

`VERCEL_AUTH_MODE` supports:

- `deployment-protection`
  Use Vercel Deployment Protection / Vercel Authentication. This is the default mode if `VERCEL_AUTH_MODE` is unset.
- `sign-in-with-vercel`
  Use app-level OAuth with Vercel and encrypted session cookies.

## Environment

Recommended for production:

```bash
VERCEL_AUTH_MODE=deployment-protection
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
AI_GATEWAY_API_KEY=
```

Required only for `VERCEL_AUTH_MODE=sign-in-with-vercel`:

```bash
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=
VERCEL_APP_CLIENT_SECRET=
SESSION_SECRET=
NEXT_PUBLIC_APP_URL=https://your-app.example.com
```

Accepted store env aliases:

- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- `KV_REST_API_URL` / `KV_REST_API_TOKEN`

If no store env vars are present, the app falls back to an in-memory store. That is useful for local development but not safe for production persistence.

## Local development

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Routes

- `/`
  Admin shell
- `/admin`
  Same admin shell on a stable path
- `/gateway`
  Proxied OpenClaw UI
- `/api/status`
  Current sandbox + firewall status, plus heartbeat `POST`
- `/api/admin/ensure`
  Trigger create or restore
- `/api/admin/stop`
  Snapshot and stop
- `/api/firewall`
  Read or change firewall mode

## Notes

- With the current implementation, firewall learning comes from shell command logging inside the sandbox and is ingested during status polling.
- `AI_GATEWAY_API_KEY` is optional if your Vercel project can mint OIDC tokens for Vercel AI Gateway. Locally, setting `AI_GATEWAY_API_KEY` is the practical path.
- The app uses Upstash REST storage semantics but keeps a small abstraction so the fallback in-memory store works for local testing.
