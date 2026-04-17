# API Reference

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

`channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` → `restorePrepared` path for the current deployment.

### Verification mode contract

There are three different verification surfaces and they are not interchangeable:

- `GET /api/admin/preflight` is config-only. It never touches the sandbox.
- `POST /api/admin/launch-verify` in **safe** mode runs `preflight`, `queuePing`, `ensureRunning`, and `chatCompletions`.
- `POST /api/admin/launch-verify` in **destructive** mode runs everything in safe mode, then adds `wakeFromSleep` and `restorePrepared`.

Automation should not treat safe mode as equivalent to `--preflight-only`. Safe mode is runtime verification. Preflight-only is not.

### Example safe-mode `POST /api/admin/launch-verify` response

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

### Example destructive `POST /api/admin/launch-verify` response

Destructive mode, all phases passing:

```json
{
  "ok": true,
  "mode": "destructive",
  "startedAt": "2026-03-24T08:00:00.000Z",
  "completedAt": "2026-03-24T08:01:10.000Z",
  "phases": [
    { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
    { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
    { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
    { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
    { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." },
    { "id": "restorePrepared", "status": "pass", "durationMs": 4500, "message": "Restore target sealed and verified." }
  ],
  "runtime": {
    "packageSpec": "openclaw@1.2.3",
    "installedVersion": "1.2.3",
    "drift": false,
    "expectedConfigHash": "abc123",
    "lastRestoreConfigHash": "abc123",
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match",
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "snapshotDynamicConfigHash": "abc123",
    "runtimeDynamicConfigHash": "abc123",
    "snapshotAssetSha256": "def456",
    "runtimeAssetSha256": "def456",
    "restoreAttestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "restorePlan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    }
  },
  "sandboxHealth": {
    "repaired": false,
    "configReconciled": true,
    "configReconcileReason": "already-fresh"
  },
  "diagnostics": {
    "blocking": false,
    "failingCheckIds": [],
    "requiredActionIds": [],
    "recommendedActionIds": [],
    "warningChannelIds": [],
    "failingChannelIds": [],
    "skipPhaseIds": []
  },
  "channelReadiness": {
    "deploymentId": "dpl_123",
    "ready": true,
    "verifiedAt": "2026-03-24T08:01:10.000Z",
    "mode": "destructive",
    "wakeFromSleepPassed": true,
    "failingPhaseId": null,
    "phases": [
      { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
      { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
      { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
      { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
      { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." },
      { "id": "restorePrepared", "status": "pass", "durationMs": 4500, "message": "Restore target sealed and verified." }
    ]
  }
}
```

`warningChannelIds` is deprecated — kept only for backward compatibility. New automation should consume `failingChannelIds`.

### Diagnostics compatibility note

`diagnostics.warningChannelIds` is a deprecated compatibility field. It carries the same channel IDs as `diagnostics.failingChannelIds`.

Use `diagnostics.failingChannelIds` in new automation. Only keep reading `warningChannelIds` if you still need backward compatibility with older consumers.

Example diagnostics block when preflight finds a blocking channel issue:

```json
{
  "diagnostics": {
    "blocking": true,
    "failingCheckIds": ["public-origin"],
    "requiredActionIds": ["configure-public-origin"],
    "recommendedActionIds": [],
    "warningChannelIds": ["telegram"],
    "failingChannelIds": ["telegram"],
    "skipPhaseIds": ["queuePing", "ensureRunning", "chatCompletions", "wakeFromSleep", "restorePrepared"]
  }
}
```

Both arrays always carry the same IDs. `warningChannelIds` exists solely so older automation that reads it keeps working.

### Launch verification fields that matter to automation

`POST /api/admin/launch-verify` exposes more than phase pass/fail:

- `runtime.expectedConfigHash` — hash derived from the current channel/runtime config.
- `runtime.lastRestoreConfigHash` — hash recorded during the most recent restore.
- `runtime.dynamicConfigVerified` — `true` when those hashes match, `false` when they drift, `null` when no restore hash is available yet.
- `runtime.dynamicConfigReason` — one of `hash-match`, `hash-miss`, or `no-snapshot-hash`.
- `sandboxHealth.repaired` — whether launch verification had to recover sandbox health.
- `sandboxHealth.configReconciled` — whether stale runtime config was reconciled successfully.
- `sandboxHealth.configReconcileReason` — one of `already-fresh`, `rewritten-and-restarted`, `rewrite-failed`, `restart-failed`, `sandbox-unavailable`, `error`, or `skipped`.

Automation should treat `payload.ok=false` as authoritative even when the main runtime phases look healthy, because stale dynamic config that could not be reconciled is a hard failure.

### Resume-readiness fields

Newer launch verification payloads expose resume-target readiness, not just "can the sandbox answer right now." These fields explain whether the current deployment has a reusable resume target and what action is still needed when it does not.

- `runtime.restorePreparedStatus` — `unknown`, `dirty`, `preparing`, `ready`, or `failed`
- `runtime.restorePreparedReason` — why the status is what it is (e.g. `prepared`, `dynamic-config-changed`, `snapshot-missing`)
- `runtime.snapshotDynamicConfigHash` — config hash baked into the current sandbox state
- `runtime.runtimeDynamicConfigHash` — config hash the running deployment wants
- `runtime.snapshotAssetSha256` — static asset hash in the sandbox state
- `runtime.runtimeAssetSha256` — static asset hash the running deployment expects
- `runtime.restoreAttestation` — machine-readable attestation of whether the sandbox is reusable for resume
- `runtime.restorePlan` — action plan for making the restore target ready

Example resume-readiness payload:

```json
{
  "runtime": {
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "restoreAttestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "restorePlan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    }
  }
}
```

See [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) for a plain-English explanation of resume-prepared state.

### Example blocked channel connect response

All channel credential-save routes (`PUT /api/channels/slack`, `PUT /api/channels/telegram`, `PUT /api/channels/discord`, `PUT /api/channels/whatsapp`) return HTTP 409 with the same envelope when deployment prerequisites are still failing.

Sample request outcome: `PUT /api/channels/telegram` while the deployment cannot resolve a public webhook origin.

```json
{
  "error": {
    "code": "CHANNEL_CONNECT_BLOCKED",
    "message": "Cannot connect telegram until deployment blockers are resolved."
  },
  "connectability": {
    "channel": "telegram",
    "mode": "webhook-proxied",
    "canConnect": false,
    "status": "fail",
    "webhookUrl": null,
    "issues": [
      {
        "id": "public-origin",
        "status": "fail",
        "message": "Could not resolve a canonical public origin for Telegram.",
        "remediation": "Deploy to Vercel so the app gets a public URL automatically, or set NEXT_PUBLIC_APP_URL to your custom domain.",
        "env": ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_DOMAIN", "BASE_DOMAIN"]
      }
    ]
  }
}
```

`connectability.webhookUrl` is an operator-visible display URL. It uses `buildPublicDisplayUrl()` internally and must never expose the deployment protection bypass secret. When the public origin cannot be resolved, the field is `null`.

### `GET /api/status`

The main operator summary endpoint. Returns everything about the current sandbox in one response: lifecycle state, gateway readiness, timeout data, firewall policy, public channel state, restore-target health, recent lifecycle metrics, setup progress, and the authenticated user.

This is the endpoint the admin UI polls. It is also the first thing most automation reads.

#### Cached vs live mode

- **`GET /api/status`** — returns cached gateway readiness from the last probe and an **estimated** timeout calculated from `lastKeepaliveAt` plus the configured sleep window. Cheap — does not touch the sandbox or Sandbox SDK.
- **`GET /api/status?health=1`** — performs a **live** gateway probe against the sandbox, reads the real timeout from the Sandbox SDK, and persists the probe result for future cached reads. Use this when you need ground truth rather than a best-guess estimate.

The `timeoutSource` field tells you which mode produced the response:

| `timeoutSource` | Meaning |
| --- | --- |
| `estimated` | Timeout was calculated from `lastKeepaliveAt` + `sleepAfterMs`. The sandbox may have already timed out. |
| `live` | Timeout was read from the Sandbox SDK during this request. This is the ground truth. |

When the cached path estimates that the timeout has already elapsed and the metadata still says `running`, the endpoint automatically reconciles: it queries the Sandbox SDK for the real status and updates the stored metadata before responding. This means even the cached path self-corrects stale "running" states.

#### Response areas

The response is a flat JSON object with several logical areas described below. Every field listed here comes directly from the route handler in `src/app/api/status/route.ts`.

##### Top-level identity and state

| Field | Type | Description |
| --- | --- | --- |
| `authMode` | `"admin-secret"` \| `"sign-in-with-vercel"` | Active auth mode for the deployment |
| `storeBackend` | `"redis"` \| `"memory"` | Which persistence backend is in use |
| `persistentStore` | boolean | `true` when `storeBackend` is not `"memory"` |
| `status` | string | Sandbox lifecycle state: `uninitialized`, `creating`, `setup`, `booting`, `running`, `stopped`, or `error` |
| `sandboxId` | string \| null | Current sandbox ID, if one exists. With v2, this is preserved across stop/resume cycles. |
| `snapshotId` | string \| null | Most recent snapshot ID (v2 auto-generates on stop). |
| `lastError` | string \| null | Human-readable error from the last failed lifecycle operation |

##### Gateway readiness

| Field | Type | Description |
| --- | --- | --- |
| `gatewayReady` | boolean | Shorthand derived from `gatewayStatus` — `true` only when `gatewayStatus` is `"ready"` |
| `gatewayStatus` | `"ready"` \| `"not-ready"` \| `"unknown"` | Result of the most recent gateway probe |
| `gatewayCheckedAt` | number \| null | Unix timestamp (ms) when gateway readiness was last probed. `null` when no probe has run for the current sandbox. |
| `gatewayUrl` | `"/gateway"` | Admin-facing path to the proxied OpenClaw UI |

In cached mode (`timeoutSource: "estimated"`), `gatewayStatus` reflects the last persisted probe — it is not re-checked. A cached `"ready"` means the gateway was ready at `gatewayCheckedAt`, not necessarily right now. `"unknown"` means no probe has ever run for this sandbox ID.

##### Timeout

| Field | Type | Description |
| --- | --- | --- |
| `lastKeepaliveAt` | number \| null | Last recorded sandbox access time (Unix ms). `null` before the first access. |
| `sleepAfterMs` | number | Configured sleep window in milliseconds |
| `heartbeatIntervalMs` | number | How often the UI sends heartbeat POSTs to keep the sandbox alive (derived from sleep window) |
| `timeoutRemainingMs` | number \| null | Milliseconds until sandbox sleep, or `null` when no timeout can be calculated |
| `timeoutSource` | `"estimated"` \| `"live"` | How the timeout was determined (see cached vs live mode above) |

##### Firewall

| Field | Type | Description |
| --- | --- | --- |
| `firewall.mode` | `"disabled"` \| `"learning"` \| `"enforcing"` | Current firewall mode |
| `firewall.learnedDomains` | string[] | Domains observed during learning mode |
| `firewall.wouldBlock` | string[] | Domains that **would** be blocked if the current learned policy were switched to enforcing mode |

`wouldBlock` is computed on-the-fly from `learnedDomains` and the current allowlist. It is useful for previewing what enforcing mode would do without switching.

##### Channels

| Field | Type | Description |
| --- | --- | --- |
| `channels` | object | Keyed by channel name (e.g. `"slack"`, `"telegram"`). Each channel object contains public operator-visible state. |
| `channels.<name>.configured` | boolean | Whether credentials are saved for this channel |
| `channels.<name>.webhookUrl` | string \| null | Operator-visible display URL (no bypass secret). `null` when the public origin cannot be resolved. |
| `channels.<name>.status` | string | Channel connection status |
| `channels.<name>.connectability` | object | Config-gate result for this channel — whether saving credentials would succeed right now |
| `channels.<name>.connectability.canConnect` | boolean | `true` when all deployment prerequisites are met for this channel |
| `channels.<name>.connectability.status` | `"pass"` \| `"fail"` \| `"warn"` | Aggregate connectability check result |
| `channels.<name>.connectability.issues` | array | Specific blockers or warnings preventing connection |

Connectability is a **config-time** check. It tells you whether deployment prerequisites (public origin, AI gateway, store) are in place. It does **not** tell you whether the channel has been proven to work end-to-end — that stronger guarantee comes from destructive launch verification.

##### Restore target

| Field | Type | Description |
| --- | --- | --- |
| `restoreTarget.restorePreparedStatus` | `"unknown"` \| `"dirty"` \| `"preparing"` \| `"ready"` \| `"failed"` | Current resume-target health |
| `restoreTarget.restorePreparedReason` | string \| null | Why the status is what it is (e.g. `"prepared"`, `"dynamic-config-changed"`, `"snapshot-missing"`) |
| `restoreTarget.restorePreparedAt` | number \| null | When the restore target was last prepared (Unix ms) |
| `restoreTarget.snapshotDynamicConfigHash` | string \| null | Config hash baked into the current sandbox state |
| `restoreTarget.runtimeDynamicConfigHash` | string \| null | Config hash the running deployment wants |
| `restoreTarget.snapshotAssetSha256` | string \| null | Static asset hash in the sandbox state |
| `restoreTarget.runtimeAssetSha256` | string \| null | Static asset hash the running deployment expects |
| `restoreTarget.attestation` | object | Machine-readable check of whether the sandbox is reusable for resume |
| `restoreTarget.attestation.reusable` | boolean | `true` when the sandbox can be resumed without resync |
| `restoreTarget.attestation.needsPrepare` | boolean | `true` when a prepare cycle is needed before the sandbox is reusable |
| `restoreTarget.attestation.reasons` | string[] | Why the sandbox is not reusable (empty when `reusable` is `true`) |
| `restoreTarget.plan` | object | Machine-readable next actions to make the restore target ready |
| `restoreTarget.plan.schemaVersion` | number | Always `1` |
| `restoreTarget.plan.status` | string | Plan status (e.g. `"ready"`, `"action-needed"`) |
| `restoreTarget.plan.blocking` | boolean | `true` when the plan has unresolved blocking actions |
| `restoreTarget.plan.reasons` | string[] | Human-readable reasons behind the plan |
| `restoreTarget.plan.actions` | array | Ordered list of actions to take |
| `restoreTarget.oracle` | object \| null | Background restore-prepare/oracle state |

Read `attestation.reusable` and `plan.blocking` together: if the attestation says the sandbox is reusable and the plan is not blocking, the next resume will be fast and clean. If `attestation.reusable` is `false`, check `attestation.reasons` for what changed.

##### Lifecycle

| Field | Type | Description |
| --- | --- | --- |
| `lifecycle.lastRestoreMetrics` | object \| null | Per-phase timings from the most recent resume. `null` when no resume has run. |
| `lifecycle.lastRestoreMetrics.totalMs` | number | Total resume duration in milliseconds |
| `lifecycle.lastRestoreMetrics.vcpus` | number | vCPU count used for the resume |
| `lifecycle.lastRestoreMetrics.dynamicConfigReason` | string | `"hash-match"`, `"hash-miss"`, or `"no-snapshot-hash"` |
| `lifecycle.lastRestoreMetrics.skippedDynamicConfigSync` | boolean | Whether dynamic config sync was skipped (hash matched) |
| `lifecycle.lastRestoreMetrics.dynamicConfigHash` | string \| null | Config hash recorded during the resume |
| `lifecycle.restoreHistory` | array | Up to 5 most recent resume timing records (same shape as `lastRestoreMetrics`) |
| `lifecycle.lastTokenRefreshAt` | number \| null | When the AI gateway token was last refreshed (Unix ms) |
| `lifecycle.lastTokenSource` | string \| null | Token source (e.g. `"oidc"`) |
| `lifecycle.lastTokenExpiresAt` | number \| null | When the current token expires (Unix ms) |
| `lifecycle.lastTokenRefreshError` | string \| null | Error from the last failed token refresh, or `null` |
| `lifecycle.consecutiveTokenRefreshFailures` | number | Count of consecutive token refresh failures. `0` when healthy. |
| `lifecycle.breakerOpenUntil` | number \| null | If the token refresh circuit breaker is open, the Unix ms timestamp when it will close. `null` when the breaker is closed. |

##### Setup progress

| Field | Type | Description |
| --- | --- | --- |
| `setupProgress` | object \| null | Non-null only when `status` is `creating`, `setup`, `booting`, or `error`. Contains live output from the sandbox bootstrap process. |
| `setupProgress.attemptId` | string | Lifecycle attempt ID this progress belongs to |
| `setupProgress.phase` | string | Current setup phase (e.g. `"installing-openclaw"`, `"starting-gateway"`) |
| `setupProgress.phaseLabel` | string | Human-readable label for the phase |
| `setupProgress.preview` | string \| null | Most recent line of output suitable for display |
| `setupProgress.lines` | array | Buffered output lines, each with `ts`, `stream`, and `text` |

When `status` is `running` or `stopped`, `setupProgress` is always `null` regardless of what is in the store.

##### User

| Field | Type | Description |
| --- | --- | --- |
| `user.sub` | string | User subject exposed by this route. Today this endpoint returns `"admin"` in both auth modes. |
| `user.name` | string | User display name exposed by this route. Today this endpoint returns `"Admin"`. |

#### Example: cached response (`GET /api/status`)

```json
{
  "authMode": "admin-secret",
  "storeBackend": "redis",
  "persistentStore": true,
  "status": "running",
  "sandboxId": "oc-prj-abc123",
  "snapshotId": null,
  "gatewayReady": true,
  "gatewayStatus": "ready",
  "gatewayCheckedAt": 1760000000000,
  "gatewayUrl": "/gateway",
  "lastError": null,
  "lastKeepaliveAt": 1759999950000,
  "sleepAfterMs": 1800000,
  "heartbeatIntervalMs": 300000,
  "timeoutRemainingMs": 1600000,
  "timeoutSource": "estimated",
  "firewall": {
    "mode": "learning",
    "learnedDomains": ["api.openai.com"],
    "wouldBlock": []
  },
  "channels": {
    "telegram": {
      "configured": true,
      "webhookUrl": "https://app.example.com/api/channels/telegram/webhook",
      "status": "connected",
      "connectability": {
        "channel": "telegram",
        "mode": "webhook-proxied",
        "canConnect": true,
        "status": "pass",
        "webhookUrl": "https://app.example.com/api/channels/telegram/webhook",
        "issues": []
      }
    }
  },
  "restoreTarget": {
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "restorePreparedAt": 1759999000000,
    "snapshotDynamicConfigHash": "abc123",
    "runtimeDynamicConfigHash": "abc123",
    "snapshotAssetSha256": "def456",
    "runtimeAssetSha256": "def456",
    "attestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "plan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    },
    "oracle": null
  },
  "lifecycle": {
    "lastRestoreMetrics": {
      "totalMs": 42350,
      "vcpus": 2,
      "dynamicConfigReason": "hash-match",
      "skippedDynamicConfigSync": true,
      "dynamicConfigHash": "abc123",
      "skippedStaticAssetSync": true,
      "assetSha256": "def456",
      "recordedAt": 1759998000000,
      "sandboxCreateMs": 12000,
      "tokenWriteMs": 150,
      "assetSyncMs": 0,
      "startupScriptMs": 800,
      "forcePairMs": 300,
      "firewallSyncMs": 200,
      "localReadyMs": 18000,
      "publicReadyMs": 10900
    },
    "restoreHistory": [],
    "lastTokenRefreshAt": 1759999900000,
    "lastTokenSource": "oidc",
    "lastTokenExpiresAt": 1760000200000,
    "lastTokenRefreshError": null,
    "consecutiveTokenRefreshFailures": 0,
    "breakerOpenUntil": null
  },
  "setupProgress": null,
  "user": { "sub": "admin", "name": "Admin" }
}
```

#### Example: live response (`GET /api/status?health=1`)

```json
{
  "authMode": "admin-secret",
  "storeBackend": "redis",
  "persistentStore": true,
  "status": "running",
  "sandboxId": "oc-prj-abc123",
  "snapshotId": null,
  "gatewayReady": false,
  "gatewayStatus": "not-ready",
  "gatewayCheckedAt": 1760000300000,
  "gatewayUrl": "/gateway",
  "lastError": null,
  "lastKeepaliveAt": 1759999950000,
  "sleepAfterMs": 1800000,
  "heartbeatIntervalMs": 300000,
  "timeoutRemainingMs": 905000,
  "timeoutSource": "live",
  "firewall": {
    "mode": "learning",
    "learnedDomains": [],
    "wouldBlock": []
  },
  "channels": {},
  "restoreTarget": {
    "restorePreparedStatus": "dirty",
    "restorePreparedReason": "dynamic-config-changed",
    "restorePreparedAt": null,
    "snapshotDynamicConfigHash": "old-hash",
    "runtimeDynamicConfigHash": "new-hash",
    "snapshotAssetSha256": "def456",
    "runtimeAssetSha256": "def456",
    "attestation": {
      "reusable": false,
      "needsPrepare": true,
      "reasons": ["snapshot-config-stale", "restore-target-dirty"]
    },
    "plan": {
      "schemaVersion": 1,
      "status": "action-needed",
      "blocking": true,
      "reasons": ["Snapshot config hash does not match runtime config"],
      "actions": [{ "id": "prepare-restore-target", "label": "Prepare restore target" }]
    },
    "oracle": null
  },
  "lifecycle": {
    "lastRestoreMetrics": {
      "totalMs": 42350,
      "dynamicConfigReason": "hash-miss"
    },
    "restoreHistory": [],
    "lastTokenRefreshAt": null,
    "lastTokenSource": null,
    "lastTokenExpiresAt": null,
    "lastTokenRefreshError": null,
    "consecutiveTokenRefreshFailures": 0,
    "breakerOpenUntil": null
  },
  "setupProgress": null,
  "user": { "sub": "admin", "name": "Admin" }
}
```

#### Interpretation guidance

These distinctions are easy to confuse and worth calling out explicitly:

**Gateway readiness vs sandbox lifecycle state.** `gatewayReady: false` does **not** automatically mean the sandbox is stopped. The sandbox can be `running` while the gateway probe fails — for example, during a gateway restart or if the OpenClaw process crashed inside a running sandbox. Conversely, `gatewayReady: true` from a cached probe only means the gateway was reachable at `gatewayCheckedAt`. To know right now, use `?health=1`.

**Channel connectability vs destructive launch verification.** `channels.<name>.connectability.canConnect: true` means the deployment prerequisites for saving channel credentials are met (public origin, AI gateway, store). It does **not** mean the channel has been proven to deliver messages end-to-end. That stronger guarantee requires destructive launch verification (`POST /api/admin/launch-verify` in destructive mode), which exercises the full wake → chat completions → channel round-trip path.

**Resume-target readiness vs simple reachability.** `restorePreparedStatus: "ready"` means the current sandbox state has been verified as a reusable resume target — its config hash and asset hash match the running deployment. This is a stronger statement than "the sandbox is reachable." A `"dirty"` resume target means the next resume will work but will need to resync config or assets, adding time. Check `attestation.reasons` for specifics.

See [Channels and Webhooks](channels-and-webhooks.md) for the connectability-vs-readiness distinction, and [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) for restore-target semantics.

### `POST /api/status`

Heartbeat endpoint. The admin UI calls this periodically to keep the sandbox alive. It touches the stored keepalive timestamp (`lastAccessedAt` in metadata, exposed as `lastKeepaliveAt` in `GET /api/status`), which extends the sandbox timeout window.

Use this when the UI only needs to keep the sandbox alive. Use `GET /api/status?health=1` when you need a live readiness probe and fresh timeout data.

Returns:

```json
{
  "ok": true,
  "status": "running"
}
```

`status` reflects the sandbox lifecycle state after the touch. If the sandbox is not running, the touch is a no-op and `status` reflects the current state.

## Structured output contracts

### `node scripts/verify.mjs`

- Emits JSON Lines to stdout.
- Human-readable child process output goes to stderr.
- Event names: `verify.start`, `verify.step.start`, `verify.step.finish`, `verify.summary`, `verify.config_error`, `verify.fatal`.

Example output:

```jsonl
{"event":"verify.start","timestamp":"2026-03-24T08:00:00.000Z","ok":true,"root":"/repo","steps":["contract","lint","test","typecheck","build"],"pathIncludesNodeModulesBin":true}
{"event":"verify.step.start","timestamp":"2026-03-24T08:00:00.100Z","step":"contract","command":"node scripts/check-verifier-contract.mjs"}
{"event":"verify.step.finish","timestamp":"2026-03-24T08:00:01.200Z","step":"contract","ok":true,"exitCode":0,"durationMs":1100,"signal":null}
{"event":"verify.summary","timestamp":"2026-03-24T08:00:42.000Z","ok":true,"results":[{"step":"contract","exitCode":0},{"step":"lint","exitCode":0},{"step":"test","exitCode":0},{"step":"typecheck","exitCode":0},{"step":"build","exitCode":0}]}
```

### `node scripts/check-deploy-readiness.mjs`

Primary remote readiness gate for deployed instances.

Exit codes: `0` = pass, `1` = contract-fail, `2` = bad-args, `3` = fetch-fail, `4` = bad-response.

Example usage:

```bash
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --mode destructive --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --auth-cookie "$SMOKE_AUTH_COOKIE" --preflight-only --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" --json-only
```

## Verification behavior that is easy to miss

- `node scripts/verify.mjs` runs `node scripts/check-queue-consumers.mjs` before the `test` step whenever `test` is included in `--steps`. Expect `verify.step.start` / `verify.step.finish` events for `queue-consumers`.
- `node scripts/check-deploy-readiness.mjs` regenerates `src/app/api/auth/protected-route-manifest.json` before calling `/api/admin/launch-verify` and includes `bootstrapExposure` in the JSON result. A stale manifest or any unauthenticated admin/firewall route is a contract failure.
- On Deployment Protection-enabled deployments, pass `--protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` so automation can reach the app.
