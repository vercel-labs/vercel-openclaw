import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Sandbox } from '@vercel/sandbox';

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

const install = await sandbox.runCommand({
  cmd: 'openclaw',
  args: ['plugins', 'install', `npm-pack:${remotePath}`, '--force'],
});
if (install.exitCode !== 0) {
  const stderr = await install.stderr();
  throw new Error(`Slack PoC plugin install failed (${install.exitCode}): ${stderr.slice(-800)}`);
}

const packageProbe = await sandbox.runCommand({
  cmd: 'sh',
  args: [
    '-c',
    "find /home/node/.openclaw/npm/projects -path '*/node_modules/@openclaw/slack/package.json' -print -quit",
  ],
});

console.log(
  JSON.stringify({
    sandboxName,
    openclawVersion: (await version.stdout()).trim(),
    installed: packageProbe.exitCode === 0,
    packagePath: (await packageProbe.stdout()).trim(),
  }),
);
