---
name: discord-delivery
description: Discord channel specialist workflow: debug interaction webhooks, Ed25519 signatures, deferred replies, workflow forwarding to /discord-webhook, integration reconcile, and token expiry.
---

# Discord Delivery

Use after `channel-debug-core` for Discord issues.

## Files

- `src/app/api/channels/discord/webhook/route.ts`
- `src/server/channels/discord/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Discord interaction -> /api/channels/discord/webhook -> Ed25519 signature validation -> PING type 1 or deferred type 5 -> workflow -> reconcileDiscordIntegration -> native forward to port 3000 /discord-webhook -> interaction edit or channel fallback
```

## Special Checks

- Returning type 5 proves only defer, not final reply.
- Interaction token budget matters; check preempt/fallback logs.
- Soft deadline is around 13.5 minutes in workflow logic.
- Reconcile failures can be causal.
- User-visible reply evidence must include interaction edit or channel fallback outcome.
- If a fast path is added later, apply `channel-forward-parity`.
