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
   ends in a forced stop; what an interrupted run does on restart is contract question 2.
3. if the agent was mid-work: resume right away into a fresh session restored from the
   snapshot; host restarts the gateway (`onResume`), which reads its checkpointed state from
   disk. Fresh session, fresh 24h meter, same disk.

Design requirement: a mid-flight agent task MUST auto-continue after an immediate resume.
Rationale: the idle path can never stop mid-flight work (prepare gates it), so the only
mid-flight stop is the ceiling roll-over, where the gap between stop and resume is seconds.
The gateway seeing a checkpoint written moments ago should pick the task back up without a
nudge. Whether 2026.7.2 behaves this way is contract question 2.

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

## Lifecycle LIVE-VALIDATED 2026-08-11 (host/scripts/e2e-lifecycle.ts, beta.7)

Two full sleep/wake cycles through the production host code against
`2026.7.2-beta.7` in a real sandbox:

- create/resume -> gateway boot -> health -> `prepare` -> `ready` -> `stop()` -> snapshot,
  twice. Ready shape matched the code-derived contract field for field. Independently
  reproduced same day by a second operator on a fresh sandbox name.
- Wake latency, measured then optimized (2026-08-12): ~10-11s end to end, both cold create and
  wake-from-snapshot (was 14-19s before the host's health loop was rebuilt: one in-VM 300ms
  port-waiter instead of host-side 5s polling, and the ~3s CLI protocol confirm skipped when
  this call spawned the gateway itself). Phase decomposition of a wake: platform resume
  including snapshot restore <1s; spawn round trip ~1.5s; OpenClaw gateway boot to port bind
  ~7s (config + db check + 13 plugins) — the dominant, upstream-owned chunk and a natural
  fast-boot conversation with the OpenClaw team. A freshly-woken gateway may report busy for
  its own startup work for ~10s; the idle cron's re-arm handles that by design.
- SDK semantics behavior-confirmed by probe (host/scripts/sdk-probe.ts): `extendTimeout(d)` is
  ADDITIVE (deadline moved by exactly d per call, anchored at session start), so the
  extend-by-shortfall pattern is required; and `onResume` fires DURING the first post-stop
  command (after the SDK's 410-retry), so that command executes ~0.3s after a detached gateway
  spawns and MUST be allowed to fail while the process binds (the health loop's 3-failure
  threshold). Footgun: `sandbox.timeout` stays at the configured value while `expiresAt`
  moves; only `expiresAt` reflects the live deadline.
- The gateway boots non-interactively with plain `gateway run --allow-unconfigured` (no
  `--dev`): the bootstrap bug in question 4 is DEV-MODE ONLY.
- Question 2 ANSWERED by observation: after an abrupt stop mid-work, the restarted gateway
  auto-continues the interrupted run (a recovery task titled "[System] Your previous turn was
  interrupted by a gateway restart... Continue from the existing transcript" appeared as an
  active blocker, and prepare correctly refused to suspend it). Our ceiling-path design
  requirement is shipped behavior.
- Live `blockers` are structured objects ({kind, count, message}, extended for tasks), not
  strings.
- CLI transport failures arrive as `{ok:false, error:{...}}` JSON on stdout; the host caller
  detects the envelope and throws rather than mistaking it for a result.
- Pre-suspension gateways (probed live against 2026.7.1): the wake path works unchanged (same
  boot command), and `gateway.suspend.prepare` returns `{ok:false, error:{type:
  "gateway_request_error", code:"INVALID_REQUEST", message:"unknown method:
  gateway.suspend.prepare", retryable:false}}`. The host maps this to a typed error and
  degrades: idle path disabled (no fence, never stop blind), ceiling becomes a direct stop,
  platform timeout remains the backstop. Repro: host/scripts/probe-legacy-gateway.ts.
- NEW upstream issue (question 6): once `prepare` returns `ready`, the gateway's WebSocket
  listener goes down and does NOT come back at lease expiry (process alive, port closed;
  observed wedged >5 min). The production idle path is unaffected (after ready the host only
  calls `sandbox.stop()`), but lease renewal, `status`, and `resume`/cancel are impossible
  while held, contradicting the protocol doc's claim that status/resume operate on a held
  lease.

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
5. Do the gateway's channel HTTP endpoints (e.g. `/slack/events`) require the gateway token,
   or is channel signature verification their only gate? The host forwards without the token
   today; if the endpoints demand it, forwarding needs the auth header, and if they don't,
   they are publicly routable ingress guarded only by channel signatures. UNVERIFIED either
   way; needs a live probe or an upstream answer.
6. Bug observed live (2026-08-11, beta.7): after `prepare` returns `ready`, the gateway's
   WebSocket listener closes and does not reopen at lease expiry (process survives, port 3000
   stays closed). This makes same-requestId renewal, `suspend.status`, and `suspend.resume`
   unusable while a lease is held, though the protocol doc describes them as operating on the
   held lease. Is this known, and is it fixed in 2026.7.2 stable?

## Explicitly deferred (not v1)

- Multi-sandbox / multi-agent routing
- Channel transports beyond the first channel + WebChat
- Credential brokering via network-policy header injection (old wrapper pattern; evaluate
  after the suspend loop works)
