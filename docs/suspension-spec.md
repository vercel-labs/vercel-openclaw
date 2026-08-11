# Suspension and lifecycle spec (v1 design)

How the host app manages the OpenClaw gateway's sandbox lifecycle: when it sleeps, how it
shuts down gracefully, and what wakes it. Designed 2026-08-10 against the cooperative host
suspension API landing in OpenClaw 2026.7.2 (upstream PR openclaw/openclaw#103618: RPC triad
`gateway.suspend.prepare` / `gateway.suspend.status` / `gateway.suspend.resume`, ~2-minute
ready lease with auto-resume on expiry).

Roles: the **host** is this repo's Vercel app (always on, owns the power button). The
**gateway** is OpenClaw's server process inside the sandbox (exposes the suspend API, does
the packing). The host always calls; the gateway always answers.

## Sandbox configuration

```
Sandbox.getOrCreate({
  name: 'openclaw',          // stable identity: resume finds the same sandbox + snapshot
  image: 'openclaw-foundation/openclaw/openclaw:latest',
  persistent: true,          // default: snapshot disk on stop, restore on resume
  timeout: 75 * 60 * 1000,   // 75 min platform backstop, 15 min behind the graceful path
  ports: [3000],             // gateway; add admin RPC / Telegram ports per contract answers
})
```

## Activity definition

`lastActivityAt` (host storage), reset by every host-visible event:

- a webhook the host forwards (any channel)
- a UI request the host proxies (WebChat/Control UI route through the host precisely so
  activity is visible)
- any sandbox wake (message, cron, manual)

Deliberately NOT counted: the gateway's own outbound work (LLM calls mid-task). The idle
timer only initiates; the prepare handshake is the correctness gate that protects running
work.

## Suspend paths

**Idle (primary):** host cron evaluates every 5 min. When `now - lastActivityAt >= 60 min`:

1. `gateway.suspend.prepare` with a host-generated `requestId`
2. `{status:"ready", suspensionId, expiresAtMs}` -> immediately `sandbox.stop()` (the lease
   is exactly 2 min; never wait out a deadline). Re-calling prepare with the same
   `requestId` renews the lease if the stop needs more runway.
3. `{status:"busy", reason, retryAfterMs, blockers}` -> the gateway refused (it does NOT
   drain; prepare is an idle-fence acquire, not a shutdown request). Nothing is held, no
   resume needed: treat busy as activity, log `blockers`, re-arm idle timer +15 min.
4. `gateway.suspend.resume(suspensionId)` is only for canceling a HELD lease (host changed
   its mind after ready).

**Session ceiling:** on every forwarded message, `sandbox.extendTimeout()` back to 75 min.
The ceiling only bites at the platform's hard maximum session length: 24 hours on Pro and
Enterprise, 45 minutes on Hobby (vercel.com/docs/sandbox/pricing, retrieved 2026-08-10). At
`expiresAt - 5 min` when no further extension is possible:

1. `prepare` -> ready -> `stop()` immediately
2. busy -> retry prepare every 20s (`retryAfterMs`); still busy at T-60s -> `stop()` anyway
   (forced). Note prepare never waits for a long task, so a busy agent at the ceiling always
   ends in a forced stop; what an interrupted run does on restart is contract question 5.
3. if the agent was mid-work: resume right away into a fresh session restored from the
   snapshot; host restarts the gateway (`onResume`), which reads its checkpointed state from
   disk. Fresh session, fresh 24h meter, same disk.

Design requirement: a mid-flight agent task MUST auto-continue after an immediate resume.
Rationale: the idle path can never stop mid-flight work (prepare gates it), so the only
mid-flight stop is the ceiling roll-over, where the gap between stop and resume is seconds.
The gateway seeing a checkpoint written moments ago should pick the task back up without a
nudge. Whether 2026.7.2 behaves this way is contract question 5.

**Backstop:** if the host misses everything, the platform kills the session at `expiresAt`
(75 min). Ungraceful but disk-safe: server-side timeout still snapshots (verified live
2026-08-06). Graceful shutdown only additionally saves what lived in memory.

## Wake paths

1. **Message:** webhooks terminate at the host, never at the sandbox (a sleeping VM is
   unreachable; the URL registered with Slack/Telegram is the host's). Host resumes the
   sandbox if stopped, restarts the gateway, forwards the original payload to the gateway's
   native handler through the exposed port.
2. **Cron (in scope for v1):** during shutdown, after ready and before `stop()`, host asks
   the gateway for its next scheduled job time and stores `nextWakeAt`; the host scheduler
   resumes the sandbox ~1 min before. Dependency: a next-cron-time query on the admin RPC
   (cron projection was drafted upstream in July; whether 2026.7.2 ships it is a contract
   question). Fallback if absent: read the gateway's cron config from disk via `runCommand`
   before stopping.

## Force-stop is acceptable by design

A forced or platform stop equals losing only unpersisted memory state; the snapshot is taken
either way. Policy: maximize the chance of graceful, never risk the VM outliving its window
for it.

## Contract facts, VERIFIED 2026-08-10 from the shipped beta

Source: read from `ghcr.io/openclaw/openclaw:2026.7.2-beta.7` ("OpenClaw 2026.7.2-beta.7
(dabe191)"), files `/app/dist/suspend-*.js`, `/app/dist/gateway-suspend-coordinator-*.js`,
`/app/docs/gateway/protocol.md` inside the image. Beta semantics; stability to be confirmed
with the OpenClaw maintainers (Patrick Erichsen).

- Methods: `gateway.suspend.prepare` / `gateway.suspend.status` / `gateway.suspend.resume`,
  served as gateway methods over the gateway WebSocket (default port 3000). Probe/CLI:
  `openclaw gateway call <method> --url ws://... --token ...`. An `admin-http-rpc` extension
  also ships (`/app/dist/extensions/admin-http-rpc/`), not yet probed.
- Auth: gateway auth modes `none|token|password|trusted-proxy`; token defaults from
  `OPENCLAW_GATEWAY_TOKEN` env. The host holds that token.
- `prepare({requestId})` is an idle-fence acquire, NOT a drain request. Results:
  `ready` (`suspensionId`, `expiresAtMs`, `activeCount`, `blockers`) only when tracked work
  is idle; while held it pauses cron scheduling and fences new work admission. `busy`
  (`reason: "active-work" | "gateway-draining"`, `retryAfterMs: 20000`, `blockers`) when
  work is active; nothing is held. Error `UNAVAILABLE` conflict when a different
  `requestId` holds the lease; `recovering` (`retryAfterMs: 1000`) during scheduler
  recovery. Same-`requestId` re-prepare renews the lease.
- Lease TTL: exactly 2 minutes (`GATEWAY_SUSPEND_TTL_MS = 2 * 60_000`); on expiry the
  gateway auto-resumes scheduling and reopens admission.
- Tracked work = active cron runs, active chat runs, queued turns, pending terminal
  persistence, live terminal sessions.
- Cron wake: `cron.list` / `cron.status` / `cron.get` exist as gateway methods; the host
  computes `nextWakeAt` from job schedules. v1 dependency satisfied.
- Port routing: the exposed-port URL reaches loopback-bound listeners (observed 2026-08-11:
  `python3 -m http.server 3000 --bind 127.0.0.1` answered HTTP 200 via `sandbox.domain(3000)`).
  The gateway's default loopback bind therefore works with host forwarding. Exposed URLs are
  publicly routable, so gateway token auth stays mandatory.

## Open contract questions (Patrick / 2026.7.2)

1. Is the beta.7 contract above frozen for 2026.7.2 stable?
2. What happens to an interrupted (force-stopped) chat run when the gateway restarts after
   resume: retried, resumed, or dropped? (Our ceiling path depends on this; a busy agent at
   the 24h ceiling always ends in a forced stop, since prepare never drains.)
3. `admin-http-rpc` extension: intended for hosts like us, or is the gateway WebSocket the
   recommended host integration path?
4. Beta bug to report: `openclaw gateway run --dev --reset --allow-unconfigured` in a fresh
   container/sandbox fails with "Config write would drop agent roster entries without an
   explicit deletion: main" (observed in Vercel Sandbox and local docker, 2026-08-10). What
   is the supported non-interactive bootstrap for a fresh gateway?

## Explicitly deferred (not v1)

- Multi-sandbox / multi-agent routing
- Channel transports beyond the first channel + WebChat
- Credential brokering via network-policy header injection (old wrapper pattern; evaluate
  after the suspend loop works)
