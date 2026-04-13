import assert from "node:assert/strict";
import test from "node:test";

import {
  applyQmdWarmupDelayPatch,
  buildOpenClawInstallPatchScript,
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

test("buildOpenClawInstallPatchScript embeds the marker and target package path", () => {
  const script = buildOpenClawInstallPatchScript();

  assert.match(script, /vercel-openclaw:qmd-warmup-delay/);
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
