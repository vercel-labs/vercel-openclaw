# Split integration verification

October 7, 2026 PDT / October 8 UTC. Native cloud end-to-end qualification is blocked at the worker's WebSocket connection. No native model/file turn has completed.

## Verified

`npm test` passes 23 checks. These cover native-only configuration, credential custody, concurrent owner admission, single worker allocation, attached-Drive refusal, 196,613-byte HTTP body preservation, early WebSocket bytes in both directions, control authentication, native placement checks, uncertain turns and shutdown. New regressions cover request-scoped container identity and its bootstrap lifetime, and VCR image-reference normalization without dropping repository or digest validation.

A live Redis probe admitted 1 of 8 concurrent contenders, retained the owner without expiry (TTL -1) and refused replacement. An earlier probe failed with zero successful contenders; its evidence is retained. This establishes Redis admission only, not Function routing or filesystem fencing.

The full pinned OpenClaw image built and published on an 8-CPU, 16-GB Enhanced builder. Upstream reported 12 minutes and 49.7 seconds for its full build; Vercel reported about 19 minutes including dependency installation, image layers and upload. Three earlier 4-CPU, 8-GB builds were canceled without completion, including a default-build attempt after 26 minutes and 33 seconds. Their lack of completion has no confirmed root cause. The successful configuration is not a proven minimum. The project's original standard/Elastic builder setting was restored and verified.

The container deployments reached Ready. Protected health and control-status requests returned HTTP 200. The final proof allocated one 2-vCPU, 4-GB Sandbox with one Drive. Native `config validate --json` and `node identity --json` both exited 0 inside that Sandbox; the native node process started.

## Live failures and corrections

The first bootstrap started the native gateway, then failed with `VercelOidcContextError` before worker allocation. A resource listing found no Sandbox or Drive for that proof ID. The wrapper now reads the Function request's `x-vercel-oidc-token` and passes explicit scoped credentials to the SDK and the deployment firewall rule. It binds credentials at bootstrap without replacing an already-started controller. Credential renewal remains unimplemented.

The second proof allocated one Sandbox and Drive, then stopped before any worker command. Its image check compared a fully qualified VCR reference with the API's canonical repository reference, despite an identical digest. The comparison now normalizes only the literal VCR hostname and still requires the repository and digest to match. The stopped session, detached Drive and empty command list are preserved.

The third proof passed those points, but the native node recorded six failed WebSocket connection attempts:

```text
node host gateway connect failed: gateway rejected websocket upgrade (HTTP 503)
```

Function request logs also recorded six HTTP 503 responses on that connection path. Bootstrap returned HTTP 500 after about 148 seconds. Subsequent status requests reported an uninitialized controller, so they did not retrieve the bootstrap owner's state. The exact cause of the upgrade rejection, including owner routing versus gateway-instance lifetime, is not established. The failed worker is stopped; its resource metadata, commands and connection logs are preserved. No further bootstrap retries were made after this result.

## Remaining acceptance

The next cloud check must establish that the worker WebSocket and subsequent control requests reach the gateway owner, with enough observability to distinguish nonowner rejection from owner termination or native upstream failure. Then repeat enrollment, mandatory worker placement, a real model/file turn, an independent file/transcript check and a second turn on the same worker session. These model/file checks remain NOT_TESTED.

Gateway state still uses the Function's temporary filesystem. External gateway persistence, confirmed old-owner termination, owner replacement, credential renewal, one-hour idle/wake and Slack delivery remain NOT_TESTED. This is reviewable integration code, not a persistent or indefinitely running cloud harness.

A separate earlier source qualification built the pin and passed 9 native integration tests plus 1 packaged-worker test after a test-only manifest correction. Those fixtures ran inside one Sandbox and do not establish this cloud split. An early local transport fixture also required a socket-cleanup correction; the current 23-test suite exits normally. Failed runs remain in the private evidence packet.
