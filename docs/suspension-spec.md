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
Sandbox.create({
  image: 'vercel/openclaw/openclaw:latest',
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

1. `gateway.suspend.prepare`
2. poll `gateway.suspend.status` every 5s
3. ready -> immediately `sandbox.stop()` (ready lease is ~2 min; never wait out a deadline)
4. not ready after 120s (gateway busy, e.g. agent mid-task) -> `gateway.suspend.resume`,
   re-arm idle timer +15 min

**Session ceiling:** on every forwarded message, `sandbox.extendTimeout()` back to 75 min.
The ceiling only bites at the platform's hard maximum session length: 24 hours on Pro and
Enterprise, 45 minutes on Hobby (vercel.com/docs/sandbox/pricing, retrieved 2026-08-10). At
`expiresAt - 5 min` when no further extension is possible:

1. `prepare` -> poll -> ready -> `stop()` immediately
2. still not ready at T-60s -> `stop()` anyway (forced)
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

## Open contract questions (Patrick / 2026.7.2)

1. `suspend.status` vocabulary while draining vs busy (our poll loop branches on it).
2. `prepare` semantics with a long-running agent task: wait, checkpoint mid-task, or refuse?
   (Sets the real drain budget; determines what a force-stop loses.)
3. Admin RPC port and auth scheme (which port we expose; what secret the host holds).
4. Next-cron-time query availability (v1 cron wake depends on it).
5. Whether a checkpointed agent task auto-continues after an immediate resume (our design
   requires it; see ceiling path).

Questions 1-3 and 5 are empirically testable today against `2026.7.2-beta.7` (suspension
shipped in beta.1): mirror the beta tag to VCR, boot it, probe the admin RPC, run a long
task, prepare/stop/resume, observe. Beta findings answer "how does it behave now"; Patrick
still confirms "is this the stable contract" before we build against it.

## Explicitly deferred (not v1)

- Multi-sandbox / multi-agent routing
- Channel transports beyond the first channel + WebChat
- Credential brokering via network-policy header injection (old wrapper pattern; evaluate
  after the suspend loop works)
