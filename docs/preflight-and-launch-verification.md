# Preflight and Launch Verification

## What preflight proves

Preflight is a config-readiness check. It runs without touching the sandbox and answers questions like:

- Can the app resolve a canonical public origin?
- Is the durable store (Redis) configured?
- Is AI Gateway auth available (OIDC or API key)?
- Is auth configuration complete?
- Is cron authentication configured?
- Are channel prerequisites met (webhook URLs resolvable, store available)?

Preflight is a config-readiness check. It does not prove the sandbox can complete a real channel delivery. It only proves the deployment is configured correctly.

## What launch verification proves

Launch verification is the runtime check. It always starts with preflight, then runs one of two runtime paths.

- **Safe mode** proves the deployment can receive a queue callback, boot or resume the sandbox, and get a real completion from the gateway.
- **Destructive mode** proves everything in safe mode, then proves the stop-and-wake path and seals a reusable restore target.

## Safe mode vs destructive mode

### Safe mode

Safe mode runs these phases:

- `preflight`
- `queuePing`
- `ensureRunning`
- `chatCompletions`

Safe mode is **not** a config-only check. It touches the sandbox and runs a real completion request.

Safe mode does **not** run these phases:

- `wakeFromSleep`
- `restorePrepared`

That means safe mode can prove "the deployment works right now," but it does not prove wake-from-sleep or that the current resume target is ready to reuse. Safe mode does not make `channelReadiness.ready` true.

### Destructive mode

Destructive mode runs every safe-mode phase, then adds:

- `wakeFromSleep`
- `restorePrepared`

This is the only mode that proves the full channel-delivery path end to end. It is also the only mode that can make `channelReadiness.ready` true.

## Preflight-only is not safe mode

`GET /api/admin/preflight` and automation flags such as `--preflight-only` are config-only checks. They never touch the sandbox.

Safe mode is stronger than preflight-only because it still runs `ensureRunning` (which creates or resumes the sandbox) and `chatCompletions`.

## Launch verification phases

| Phase | Runs in safe mode | Runs in destructive mode | What it proves |
| ----- | ----------------- | ------------------------ | -------------- |
| `preflight` | yes | yes | Config readiness — deployment requirements are met |
| `queuePing` | yes | yes | Queue delivery loopback works |
| `ensureRunning` | yes | yes | The sandbox can start from scratch or resume and become ready |
| `chatCompletions` | yes | yes | The gateway can answer a real completions request |
| `wakeFromSleep` | no | yes | The stop-and-wake path works |
| `restorePrepared` | no | yes | A fresh reusable resume target is sealed and verified |

## Example safe mode result

```json
{
  "ok": true,
  "mode": "safe",
  "phases": [
    { "id": "preflight", "status": "pass" },
    { "id": "queuePing", "status": "pass" },
    { "id": "ensureRunning", "status": "pass" },
    { "id": "chatCompletions", "status": "pass" },
    { "id": "wakeFromSleep", "status": "skip" },
    { "id": "restorePrepared", "status": "skip" }
  ]
}
```

## Fields to inspect on failure

When launch verification reports `ok: false`, these fields explain why:

- `diagnostics.failingCheckIds` — which preflight checks failed
- `diagnostics.requiredActionIds` — which operator actions are blocking
- `diagnostics.failingChannelIds` — which channels have unresolved prerequisites
- `runtime.dynamicConfigVerified` — whether the running sandbox config matches the desired state
- `runtime.dynamicConfigReason` — `hash-match`, `hash-miss`, or `no-snapshot-hash`
- `sandboxHealth.configReconciled` — whether stale config was successfully fixed
- `sandboxHealth.configReconcileReason` — what happened during reconciliation
- `runtime.restorePreparedStatus` — whether the resume target is reusable
- `runtime.restorePreparedReason` — why the resume target is in its current state

## Important nuances

**`ok: true` means more than "the sandbox booted once."** The payload can still be unhealthy when:

- Dynamic config has drifted since the last restore (`dynamicConfigVerified: false`)
- The resume target is not reusable (`restorePreparedStatus` is not `ready`)
- Config reconciliation failed after an otherwise successful boot

**`ok: false` is authoritative.** Even when individual phases look healthy, treat `ok: false` as a real problem. Stale dynamic config that could not be reconciled is a hard failure.

## Channel readiness

`channelReadiness` is a persisted summary of the current deployment's launch verification result. It is separate from preflight channel checks.

- **Preflight channel checks** tell you whether a channel *can* be connected (webhook URL resolvable, store available, AI Gateway auth present).
- **Channel readiness** tells you whether the full pipeline *has been verified* for this deployment (sandbox boots, completions work, wake-from-sleep works).

`channelReadiness.ready` is only `true` after destructive launch verification passes every phase for the current deployment. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

Run destructive launch verification before connecting any channel.

## Example launch verification result

```json
{
  "ok": true,
  "mode": "destructive",
  "phases": [
    { "id": "preflight", "status": "pass" },
    { "id": "queuePing", "status": "pass" },
    { "id": "ensureRunning", "status": "pass" },
    { "id": "chatCompletions", "status": "pass" },
    { "id": "wakeFromSleep", "status": "pass" },
    { "id": "restorePrepared", "status": "pass" }
  ],
  "runtime": {
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match",
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared"
  }
}
```

## Where to read next

- [Channels and Webhooks](channels-and-webhooks.md) — how to connect channels after verification passes
- [API Reference](api-reference.md) — full request and response shapes for preflight and launch verification
- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — the lifecycle states and restore mechanics that launch verification exercises
