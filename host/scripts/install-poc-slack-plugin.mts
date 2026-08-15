import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import { OPENCLAW_SLACK_PLUGIN } from '../lib/openclaw-runtime';

const archiveArg = process.argv[2];
if (!archiveArg) {
  throw new Error('usage: install-poc-slack-plugin.mts <npm-pack.tgz>');
}

const archivePath = resolve(archiveArg);
const remotePath = `/tmp/${basename(archivePath)}`;
const sandboxName = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-connect-poc';
const image =
  process.env.OPENCLAW_IMAGE ??
  'openclaw-foundation/openclaw/openclaw:latest';

const sandbox = await Sandbox.getOrCreate({
  name: sandboxName,
  image,
  persistent: true,
  timeout: 45 * 60 * 1000,
  ports: [3000],
});

await sandbox.writeFiles([
  { path: remotePath, content: await readFile(archivePath) },
]);

const version = await sandbox.runCommand({
  cmd: 'openclaw',
  args: ['--version'],
});
if (version.exitCode !== 0) {
  throw new Error(`openclaw --version failed (${version.exitCode})`);
}

// Install from the official registry first so OpenClaw records the plugin as
// trusted. A local npm-pack install is deliberately untrusted and therefore
// cannot use the durable channel-ingress queue exercised by this PoC.
// Temporarily remove the PoC-only key because the stock package validates the
// active config before replacing the existing plugin.
const clearBridge = await sandbox.runCommand({
  cmd: 'openclaw',
  args: ['config', 'unset', 'channels.slack.hostBridge'],
});
if (clearBridge.exitCode !== 0) {
  const stderr = await clearBridge.stderr();
  if (!stderr.includes('Config path not found')) {
    throw new Error(`Slack host bridge config cleanup failed (${clearBridge.exitCode}): ${stderr.slice(-800)}`);
  }
}

const install = await sandbox.runCommand({
  cmd: 'openclaw',
  args: ['plugins', 'install', OPENCLAW_SLACK_PLUGIN, '--pin', '--force'],
});
if (install.exitCode !== 0) {
  const stderr = await install.stderr();
  throw new Error(`Official Slack plugin install failed (${install.exitCode}): ${stderr.slice(-800)}`);
}

const packageProbe = await sandbox.runCommand({
  cmd: 'sh',
  args: [
    '-c',
    "find /home/node/.openclaw/npm/projects -path '*/node_modules/@openclaw/slack/package.json' -print",
  ],
});
const packagePaths = (await packageProbe.stdout()).trim().split('\n').filter(Boolean);
const officialVersion = OPENCLAW_SLACK_PLUGIN.slice(OPENCLAW_SLACK_PLUGIN.lastIndexOf('@') + 1);
let packageJsonPath: string | undefined;
for (const candidate of packagePaths) {
  const versionProbe = await sandbox.runCommand({
    cmd: 'node',
    args: [
      '-e',
      'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)',
      candidate,
    ],
  });
  if ((await versionProbe.stdout()).trim() === officialVersion) {
    packageJsonPath = candidate;
  }
}
if (packageProbe.exitCode !== 0 || !packageJsonPath) {
  throw new Error('Official Slack plugin package path was not found after install');
}

// PROTOTYPE ONLY: replace the official package contents in place while
// preserving its registry-backed install record and trusted provenance.
const overlay = await sandbox.runCommand({
  cmd: 'tar',
  args: [
    '-xzf',
    remotePath,
    '-C',
    resolve(packageJsonPath, '..'),
    '--strip-components=1',
  ],
});
if (overlay.exitCode !== 0) {
  const stderr = await overlay.stderr();
  throw new Error(`Slack PoC package overlay failed (${overlay.exitCode}): ${stderr.slice(-800)}`);
}

console.log(
  JSON.stringify({
    sandboxName,
    openclawVersion: (await version.stdout()).trim(),
    installed: packageProbe.exitCode === 0,
    packagePath: packageJsonPath,
  }),
);
