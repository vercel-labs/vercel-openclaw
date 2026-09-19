import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCodexNativeExecutable, verifyPrebuiltRuntime, verifyWorkerConfig } from './bootstrap.mjs';

process.umask(0o077);
const runtime = process.cwd();
const packageRoot = join(runtime, 'node_modules/openclaw');
const dist = join(packageRoot, 'dist');
const build = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'));
assert.equal(build.commit, '3928bad9badfcb6c7d140530435e806fb8092190');
assert.equal(build.version, '2026.9.2');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
for (const id of ['codex', 'vercel-ai-gateway']) {
  assert.equal(JSON.parse(readFileSync(join(dist, 'extensions', id, 'openclaw.plugin.json'), 'utf8')).id, id);
}
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@openclaw/slack/openclaw.plugin.json'), 'utf8')).id, 'slack');
const entries = readdirSync(dist).filter(name => /^node-bootstrap-artifact-[\w-]+\.js$/.test(name));
assert.equal(entries.length, 1, 'Pinned native artifact producer missing or ambiguous');
const { createNodeBootstrapArtifactProvider } = await import(pathToFileURL(join(dist, entries[0])).href);
const producer = createNodeBootstrapArtifactProvider({ packageRoot, runningBuildId: build.buildId, plugins: [{ id: 'codex', root: join(dist, 'extensions/codex') }] });
try {
  const artifact = await producer.prepare();
  copyFileSync(artifact.tarballPath, join(packageRoot, 'node-runtime.tgz'));
  const manifest = { sha256: artifact.tarballSha256, bytes: artifact.tarballBytes, openclawVersion: artifact.openclawVersion, buildId: artifact.buildId, enabledPluginIds: artifact.enabledPluginIds };
  const stage = mkdtempSync(join(runtime, 'worker-config-'));
  try {
    const env = { ...process.env, HOME: stage, OPENCLAW_STATE_DIR: stage, OPENCLAW_CONFIG_PATH: join(stage, 'openclaw.json') };
    const cli = join(packageRoot, 'openclaw.mjs');
    execFileSync(process.execPath, [cli, '--version'], { env, stdio: 'pipe', timeout: 30_000 });
    for (const id of manifest.enabledPluginIds) execFileSync(process.execPath, [cli, 'plugins', 'enable', id], { env, stdio: 'pipe', timeout: 60_000 });
    manifest.workerConfig = verifyWorkerConfig(manifest, JSON.parse(readFileSync(env.OPENCLAW_CONFIG_PATH, 'utf8')));
  } finally { rmSync(stage, { recursive: true, force: true }); }
  writeFileSync(join(runtime, 'worker-image.json'), JSON.stringify(manifest));
  verifyPrebuiltRuntime(manifest, runtime);
  const native = execFileSync(resolveCodexNativeExecutable(runtime), ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(native, 'codex-cli 0.153.4');
  console.log(JSON.stringify({ status: 'IMAGE_RUNTIME_VERIFIED', ...manifest, native, node: process.version }));
} finally { await producer.close(); }
