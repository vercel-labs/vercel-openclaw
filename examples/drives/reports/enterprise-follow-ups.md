# Enterprise comparison and follow-ups

Source review: October 5, 2026, against [OpenClaw Enterprise at 7f5c8ef](https://github.com/openclaw/openclaw-enterprise/tree/7f5c8ef4e02239d20573f266e699d138f33cafd6). This is a source comparison, not an Enterprise deployment or conformance test.

The example follows the [embedded topology](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/reference/harness-execution.md): one VM runs the gateway and built-in harness. Drives preserve state across VM sessions. The agent and gateway share the workload; a Drive does not create an isolation boundary between them. Slack and AI provider keys are supplied outside the VM by the Sandbox firewall, but the workload can still make requests permitted by that policy.

This is a standalone example, not an Enterprise ComputeDriver or control plane. The current policy admits one Slack user/channel and human mentions. File read/write tools are enabled; skills, cron, heartbeat and automatic memory flushing are disabled.

## Follow-up work

| Priority | Current gap | Acceptance condition |
| --- | --- | --- |
| Before broader access | Cold startup checks expected configuration bytes; warm reconnect does not. Managed configuration lives with writable state. | Validate expected configuration on warm admission and separate operator-managed configuration from mutable state. Refuse unexpected changes while preserving evidence. |
| Before broader access | The first allocation accepts a fixed release tag, then records its resolved digest. Cached plugin checks do not establish full content provenance. | Require an approved immutable image digest before allocation and verify installed plugin provenance. |
| Before unattended operation | Saving pending shutdown state and publishing its delayed callback are separate operations. Interrupted publication can leave a VM without its new callback. | Persist scheduling intent and reconcile it with a durable outbox or watchdog. Recover exact owned resources without replaying an uncertain agent turn. |
| Before unattended operation | Detailed lifecycle receipts use function-local temporary storage; Redis saves only selected outcomes. | Persist redacted lifecycle records and alert on orphaned or failed states. |
| Before unattended operation | Gateway health and Slack readiness do not prove current model authentication. | Run a bounded model probe at deployment or cold startup, using temporary state. |
| Before production durability claims | Restart tests demonstrate saved-state continuity, not every SQLite storage guarantee. | Confirm the Drive contract for locking, fsync and companion WAL/SHM files, then qualify database integrity and controlled recovery. This is unverified, not evidence of incompatibility. |
| Before wider feature claims | Warm message latency, acknowledgment timing, full-hour idle, session rollover and richer Slack payloads still need live tests. | Complete the [remaining acceptance tests](slack-warm-verification.md#still-unverified) before enabling broader users, tools or background work. |

The recommendation is to retain the embedded MVP while completing those checks. A native Enterprise backend would be a separate integration against its [ComputeDriver contract](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/reference/drivers/compute.md). Shared dependency caches should be designed separately from each agent’s mutable state; concurrent readers can use read-only Drive snapshots.

## Reference contracts

- [Managed configuration, SQLite storage and ordered shutdown](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/reference/drivers/kubernetes-compute/storage-and-credentials.md)
- [Image approval and immutability](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/reference/security.md#image-approval-and-immutability)
- [Lifecycle reconciliation and renewable ownership](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/reference/controller/reconciliation.md)
- [Observability and durable audit records](https://github.com/openclaw/openclaw-enterprise/blob/7f5c8ef4e02239d20573f266e699d138f33cafd6/docs/guides/observability.md)
