---
name: whatsapp-delivery
description: WhatsApp channel specialist workflow: debug Meta webhook verification/signatures, link-state projection, /whatsapp-webhook fast path, boot messages, and adapter delivery.
---

# WhatsApp Delivery

Use after `channel-debug-core` for WhatsApp issues.

## Files

- `src/app/api/channels/whatsapp/webhook/route.ts`
- `src/server/channels/whatsapp/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Meta webhook verification GET OR message POST -> app route -> x-hub-signature-256 validation -> dedup -> fast path to port 3000 /whatsapp-webhook OR workflow -> WhatsApp adapter/API reply
```

## Special Checks

- GET verification and POST delivery are different paths.
- `linkState` is not the same as user-visible reply.
- Meta signature validation depends on raw body.
- Handler non-OK may still prove handler receipt; classify precisely.
- Boot message send/delete behavior affects user-visible state.
- `lastForward` must reflect fast-path failure as well as success.
