---
name: slack-delivery
description: Slack channel specialist workflow: debug Slack OAuth vs delivery-ready, /slack/events fast path, raw-body signatures, route repair, boot-message cleanup, and lastForward.
---

# Slack Delivery

Use after `channel-debug-core` for Slack issues.

## Files

- `src/app/api/channels/slack/webhook/route.ts`
- `src/server/channels/slack/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Slack event -> /api/channels/slack/webhook -> Slack signature validation over raw body -> event/bot/subtype/user-message dedup -> fast path to port 3000 /slack/events OR workflow -> Bolt signature re-verification -> threaded Slack reply
```

## Special Checks

- Raw body and `x-slack-*` headers must survive forwarding.
- Slack 401 from native handler usually means Bolt signature failure.
- OAuth complete is not delivery-ready.
- `liveConfigSync` failed can be overridden by recent accepted `lastForward`.
- Route repair after 404 must be proven with before/after signals.
- Pending boot message cleanup happens when bot reply events arrive.
- `app_mention` plus `message.channels` can duplicate user intent.
