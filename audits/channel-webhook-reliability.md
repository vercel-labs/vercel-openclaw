# Channel Webhook Reliability Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: Prelaunch-warning (no launch-blocking issues)

## Scope

- `src/app/api/channels/slack/webhook/route.ts`
- `src/app/api/channels/telegram/webhook/route.ts`
- `src/app/api/channels/whatsapp/webhook/route.ts`
- `src/app/api/channels/discord/webhook/route.ts`
- `src/server/channels/driver.ts`
- `src/app/api/channels/slack/webhook/route.test.ts`
- `src/app/api/channels/whatsapp/webhook/route.test.ts`
- `src/app/api/channels/telegram/webhook/route.test.ts`

## Findings

### FIXED — Slack fast-path comment/code mismatch on non-2xx handling

- **Evidence**: `src/app/api/channels/slack/webhook/route.ts:241-254`
- **Detail**: The leading block comment previously said "Return early only on a successful 2xx native forward. Non-2xx means the sandbox is reachable but unhealthy — reconcile stale running state and fall through to the workflow wake path." The actual code returns 200 on ANY HTTP response. Comment now aligned to match Telegram's wording: "On ANY HTTP response (2xx or not), return 200 — the native handler received the payload."
- **Status**: **Fixed** — comment updated to match runtime behavior.

### FIXED — WhatsApp fast-path comment/code mismatch on non-2xx handling

- **Evidence**: `src/app/api/channels/whatsapp/webhook/route.ts:156-169`
- **Detail**: Same pattern as Slack. Comment now aligned to match Telegram's wording.
- **Status**: **Fixed** — comment updated to match runtime behavior.

### PASS — Telegram fast-path acknowledges any HTTP response (documented)

- **Evidence**: `src/app/api/channels/telegram/webhook/route.ts:126-133, 147-157`
- **Detail**: Leading comment explicitly states "On ANY HTTP response (2xx or not), return 200 — the native handler received the payload and may have started processing. Falling through to the workflow would forward the same payload again, causing duplicate delivery." Code and comment are consistent. Test at `route.test.ts:183-218` confirms.
- **Assessment**: This is the correct documentation pattern that Slack and WhatsApp should follow.

### PASS — Signature/secret validation on all channels

- **Evidence**:
  - Slack: `route.ts:129-163` (HMAC signature via `isValidSlackSignature`)
  - Telegram: `route.ts:77-79` (`x-telegram-bot-api-secret-token` header)
  - WhatsApp: `route.ts:106-114` (`x-hub-signature-256` HMAC)
  - Discord: `route.ts:77-84` (Ed25519 signature via `verifyDiscordRequestSignature`)
- **Detail**: All four channels validate credentials before any payload processing. Rejection returns 401 (or 400 for Discord invalid JSON). No channel processes an unauthenticated payload.

### PASS — Dedup lock acquisition and release on all channels

- **Evidence**:
  - Slack: `route.ts:195-210` (acquire), `route.ts:50-67` + `route.ts:362` (release on workflow failure)
  - Telegram: `route.ts:94-105` (acquire), `route.ts:49-66` + `route.ts:194` (release)
  - WhatsApp: `route.ts:130-138` (acquire), `route.ts:44-61` + `route.ts:245` (release)
  - Discord: `route.ts:101-112` (acquire), `route.ts:46-63` + `route.ts:132` (release)
- **Detail**: All four channels acquire a 24-hour dedup lock keyed by platform-specific message ID. When workflow start fails, the lock is explicitly released so the provider can redeliver. Tests verify lock release on all tested channels.

### PASS — Workflow start failure returns retryable 500

- **Evidence**:
  - Slack: `route.ts:361-374`
  - Telegram: `route.ts:193-205`
  - WhatsApp: `route.ts:244-256`
  - Discord: `route.ts:131-143`
- **Detail**: All four channels catch workflow start errors, release the dedup lock, log the failure with `retryable: true`, and return HTTP 500 with `{ ok: false, error: "WORKFLOW_START_FAILED", retryable: true }`. This allows the platform to redeliver.

### PASS — Network failure on fast-path triggers reconcile-and-wake

- **Evidence**:
  - Slack: `route.ts:296-307`
  - Telegram: `route.ts:158-168`
  - WhatsApp: `route.ts:197-206`
- **Detail**: When `fetch()` throws (connection refused, DNS failure), all three channels with fast paths log a warning, call `reconcileStaleRunningStatus()`, and fall through to the workflow wake path. This correctly handles the stale-running metadata scenario.

### PASS — Boot message sent before workflow on wake path

- **Evidence**:
  - Slack: `route.ts:320-353` (Slack API `chat.postMessage`, ts passed to workflow)
  - Telegram: `route.ts:174-187` (`sendMessage`, message_id passed to workflow)
  - WhatsApp: `route.ts:209-232` (`sendMessage` via WhatsApp API, id passed to workflow)
- **Detail**: All three channels with boot message support send an immediate "Waking up" message from the webhook route (not the workflow), giving users instant feedback. The message ID is passed to the workflow for later deletion/update.

### PASS — Driver wake/request/reply phases are instrumented

- **Evidence**: `src/server/channels/driver.ts:162-168` (`channels.wake_requested`), `driver.ts:205-210` (`channels.wake_ready`), `driver.ts:241-247` (`channels.gateway_request_started`), `driver.ts:318-326` (`channels.gateway_response_received`), `driver.ts:338-339` (`channels.delivery_success`)
- **Detail**: The shared driver logs structured events at each phase boundary with operation context correlation. Auth recovery (410 reconciliation) is also instrumented at `driver.ts:277-301`.

### WARN — Discord has no fast-path forwarding

- **Evidence**: `src/app/api/channels/discord/webhook/route.ts:65-146`
- **Detail**: Discord is the only channel that goes directly to the workflow path without attempting a fast-path forward to the native handler. All Discord interactions are processed via the durable workflow. This is acceptable for an experimental channel but means every Discord interaction incurs workflow latency even when the sandbox is running.
- **Severity**: P3 (enhancement, not a reliability issue)
- **Recommended fix**: Consider adding a fast-path for Discord when the sandbox is running, following the Telegram pattern (any-HTTP-ack). Low priority given experimental status.

### WARN — Telegram outer try/catch swallows errors silently

- **Evidence**: `src/app/api/channels/telegram/webhook/route.ts:92-211`
- **Detail**: The entire Telegram processing logic (dedup, fast-path, boot message, workflow start) is wrapped in an outer try/catch at lines 92 and 206-210. If `reconcileStaleRunningStatus()` throws (unlikely but possible on store failure), the error is caught, logged via `logError`, and the route returns 200 — meaning Telegram will not redeliver. The inner workflow-start catch correctly returns 500, but errors in the dedup or fast-path sections could be swallowed.
- **Severity**: P2 (edge case reliability)
- **Recommended fix**: Narrow the outer try/catch or ensure it returns 500 for errors that indicate the message was never handled.

### WARN — WhatsApp outer try/catch swallows errors silently

- **Evidence**: `src/app/api/channels/whatsapp/webhook/route.ts:128-261`
- **Detail**: Same pattern as Telegram. Outer try/catch at lines 128 and 257-261 catches and logs but returns 200 for any uncaught error in the dedup/fast-path/boot-message sections.
- **Severity**: P2 (edge case reliability)
- **Recommended fix**: Same as Telegram — narrow scope or return 500 for unhandled errors.

### PASS — Bot message filtering (Slack)

- **Evidence**: `src/app/api/channels/slack/webhook/route.ts:212-221`
- **Detail**: Slack route explicitly skips messages with `botId` to prevent feedback loops.

## Test Coverage Assessment

### Slack (`route.test.ts`) — Good

| Scenario | Covered |
|---|---|
| Missing signature headers (401) | Yes |
| Invalid signature (401) | Yes |
| No config (404) | Yes |
| URL verification | Yes |
| Happy path enqueue | Yes |
| Dedup rejection | Yes |
| Fast-path non-2xx (returns 200, no workflow) | Yes |
| Workflow start failure (500 + dedup release) | Yes |
| Fast-path network failure (reconcile + wake) | **No** |
| Bot message skip | **No** |

### Telegram (`route.test.ts`) — Good

| Scenario | Covered |
|---|---|
| Missing secret (401) | Yes |
| Wrong secret (401) | Yes |
| No config (404) | Yes |
| Happy path enqueue | Yes |
| receivedAtMs propagation | Yes |
| Dedup rejection | Yes |
| Fast-path non-2xx (returns 200, no workflow) | Yes |
| Fast-path network failure (reconcile + wake) | Yes |
| Workflow start failure (500 + dedup release) | Yes |

### WhatsApp (`route.test.ts`) — Good

| Scenario | Covered |
|---|---|
| GET verification challenge | Yes |
| Invalid signature (401) | Yes |
| No config (404) | Yes |
| Happy path enqueue | Yes |
| Dedup rejection | Yes |
| Fast-path non-2xx (returns 200, no workflow) | Yes |
| Fast-path network failure (reconcile + wake) | Yes |
| Workflow start failure (500 + dedup release) | Yes |

### Discord — **No test file found**

- **Severity**: P2
- Discord webhook route has no regression tests. Signature validation, dedup, ping response (type 1), workflow start, and workflow failure are all untested.

## Issues Summary

| ID | Severity | Channel | Issue | Status |
|---|---|---|---|---|
| CW-1 | P2 | Slack | Fast-path leading comment contradicts actual behavior | **Fixed** |
| CW-2 | P2 | WhatsApp | Fast-path leading comment contradicts actual behavior | **Fixed** |
| CW-3 | P2 | Telegram | Outer try/catch swallows errors, returns 200 on unhandled failure | Open |
| CW-4 | P2 | WhatsApp | Outer try/catch swallows errors, returns 200 on unhandled failure | Open |
| CW-5 | P2 | Discord | No test coverage at all | Open |
| CW-6 | P3 | Slack | Missing test for fast-path network failure (reconcile path) | Open |
| CW-7 | P3 | Discord | No fast-path forwarding (all interactions go through workflow) | Open |

## Recommended Fixes (ranked by severity)

### P2 — Fix before launch (low effort, high clarity)

1. **CW-1, CW-2**: ~~Update leading block comments in Slack and WhatsApp to match the Telegram wording.~~ **Done** — comments aligned in both files.

2. **CW-3, CW-4**: Narrow the outer try/catch in Telegram (`route.ts:92-211`) and WhatsApp (`route.ts:128-261`). If the error occurs before the workflow start (e.g., during dedup lock acquisition or reconciliation), the message was never handled and should return 500 so the provider can redeliver. The workflow-start catch already handles its own errors correctly.

3. **CW-5**: Add a basic Discord webhook test file covering signature validation, ping response, happy path workflow start, and workflow start failure with dedup release.

### P3 — Post-launch improvements

4. **CW-6**: Add a Slack test for fast-path network failure (fetch throws) to verify reconciliation and workflow fallback, matching the existing Telegram and WhatsApp coverage.

5. **CW-7**: Consider adding a fast-path to Discord when the sandbox is running. Low priority given experimental status.

## Acknowledgement Invariant Summary

The actual runtime behavior across all channels with fast paths is **uniform and correct**:

| Scenario | Slack | Telegram | WhatsApp | Result |
|---|---|---|---|---|
| Fast-path 2xx | Return 200 | Return 200 | Return 200 | Native handler processed |
| Fast-path non-2xx | Return 200 | Return 200 | Return 200 | Native handler received payload |
| Fast-path fetch throws | Reconcile + workflow | Reconcile + workflow | Reconcile + workflow | Native handler never got it |
| Sandbox not running | Boot msg + workflow | Boot msg + workflow | Boot msg + workflow | Wake path |
| Workflow start fails | Release dedup + 500 | Release dedup + 500 | Release dedup + 500 | Provider can redeliver |

The invariant is: **only acknowledge the webhook when the native handler received the payload OR the workflow was successfully started**. The one exception is the outer try/catch in Telegram and WhatsApp that can swallow pre-workflow errors (CW-3, CW-4).

## Release Recommendation

**Prelaunch-warning**: No launch-blocking issues found. The webhook reliability subsystem is well-structured with consistent dedup, signature validation, fast-path forwarding, and workflow fallback across all channels. The P2 items (misleading comments, outer catch scope, missing Discord tests) should be addressed before or shortly after launch but do not risk message loss in normal operation. The outer try/catch issue (CW-3, CW-4) is the highest-priority fix as it could theoretically swallow a message on an unlikely store failure during dedup acquisition.
