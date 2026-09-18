import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

let phase = 'descriptor';

export function verifyWorkerConfig(bootstrap, config) {
  const expected = { plugins: { entries: { codex: { enabled: true } } }, meta: { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: '2026.9.2' } };
  if (bootstrap.openclawVersion !== '2026.9.2' || !isDeepStrictEqual(bootstrap.enabledPluginIds, ['codex']) || !isDeepStrictEqual(config, expected)) {
    throw new Error('Prepared worker configuration differs from the verified credential-free CLI output.');
  }
  return config;
}

export function seedWorkerConfig(state, mode, config) {
  if (mode !== 'connect') return false;
  try { writeFileSync(join(state, 'openclaw.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

export function verifyPrebuiltRuntime(bootstrap, runtime) {
  const image = JSON.parse(readFileSync(join(runtime, 'worker-image.json'), 'utf8'));
  const archive = readFileSync(join(runtime, 'node_modules/openclaw/node-runtime.tgz'));
  const build = JSON.parse(readFileSync(join(runtime, 'node_modules/openclaw/dist/build-info.json'), 'utf8'));
  if (['sha256', 'bytes', 'openclawVersion'].some(key => image[key] !== bootstrap[key]) ||
      !isDeepStrictEqual(image.enabledPluginIds, bootstrap.enabledPluginIds) ||
      archive.length !== image.bytes || createHash('sha256').update(archive).digest('hex') !== image.sha256 ||
      !image.buildId || build.buildId !== image.buildId || build.version !== image.openclawVersion) {
    throw new Error('Prebuilt image does not match the gateway artifact; rebuild the image.');
  }
  return image.workerConfig ? verifyWorkerConfig(bootstrap, image.workerConfig) : undefined;
}

export function npmPolicyArgs(policy) {
  const registry = new URL(policy.registry);
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) throw new Error('Invalid npm registry');
  if (!Number.isFinite(policy.minReleaseAgeDays) || policy.minReleaseAgeDays < 2 || policy.minReleaseAgeDays > 365) throw new Error('Invalid npm age policy');
  if (!Array.isArray(policy.exclusions) || policy.exclusions.length > 2 || policy.exclusions.some(name => !['openclaw', '@openclaw/ai'].includes(name))) throw new Error('Invalid npm age exception');
  return [`--registry=${registry.href}`, `--min-release-age=${policy.minReleaseAgeDays}`, ...policy.exclusions.map(name => `--min-release-age-exclude=${name}`)];
}

export function assertNpmPolicySupport(config) {
  if (!Object.hasOwn(config, 'min-release-age') || !Array.isArray(config['min-release-age-exclude'])) throw new Error('npm must support minimum release age and named exclusions');
}

export function requiredCodexPackages(bootstrap) {
  if (!bootstrap.enabledPluginIds.includes('codex')) return [];
  if (bootstrap.openclawVersion !== '2026.9.2') throw new Error('Codex native dependency pin is not verified for this OpenClaw version');
  return ['@openai/codex@0.153.4', '@openai/codex-linux-x64@npm:@openai/codex@0.153.4-linux-x64'];
}

export function resolveCodexNativeExecutable(runtime) {
  const plugin = join(runtime, 'node_modules/openclaw/dist/extensions/codex/package.json');
  if (JSON.parse(readFileSync(plugin, 'utf8')).dependencies?.['@openai/codex'] !== '0.153.4') throw new Error('Bundled Codex dependency pin differs');
  const codex = createRequire(plugin).resolve('@openai/codex/package.json');
  if (JSON.parse(readFileSync(codex, 'utf8')).version !== '0.153.4') throw new Error('Codex launcher pin differs');
  const platform = createRequire(codex).resolve('@openai/codex-linux-x64/package.json');
  if (JSON.parse(readFileSync(platform, 'utf8')).version !== '0.153.4-linux-x64') throw new Error('Codex native pin differs');
  const native = join(dirname(platform), 'vendor/x86_64-unknown-linux-musl/bin/codex');
  if (!existsSync(native)) throw new Error('Codex native executable missing');
  return native;
}

export async function verifyDownload(artifact, destination, fetcher = fetch) {
  const response = await fetcher(artifact.url, {
    headers: { authorization: `Bearer ${artifact.token}` }, redirect: 'error',
    signal: AbortSignal.timeout(600_000),
  });
  if (response.status !== 200 || !response.body) throw new Error('Bootstrap download failed.');
  const file = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > artifact.bytes) throw new Error('Bootstrap download exceeds declared size.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error('Bootstrap download integrity mismatch.');
  } finally { await file.close(); }
}

export function takeCredentials(env) {
  const bootstrap = JSON.parse(env.OC_WORKER_BOOTSTRAP || '{}');
  const enrollment = JSON.parse(env.OC_WORKER_ENROLLMENT || '{}');
  delete env.OC_WORKER_BOOTSTRAP;
  delete env.OC_WORKER_ENROLLMENT;
  return { bootstrap, enrollment };
}

async function main() {
  const { bootstrap, enrollment } = takeCredentials(process.env);
  const policy = JSON.parse(process.env.OC_WORKER_NPM_POLICY || '{"registry":"https://registry.npmjs.org/","minReleaseAgeDays":2,"exclusions":[]}');
  const npmArgs = npmPolicyArgs(policy);
  delete process.env.OC_WORKER_NPM_POLICY;
  const url = new URL(bootstrap.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(bootstrap.sha256) || !Number.isSafeInteger(bootstrap.bytes) || bootstrap.bytes < 1 || bootstrap.bytes > 512 * 1024 * 1024 || bootstrap.tlsFingerprint) throw new Error('Invalid bootstrap descriptor.');
  if (!['connect', 'resume'].includes(enrollment.mode)) throw new Error('Invalid enrollment mode.');
  if (policy.exclusions.length && bootstrap.openclawVersion !== '2026.9.2') throw new Error('Release exception does not cover this version');
  process.umask(0o077);
  const root = join(homedir(), '.openclaw-vercel-worker');
  const state = join(root, 'state');
  const prebuilt = process.env.OC_WORKER_PREBUILT_RUNTIME;
  delete process.env.OC_WORKER_PREBUILT_RUNTIME;
  const runtime = prebuilt ?? join(root, bootstrap.sha256);
  const cli = join(runtime, 'node_modules/openclaw/openclaw.mjs');
  const pidFile = join(root, 'node.pid');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const childEnv = { ...process.env, OPENCLAW_STATE_DIR: state };
  childEnv.OPENCLAW_CONFIG_PATH = join(state, 'openclaw.json');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid node PID.');
    try {
      process.kill(pid, 0);
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (realpathSync(`/proc/${pid}/cwd`) !== runtime || !env.includes(`OPENCLAW_STATE_DIR=${state}`)) throw new Error('Node process identity changed.');
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      rmSync(pidFile);
    }
  }
  const stage = await mkdtemp(join(root, 'install-'));
  const log = openSync(join(root, 'bootstrap.log'), 'a', 0o600);
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, env: childEnv, stdio: ['ignore', log, log], timeout: 600_000 });
    if (result.status !== 0) throw new Error('Bootstrap command failed; inspect bootstrap.log.');
  };
  try {
    let preparedConfig;
    if (prebuilt) {
      phase = 'image-verification';
      preparedConfig = verifyPrebuiltRuntime(bootstrap, runtime);
    } else if (!existsSync(runtime)) {
      const archive = join(stage, 'openclaw.tgz');
      phase = 'download';
      await verifyDownload(bootstrap, archive);
      const install = join(stage, 'runtime');
      mkdirSync(install, { mode: 0o700 });
      writeFileSync(join(install, 'package.json'), JSON.stringify({ private: true, allowScripts: { [`file:${archive}`]: true } }), { mode: 0o600 });
      phase = 'installation';
      const npmConfig = spawnSync('npm', ['config', 'list', '--json'], { env: childEnv, encoding: 'utf8', timeout: 30_000 });
      if (npmConfig.status !== 0) throw new Error('Cannot verify npm policy support');
      assertNpmPolicySupport(JSON.parse(npmConfig.stdout));
      run('npm', ['install', '--prefix', install, '--omit=dev', '--include=optional', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--ignore-scripts=false', ...npmArgs, archive, ...requiredCodexPackages(bootstrap)], stage);
      renameSync(install, runtime);
    }
    phase = 'runtime-verification';
    const manifest = JSON.parse(readFileSync(join(runtime, 'node_modules/openclaw/package.json'), 'utf8'));
    if (manifest.name !== 'openclaw' || manifest.version !== bootstrap.openclawVersion) throw new Error('Installed runtime does not match gateway.');
    if (policy.exclusions.includes('@openclaw/ai') && JSON.parse(readFileSync(join(runtime, 'node_modules/@openclaw/ai/package.json'), 'utf8')).version !== '2026.9.2') throw new Error('AI dependency exception pin differs');
    if (!preparedConfig) run(process.execPath, [cli, '--version'], runtime);
    if (requiredCodexPackages(bootstrap).length) {
      run(resolveCodexNativeExecutable(runtime), ['--version'], runtime);
    }
    phase = 'plugin-activation';
    if (!preparedConfig || !seedWorkerConfig(state, enrollment.mode, preparedConfig)) {
      for (const plugin of bootstrap.enabledPluginIds) {
        if (typeof plugin !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(plugin)) throw new Error('Invalid bootstrap plugin id.');
        run(process.execPath, [cli, 'plugins', 'enable', plugin], runtime);
      }
    }
    const target = join(state, 'setup-target');
    if (enrollment.mode === 'connect') {
      if (!enrollment.setupCode) throw new Error('Missing enrollment credential.');
      writeFileSync(target, enrollment.setupCode, { mode: 0o600 });
    }
    const args = enrollment.mode === 'connect' ? ['connect', '--target-file', target] : ['node', 'run'];
    phase = 'node-launch';
    const child = spawn(process.execPath, [cli, ...args, '--ephemeral', '--display-name', enrollment.displayName], {
      cwd: runtime, env: childEnv, detached: true, stdio: ['ignore', log, log],
    });
    await once(child, 'spawn');
    try { writeFileSync(pidFile, String(child.pid), { mode: 0o600 }); }
    catch (error) { process.kill(-child.pid, 'SIGTERM'); throw error; }
    child.unref();
  } finally {
    closeSync(log);
    rmSync(stage, { recursive: true, force: true });
  }
}

export function runBootstrapCli() {
  return main().then(() => process.stdout.write('worker-bootstrap-ready\n')).catch(() => {
    process.stderr.write(`Worker bootstrap failed at ${phase}; credentials redacted.\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await runBootstrapCli();
