# Split integration verification

October 7, 2026: implementation and cloud qualification in progress.

Local tests currently pass 20 checks: native-only configuration, model and project credential custody, concurrent owner election, owner-store refusal, one allocation under concurrency, attached Drive refusal, 196,613-byte HTTP payload preservation, early WebSocket bytes in both directions, control authorization and rejection on a nonowner. Lifecycle checks cover native placement admission, post-commit session errors, uncertain turn refusal, a signal-killed gateway and attempted worker cleanup after gateway shutdown failure, rejection of the wrong worker identity and refusal to verify a changed placement, serialized proof reads and preservation of uncertainty across shutdown.

An earlier Redis probe exited 1 with zero successful contenders; its failure receipt is retained separately. A subsequent live Redis probe admitted 1 of 8 concurrent contenders, retained the owner with no expiry (TTL -1) and refused replacement. This verifies only the Redis admission rule, not Function affinity or filesystem fencing.

The first transport test run left a fixture socket open after its assertions passed. The fixture now closes its owned upgraded socket; the suite exits normally. This was a test cleanup defect, not a proven cloud transport failure.

The separate earlier runtime qualification built pinned OpenClaw and passed 9 source integration tests plus 1 packaged-worker test after a test-only manifest correction. Those fixtures ran inside one Sandbox; they did not exercise this Function-to-Sandbox implementation.

The first Docker build was canceled after about 29 minutes without completion; the last visible compiler output preceded cancellation by about 23 minutes. Its deployment and logs are preserved. The recipe now uses upstream’s full runtime build with bulk declaration generation disabled, phase timings and a ten-minute timeout for each compiler invocation. The reason for the first build’s lack of progress is unconfirmed.

Native cloud enrollment and model/file turn: NOT_TESTED pending the replacement image build. Gateway restart persistence, owner replacement, automatic idle/wake and Slack: NOT_TESTED. This report will be updated from actual deployment results.
