---
name: telegram-native-8787
description: Telegram channel specialist workflow: debug /api/channels/telegram/webhook, native port 8787 /telegram-webhook, webhookSecret, boot cleanup, and post-accept reply visibility.
---

# Telegram Native 8787

Use after `channel-debug-core` for Telegram issues.

## Files

- `src/app/api/channels/telegram/webhook/route.ts`
- `src/server/channels/telegram/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/openclaw/config.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Telegram update -> /api/channels/telegram/webhook -> secret header validation -> dedup -> fast path to sandbox port 8787 /telegram-webhook OR workflow -> local/public native handler probe -> OpenClaw Telegram provider -> Telegram user-visible reply
```

## Special Checks

- Port 8787 is not port 3000.
- Native handler registered evidence is local/public probe behavior, especially local 401 on invalid secret.
- Fast, empty 200 is suspicious; do not call it accepted.
- `lastRestoreMetrics.telegramListenerReady` is evidence, not the whole truth.
- `webhookSecret` must flow through config build, restore assets, dynamic resume files, and config hash.
- Accepted forward does not prove a visible Telegram reply.
- Boot message send/update/delete behavior is user-visible evidence.
