# Sandbox Lifecycle and Restore

The project uses `@vercel/sandbox@^2.0.0-beta` with persistent sandboxes. Sandboxes auto-snapshot on stop and auto-resume on get. There is no manual `snapshot()` call.

## Lifecycle states

The sandbox moves through these states:

| State | Meaning |
| ----- | ------- |
| `uninitialized` | No sandbox has been created yet |
| `creating` | A sandbox is being created (fresh or resumed from stop) and bootstrapped |
| `setup` | Bootstrap is writing config files and installing OpenClaw |
| `booting` | The gateway is starting up |
| `running` | The sandbox is healthy and serving requests |
| `stopped` | The sandbox was stopped (v2 auto-snapshots on stop, preserves sandboxId for resume) |
| `error` | Something went wrong; may be recoverable |

## What "ensure running" does

Calling ensure does not always mean "create from scratch." The app picks the cheapest path:

- If no sandbox exists yet, it creates one from scratch with `{ name: "oc-xxx", persistent: true }` (full bootstrap).
- If the sandbox is stopped, it resumes by calling `Sandbox.create()` with the same name. The v2 SDK handles 400/409 name-conflict by falling back to `get()` for auto-resume.
- If the sandbox is already running and healthy, it does nothing.

The work is scheduled with `after()` so the API responds immediately with a waiting state. The browser polls until the sandbox is ready.

## What stop and snapshot mean today

Today, stopping and snapshotting both use the same flow: stop the sandbox. The v2 SDK automatically takes a snapshot on stop. There is no separate manual snapshot step. If that changes in the future, this page and the API reference should be updated together.

The stop path parks metadata in `snapshotting` before calling `sandbox.stop({ blocking: false })`. That ordering closes the race where a concurrent heartbeat still sees `running`, calls the SDK default get path, and resumes the sandbox while the stop request is being accepted. While metadata is `snapshotting`, status reconciliation must inspect the sandbox with `Sandbox.get({ resume: false })`. The SDK resumes stopped/snapshotting sandboxes by default, so a status poll that omits `resume: false` can restart the sandbox it is trying to observe and make the UI wait until the stale guardrail fires.

### Measuring snapshot duration

Unit tests use `FakeSandboxHandle`, so they only prove that the host parks metadata in `snapshotting`, polls, and transitions after the SDK reports `stopped`. They do not measure Vercel's real snapshot duration.

Use `scripts/bench-stop-cycle.mjs` for manual ops measurements against a deployed app. Run enough completed cycles for each workload, and prefer `--sdk-poll` so the benchmark records the platform status separately from the app's 5-minute stale guardrail.

For local linked-project measurements that bypass the app entirely, use `scripts/bench-sdk-snapshot.mjs`. It creates disposable persistent sandboxes through `@vercel/sandbox`, can download the same bundle artifacts used by `vclaw create`, and measures the SDK stop result directly.

Example:

```bash
ADMIN_SECRET=... node scripts/bench-stop-cycle.mjs \
  --base-url https://your-app.vercel.app \
  --cycles=20 \
  --workload=home-small \
  --sdk-poll
```

The useful fields are `platformSnapshottingDurationMs` and `platformStopToStoppedMs`. App-only fields can be lower-bounded or guardrail-capped if the host force-reconciles before the platform actually leaves `snapshotting`.

If app status remains `snapshotting` while `--sdk-poll` reports platform `running`, treat that as a lifecycle bug or an accidental SDK resume, not as measured snapshot duration.

Local bundle example:

```bash
node --env-file=.env.local scripts/bench-sdk-snapshot.mjs \
  --cycles=1 \
  --workload=bundle \
  --bundle-url https://duiylqr0ujvwgwtm.public.blob.vercel-storage.com/openclaw.bundle.mjs \
  --start-bundle \
  --bundle-run-ms=30000
```

## Resume fast path

Resuming a persistent sandbox from stop is faster than creating from scratch (~10s vs full bootstrap) because most of the sandbox state is preserved automatically by v2. The resume path splits files into two groups to avoid redundant work.

### Static resume assets

These are files that only change when the app version changes: the startup script, force-pair script, skill markdown, skill scripts, and the built-in image-gen override.

Static assets are only rewritten when the restore asset hash (`assetSha256`) has changed since the last resume. If the app version has not changed, these uploads are skipped entirely.

### Dynamic resume assets

These are files that change with runtime configuration, primarily `openclaw.json`. Dynamic files are always checked against the current desired state using a config hash comparison.

### Credential brokering

The AI Gateway API key is not written as a file or env var inside the sandbox. Instead, it is injected at the firewall layer via network policy `transform` rules that add an `Authorization: Bearer <token>` header to outbound requests to `ai-gateway.vercel.sh`. This means:

- Token refresh updates the network policy — no file writes or gateway restarts
- The sandbox has `OPENAI_BASE_URL` set so code knows where to call, but the auth header is injected transparently
- Prompt injection attacks cannot exfiltrate the credential because it never exists inside the VM

### Readiness checks

Resume readiness is checked in two stages:

1. **Local-first readiness** — `curl http://localhost:3000/` inside the sandbox checks whether the gateway process started (accepts any HTTP response, not just 200 with a specific marker).
2. **Public readiness** — a fetch through the proxied app route checks whether the proxy, DNS, and public networking all work.

This separation makes it easy to tell whether a failure is inside the sandbox or in the path between the sandbox and the outside world.

## Cron wake behavior

OpenClaw has a built-in cron scheduler that persists jobs to `~/.openclaw/cron/jobs.json`. When the sandbox sleeps, the scheduler dies. The app bridges that gap:

1. **Before stop:** the app reads `jobs.json` from the sandbox, extracts the earliest next run time, and saves both the wake time and the full jobs payload to the durable store.
2. **On heartbeat:** the same data is refreshed in the store so it survives even if the sandbox times out naturally without an explicit stop.
3. **On each watchdog run:** the watchdog cron (`/api/cron/watchdog`) checks if the saved wake time has passed. If it has and the sandbox is stopped, the watchdog resumes the sandbox. OpenClaw's native cron takes over from there. The default schedule is daily (Hobby-compatible); Pro users can increase up to every minute in `vercel.json` for more timely auto-wake.
4. **After resume:** if `jobs.json` is empty on the resumed sandbox but the store has a copy, the app writes the stored jobs back and restarts the gateway so the cron module reloads them.
5. **After wake:** the wake key is cleared only when the cron restore outcome is confirmed successful. If resume fails, the key is retained so the next watchdog run can retry.

The watchdog never runs chat completions, delivers messages, or interacts with channels. It only wakes the sandbox.

## Resume-prepared state

A sandbox can be "running" right now but still not be a good future resume target. The app tracks this separately. With v2 persistent sandboxes, the auto-snapshot is always available, but its config may not match the current deployment.

### Statuses

| Status | Meaning |
| ------ | ------- |
| `unknown` | No information yet |
| `dirty` | The persistent sandbox state does not match the desired config |
| `preparing` | A prepare cycle is in progress |
| `ready` | The sandbox is a verified reusable resume target |
| `failed` | Preparation was attempted and failed |

### Reasons

Common reasons for the current status:

- `snapshot-missing` — there is no saved state to evaluate
- `dynamic-config-changed` — runtime config has drifted since the sandbox was last stopped
- `static-assets-changed` — app version changed and static assets no longer match
- `deployment-changed` — the deployment itself has changed
- `prepare-failed` — a prepare attempt did not succeed
- `prepared` — the sandbox state matches desired config and is verified

### Example metadata

```json
{
  "restorePreparedStatus": "ready",
  "restorePreparedReason": "prepared",
  "snapshotDynamicConfigHash": "abc123",
  "runtimeDynamicConfigHash": "abc123",
  "snapshotAssetSha256": "def456",
  "runtimeAssetSha256": "def456"
}
```

### Why this matters

Launch verification and the watchdog both use resume-prepared state to decide whether the persistent sandbox is safe to resume. A stale sandbox that would boot with the wrong config is worse than a fresh create, because the sandbox would come up in a misconfigured state that is hard to diagnose.

## Where to read next

- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how the app proves config and runtime readiness
- [API Reference](api-reference.md) — the exact request and response shapes for lifecycle endpoints
