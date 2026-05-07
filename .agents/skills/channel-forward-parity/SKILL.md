---
name: channel-forward-parity
description: Webhook route parity audit for channel delivery changes: ensure terminal paths log, record lastForward, classify failures, and refresh stale sandbox port URLs.
---

# Channel Forward Parity

Use this before modifying any channel webhook route or the shared drain-channel workflow.

## Source Files To Audit

- `src/server/channels/last-forward.ts`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/app/api/channels/slack/webhook/route.ts`
- `src/app/api/channels/telegram/webhook/route.ts`
- `src/app/api/channels/discord/webhook/route.ts`
- `src/app/api/channels/whatsapp/webhook/route.ts`
- `src/app/api/channels/summary/route.ts`
- `src/server/admin/why-not-ready.ts`

## Required Output

Produce a table:

| Channel | Branch | Logs event | Updates lastForward | Classification | Stale URL refresh | Evidence |
|---|---|---|---|---|---|---|

## Rules

- Every delivery attempt must update `lastForward`.
- Every skip/reject branch must log a structured reason.
- Workflow forwarding already records `lastForward`; do not double-record above it.
- Treat route-ready, native-accepted, and user-visible-reply separately.
- Do not add info-level logs on hot polling paths unless operationally necessary; ring-buffer eviction hides evidence.
- Never add `export const runtime = "nodejs"` to route handlers.

## Current Audit Seeds

- Check Slack fast-path fetch-exception branches for `recordChannelLastForward` coverage.
- Check Telegram unauthorized, invalid JSON, and dedup branches for structured logs where operator evidence is needed.
- Check WhatsApp duplicate/skip branches for structured logs and clear classifications.
- Check every `sandbox-not-listening` branch for exactly one stale-port refresh per request.
