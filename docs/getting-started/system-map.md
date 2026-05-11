# System Map

OpenClaw on Vercel is a three-repository system: `vclaw` creates the deployment, this dashboard operates it, and OpenClaw bundle releases provide the runtime.

```mermaid
flowchart LR
  User[Operator] --> CLI[vclaw CLI]
  CLI --> Project[Vercel project]
  CLI --> Dashboard[vercel-openclaw dashboard]
  CLI --> Redis[Redis marketplace store]
  CLI --> Bundle[Latest OpenClaw bundle release]
  Dashboard --> Sandbox[Vercel Sandbox]
  Dashboard --> GatewayProxy[/gateway proxy]
  Sandbox --> OpenClaw[OpenClaw gateway]
  OpenClaw --> Plugins[Channel and tool plugins]
  Slack[Slack] --> Dashboard
  Telegram[Telegram] --> Dashboard
  Discord[Discord] --> Dashboard
  WhatsApp[WhatsApp] --> Dashboard
  Dashboard --> OpenClaw
```

## Repo Responsibilities

| Layer | Repo | Responsibility |
| --- | --- | --- |
| Runtime | `vercel-labs/openclaw` | Builds the OpenClaw CLI/runtime, plugin SDK, channel handlers, and sandbox bundle assets. |
| Control plane | `vercel-labs/vercel-openclaw` | Hosts the admin UI and APIs, manages one persistent sandbox, proxies `/gateway`, stores state, and receives channel webhooks. |
| Scaffolding | `vercel-labs/vclaw` | Creates the local workspace and Vercel project, provisions Redis/env/protection, deploys, verifies, and optionally connects channels. |

## Main Contracts

- `vclaw` must resolve a compatible OpenClaw bundle release before deploy when possible.
- `vercel-openclaw` must inject dynamic config and credentials into the sandbox without leaking AI Gateway tokens into sandbox files or operator-visible logs.
- OpenClaw bundle releases must include the sidecar assets expected by `vclaw` and the dashboard bootstrap path.
- Channel delivery must distinguish setup, route readiness, native acceptance, and user-visible reply.

## Dashboard Ownership

This repository owns the control plane only. It does not publish the `vclaw` package and it does not build the OpenClaw runtime bundle, but changes here can still break both contracts.

Use `node scripts/verify.mjs` for dashboard verification. When a change affects the guide, env names, or operator instructions, also run `pnpm check:verify-contract` when env contract text changed.
