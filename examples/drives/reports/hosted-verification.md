# Hosted verification

September28,2026. A separate Vercel test deployment exercised the Functions HTTP adapter, Redis request tracking, the official OpenClaw2026.9.6 image, AI Gateway and one persistent Drive.

- Build/typecheck and47localtests passed.
- Unauthorized requests returned401. Invalid and oversized messages returned400.
- An in-flight duplicate returned202; a competing request returned409. A completed duplicate returned the same saved result and resources.
- Three synthetic messages used three distinct workloadVMs and one stable Drive ID. Same-conversation history retained its native session ID; a fresh conversation recalled the workspace memory marker.
- Each successful message completed only after clean gateway exit, VM stop and Drive detach.

Measured HTTP durations, including initialization where needed, startup, model work and shutdown:

| Request | Seconds |
| --- | ---: |
| Initial agent setup and memory write | 32.485 |
| Conversation recall in a fresh VM | 26.580 |
| Memory recall in a fresh VM and conversation | 26.572 |

These are three observations, not a latency distribution or comparison with the older Slack/Codex integration. No Slack traffic, attachment/thread hydration, active-tool interruption, VM power loss, credential-rotation soak or uninterrupted uptime was tested in this deployment.

The separate local crash test of the same native runtime found that immediate restart after gateway SIGKILL can be refused by OpenClaw's five-minute ownership lease. A fresh VM after expiry recovered saved state without database/lease edits. The controller does not automatically replay uncertain turns.

Reproduce the hosted checks with `node test/hosted.live.mjs <deployment-url> <ignored-env-file>` after building and linking the separate test project. Keep raw receipts/resource IDs private under `results/`.
