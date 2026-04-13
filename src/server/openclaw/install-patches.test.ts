import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAcpxStartupProbeDelayPatch,
  applyQmdWarmupDelayPatch,
  buildOpenClawInstallPatchScript,
  OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER,
  OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER,
  parseOpenClawInstallPatchOutcome,
} from "@/server/openclaw/install-patches";

const QMD_WARMUP_SOURCE = `
if (params.cfg.acp?.enabled) getAcpSessionManager().reconcilePendingSessionIdentities({ cfg: params.cfg }).then((result) => {
  if (result.checked === 0) return;
  params.log.warn(\`acp startup identity reconcile (renderer=v1): checked=\${result.checked} resolved=\${result.resolved} failed=\${result.failed}\`);
}).catch((err) => {
  params.log.warn(\`acp startup identity reconcile failed: \${String(err)}\`);
});
startGatewayMemoryBackend({
  cfg: params.cfg,
  log: params.log
}).catch((err) => {
  params.log.warn(\`qmd memory startup initialization failed: \${String(err)}\`);
});
if (shouldWakeFromRestartSentinel()) setTimeout(() => {
  scheduleRestartSentinelWake({ deps: params.deps });
}, 750);
`;

const ACPX_STARTUP_SOURCE = `
ctx.logger.info(\`embedded acpx runtime backend registered (cwd: \${pluginConfig.cwd})\`);
if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1") return;
lifecycleRevision += 1;
const currentRevision = lifecycleRevision;
(async () => {
\ttry {
\t\tawait runtime?.probeAvailability();
\t\tif (currentRevision !== lifecycleRevision) return;
\t\tif (runtime?.isHealthy()) {
\t\t\tctx.logger.info("embedded acpx runtime backend ready");
\t\t\treturn;
\t\t}
\t\tconst doctorReport = await runtime?.doctor?.();
\t\tif (currentRevision !== lifecycleRevision) return;
\t\tctx.logger.warn(\`embedded acpx runtime backend probe failed: \${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}\`);
\t} catch (err) {
\t\tif (currentRevision !== lifecycleRevision) return;
\t\tctx.logger.warn(\`embedded acpx runtime setup failed: \${formatErrorMessage$1(err)}\`);
\t}
})();
`;

test("applyQmdWarmupDelayPatch rewrites the startup memory warmup block", () => {
  const result = applyQmdWarmupDelayPatch(QMD_WARMUP_SOURCE);

  assert.equal(result.status, "applied");
  assert.match(result.nextContent, /setTimeout\(\(\) => startMemoryBackend\(\), 3000\)/);
  assert.match(result.nextContent, new RegExp(OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER));
});

test("applyQmdWarmupDelayPatch is idempotent once the marker is present", () => {
  const once = applyQmdWarmupDelayPatch(QMD_WARMUP_SOURCE);
  const twice = applyQmdWarmupDelayPatch(once.nextContent);

  assert.equal(once.status, "applied");
  assert.equal(twice.status, "already-patched");
  assert.equal(twice.nextContent, once.nextContent);
});

test("applyQmdWarmupDelayPatch skips unrelated content", () => {
  const result = applyQmdWarmupDelayPatch("console.log('nothing to patch');\n");

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "target-not-found");
});

test("applyAcpxStartupProbeDelayPatch rewrites the embedded acpx probe for supported npm versions", () => {
  const result = applyAcpxStartupProbeDelayPatch(ACPX_STARTUP_SOURCE, "2026.4.11");

  assert.equal(result.status, "applied");
  assert.match(result.nextContent, /setTimeout\(\(\) => \{/);
  assert.match(result.nextContent, /resolvedProbeDelayMs = Number\.isFinite/);
  assert.match(result.nextContent, new RegExp(OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER));
});

test("applyAcpxStartupProbeDelayPatch is idempotent once the marker is present", () => {
  const once = applyAcpxStartupProbeDelayPatch(ACPX_STARTUP_SOURCE, "2026.4.11");
  const twice = applyAcpxStartupProbeDelayPatch(once.nextContent, "2026.4.11");

  assert.equal(once.status, "applied");
  assert.equal(twice.status, "already-patched");
  assert.equal(twice.nextContent, once.nextContent);
});

test("applyAcpxStartupProbeDelayPatch skips unsupported versions", () => {
  const result = applyAcpxStartupProbeDelayPatch(ACPX_STARTUP_SOURCE, "2026.4.10");

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "unsupported-version:2026.4.10");
});

test("buildOpenClawInstallPatchScript embeds the marker and target package path", () => {
  const script = buildOpenClawInstallPatchScript();

  assert.match(script, /vercel-openclaw:qmd-warmup-delay/);
  assert.match(script, /vercel-openclaw:acpx-startup-probe-delay/);
  assert.match(script, /node_modules\/openclaw/);
  assert.match(script, /server\.impl-/);
});

test("parseOpenClawInstallPatchOutcome parses valid runner output", () => {
  const parsed = parseOpenClawInstallPatchOutcome(
    JSON.stringify({ status: "applied", filePath: "/tmp/openclaw/dist/server.impl-hash.js" }),
  );

  assert.deepEqual(parsed, {
    status: "applied",
    filePath: "/tmp/openclaw/dist/server.impl-hash.js",
  });
});

test("parseOpenClawInstallPatchOutcome rejects invalid output", () => {
  assert.equal(parseOpenClawInstallPatchOutcome("not-json"), null);
  assert.equal(parseOpenClawInstallPatchOutcome(JSON.stringify({ status: "other" })), null);
});
