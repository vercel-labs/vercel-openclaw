# Vercel Connect as the Slack ingress

Historical research from August 13, 2026. The current native Slack PoC is documented in [host/CODEX-POC.md](../host/CODEX-POC.md). The original research remains in Git history; unpinned local/internal source citations have been removed from this handoff.

## Original decision

The earlier host used Connect as the front door and translated Slack messages into `openclaw agent` turns. It posted replies itself. That implementation is preserved at [83882fe](https://github.com/vercel-labs/vercel-openclaw/blob/83882fe3c92bb311a3e9d27dfb513370912c5d1f/host/app/api/slack/route.ts).

Before Connect, the host verified Slack signature headers and forwarded them to OpenClaw's listener: [pre-Connect route](https://github.com/vercel-labs/vercel-openclaw/blob/8f03f91da204d18bfc4deefac6110e67a45ef7bc/host/app/api/webhook/%5Bchannel%5D/route.ts).

## Current boundary

The Codex/native Slack path verifies the forwarded request in the host, applies explicit admission policy, and forwards the full Slack envelope to OpenClaw with a separate per-run signature. Slack API requests receive credentials through the firewall. OpenClaw handles the native reply.

See [the host route](../host/app/api/slack/route.ts), [lifecycle](../host/lib/codex-lifecycle.ts), and [native listener integration](../worker-provider/runtime/native-slack.mjs). The older text-only path remains opt-in by leaving Codex disabled. Its channel-wide session behavior is not the native path's thread-scoped behavior.

## Public references

- [Connect triggers](https://vercel.com/docs/connect/concepts/triggers)
- [Connect project identity](https://vercel.com/blog/introducing-vercel-connect#the-app-proves-its-identity-with-oidc)
- [Trusted Sources for Deployment Protection](https://vercel.com/changelog/trusted-sources-for-deployment-protection)
- [Connect Slack exercise](https://vercel.com/academy/building-agents-with-eve/add-slack)

These references explain the surrounding products. They do not replace the PoC's pinned source and live tests or establish OAuth-expiry, crash-recovery or production-readiness proof.
