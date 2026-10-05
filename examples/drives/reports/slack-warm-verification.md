# Slack and warm-runtime verification

The following live results were recorded on September 28–29, 2026. Local verification was rerun on October 5: `npm test` passed 114 tests, and `npm run typecheck` passed both source and hosted-adapter checks. Runtime source matches the reviewed September 29 deployment; the October 5 changes correct documentation only.

| Boundary | Observed result | Limit |
| --- | --- | --- |
| User-originated Slack messages, previous per-turn shutdown configuration | Two mentions received native replies; separate VMs used the same Drive and native conversation, recovered saved state and shut down cleanly | Does not prove warm user-message behavior |
| Warm native readiness | Same VM and gateway reused across controller objects; native drain/resume passed | Readiness probe sent no Slack event or model turn |
| Shortened idle and restart | Gateway exited cleanly, VM stopped, Drive detached; fresh VM recovered the saved file | Full one-hour idle interval was not run |
| Hosted delayed Queue callback | Callback returned HTTP 200; the expected VM stopped, Drive detached and saved warm descriptor cleared | Shortened interval, not a one-hour soak |
| Eyes reaction | Slack API success and independent message readback confirmed the bot reaction | Direct reaction on an existing message, not automatic timing on a new mention |

The two earlier Slack replies took 67.009 and 60.182 seconds from user message to reply, derived from Slack timestamps. These observations do not establish a speedup over the existing integration. Warm reply latency remains unmeasured.

## Reproduce

Follow the [isolated Slack setup](../README.md#configure-an-isolated-test), including Connect, Redis, Queue signing secret and the explicit user/channel policy. After building, `test/slack-readiness.live.mjs` checks native readiness without sending messages. `test/slack-warm.live.mjs` exercises reuse, shortened idle shutdown and saved-file recovery; it does not establish hosted Queue delivery. Run these scripts only with an isolated project and ignored environment file. Sandbox, Drive and model usage are billable; resources and raw receipts remain private under `results/`.

For user-message acceptance, mention the bot twice in the same thread and check the reaction, native replies, event-body hashes and identical VM/gateway identity. Wait the full hour, confirm shutdown and detach, then send a new mention and verify the new VM recovers the saved state.

## Still unverified

Automatic acknowledgment timing on a new event; two real Slack turns on one warm VM and their latency; the full one-hour idle interval; 24-hour session rollover; attachment downloads, complete thread history and long messages; credential expiry/revocation; interruption during active tools or around shutdown scheduling. Continuous operation and automatic recovery of uncertain turns are not established.

The [HTTP report](hosted-verification.md) records a separate earlier run. The [Enterprise follow-ups](enterprise-follow-ups.md) describe the remaining architecture work.
