## Local Telegram wake findings

Date: 2026-04-13

### Goal

Reproduce and isolate the latency between sandbox wake and Telegram reply delivery, using the real npm-installed OpenClaw runtime instead of a vendored build.

### Strongest local reproduction so far

The best local reproduction artifact is:

- `.artifacts/telegram-wake-local/2026-04-13T22-52-59-395Z-local-vgrok-mnxsgccj/summary.json`
- `.artifacts/telegram-wake-local/2026-04-13T22-52-59-395Z-local-vgrok-mnxsgccj/next.log`
- `.artifacts/telegram-wake-local/2026-04-13T22-52-59-395Z-local-vgrok-mnxsgccj/vgrok.log`

This run used the real local harness and `openclaw@2026.4.11`.

Observed behavior:

- Telegram webhook was accepted almost immediately.
- The workflow started and restored the sandbox.
- Restore itself was not the dominant cost.
- After restore, the workflow retried forwarding to the native Telegram handler 20 times.
- The forward path ultimately failed with `504`.
- The public Telegram probe kept seeing `200`, but never reached the expected ready state.
- The local probe failed with `fetch failed`.

Important timing from the wake summary in that run:

- `restoreTotalMs`: about `10456`
- `sandboxCreateMs`: `303`
- `assetSyncMs`: `454`
- `startupScriptMs`: `9354`
- `localReadyMs`: `9354`
- `postLocalReadyBlockingMs`: `1102`
- `forwardMs`: about `67938`
- `retryingForwardTotalMs`: about `39687`
- `endToEndMs`: about `89361`

Interpretation:

- The main problem is not "sandbox takes too long to restore".
- The main problem is "Telegram native handling is still not actually ready after restore".
- The route is reachable, but it is not draining the message.

### What this means

The current bad state on `2026.4.11` looks like:

1. Webhook ingress is healthy.
2. Wake workflow is healthy enough to restore the sandbox.
3. Post-restore Telegram readiness is unhealthy.
4. Retry logic burns tens of seconds poking a handler that responds but is not functionally ready.

### Harness work completed

The local harness in `scripts/test-telegram-wake-local.mjs` was improved to make local repro more reliable:

- Persists artifacts even on failure.
- Writes per-run artifact directories under `.artifacts/telegram-wake-local/...`.
- Captures `next.log`, `vgrok.log`, wake stdout/stderr, and `summary.json`.
- Avoids stale port reuse by picking a free port.
- Waits for local app status to reach `running` after ensure.
- Retries stop requests across transient lifecycle lock contention.
- Treats request-scoped Telegram logs as a first-class source of truth.

Important fix:

- The harness previously waited too long on workflow JSON files alone.
- It now classifies success/failure from request logs so the wrapper itself is less likely to mask the real Telegram failure.

### Most likely regression surface in OpenClaw

The package diff between `openclaw@2026.3.28` and `openclaw@2026.4.11` points to new shared approval bootstrap/runtime assembly in `2026.4.11`.

High-signal files:

- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/server.impl-CsRRyd9F.js`
- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/approval-handler-runtime-Cbz4KCvq.js`
- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/approval-handler-adapter-runtime-CKOa4Onj.js`
- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/approval-native-QFc2pohp.js`
- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/approval-handler.runtime-CNfaJ3I6.js`
- `.artifacts/openclaw-npm-diff/openclaw-2026.4.11/package/dist/exec-approvals-BmQu-wgv.js`

Relevant changelog clue from `2026.4.11`:

- "Approvals/runtime: move native approval lifecycle assembly into shared core bootstrap/runtime seams driven by channel capabilities and runtime contexts"

What stands out:

- `2026.4.11` introduces shared `approval.native` bootstrap in core server startup.
- Telegram native approval capability is part of the runtime surface even when enablement is decided later by config.
- That means startup ordering or runtime context registration can still affect Telegram startup even if `execApprovals.enabled = false`.

This is consistent with the observed failure:

- handler path reachable,
- not actually ready to process Telegram traffic after restore.

### Current hypothesis

The regression is likely in the `2026.4.11` startup path that assembles shared native approval/runtime handling before Telegram is fully usable.

The most likely shape of the bug is one of:

- a blocking startup step,
- a late runtime-context registration,
- a handler-ready signal that fires before Telegram native handling is actually ready,
- or a retry/reconcile path that keeps the public route returning a generic `200` before the true Telegram handler is mounted.

### Current app-side mitigations already in place

In our app config:

- Telegram and Slack set `execApprovals: { enabled: false }`
- There is already a comment noting a blocking startup issue related to approval bootstrap

There is also an app-side fix in the workflow:

- only classify `swallowed-by-base-server` when the transport is `public`

That fix is real, but it is not enough to solve the deeper readiness problem.

### What still needs to happen

1. Compare local behavior on nearby OpenClaw versions to narrow the exact introduction point.
2. Keep adding sandbox-side readiness instrumentation after restore.
3. Patch around the suspicious approval bootstrap/runtime path and rerun the local harness.
4. Confirm parity with the older package behavior, not just a partial latency reduction.
