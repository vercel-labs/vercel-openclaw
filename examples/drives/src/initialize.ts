import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Drive, Sandbox } from '@vercel/sandbox';
import { agentDriveName, DRIVE_BYTES, MOUNT, REGION, type Settings } from './config.js';
import type { Receipt } from './receipt.js';
import type { Platform } from './runtime.js';

export const prepareDriveScript = String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = process.argv[1];
const state = path.join(root, 'openclaw');
const marker = path.join(state, '.vercel-drive-prepared.json');
const expected = JSON.stringify({format:1,uid:1000,gid:1000});
if (process.getuid() !== 0) throw new Error('Drive preparation requires root.');
if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error('Unexpected mount path.');
for (const name of fs.readdirSync(root)) {
  if (name === 'openclaw') continue;
  if (name !== 'lost+found') throw new Error('Unrecognized Drive content; refusing to modify it.');
  const recovery = path.join(root, name);
  if (!fs.lstatSync(recovery).isDirectory() || fs.readdirSync(recovery).length) throw new Error('Unexpected recovery directory; inspect it before initialization.');
}
if (fs.existsSync(state)) {
  const stat = fs.lstatSync(state);
  if (!stat.isDirectory() || stat.uid !== 1000 || stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700 ||
      !fs.existsSync(marker) || !fs.lstatSync(marker).isFile() || fs.readFileSync(marker,'utf8') !== expected)
    throw new Error('Unrecognized state directory; refusing to modify it.');
  console.log('prepared-state-preserved');
} else {
  fs.mkdirSync(state, {mode:0o700});
  const fd = fs.openSync(marker,'wx',0o600);
  try {fs.writeFileSync(fd,expected);fs.fchownSync(fd,1000,1000);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.chownSync(state,1000,1000);
  console.log('drive-prepared');
}
`;

export async function initializeDrive(settings: Settings, agent: string, receipt: Receipt,
  services: Platform = { drive: params => Drive.getOrCreate(params), create: params => Sandbox.create(params) }
): Promise<Record<string, unknown>> {
  const name = agentDriveName(agent);
  const drive = await services.drive({ ...settings.credentials, name, region: REGION, maxSize: DRIVE_BYTES, signal: AbortSignal.timeout(30_000) });
  receipt.event('initializer-drive', { name, driveId: drive.driveId, attachedSession: drive.currentSessionId ?? null });
  assert(!drive.currentSessionId && !drive.currentSandboxName, `Drive ${name} already has a writer.`);
  const sandbox = await services.create({ ...settings.credentials, name: `${name}-init-${randomUUID().slice(0,8)}`,
    image: 'vercel/sandbox/node:24', persistent: false, region: REGION, timeout: 120_000,
    networkPolicy: 'deny-all', mounts: { [MOUNT]: drive }, signal: AbortSignal.timeout(120_000) });
  receipt.event('initializer-created', { name: sandbox.name, sessionId: sandbox.currentSession().sessionId,
    image: sandbox.image, region: sandbox.region, persistent: sandbox.persistent, mounts: sandbox.mounts });
  assert.equal(sandbox.persistent, false);
  assert(sandbox.mounts?.[MOUNT], 'Initializer Drive mount missing.');
  const command = await sandbox.runCommand({ cmd: 'node', args: ['-e', prepareDriveScript, MOUNT],
    sudo: true, timeoutMs: 30_000, signal: AbortSignal.timeout(35_000) });
  const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
  receipt.event('initializer-command', { commandId: command.cmdId, sessionId: sandbox.currentSession().sessionId, exitCode: command.exitCode, stdout, stderr });
  assert.equal(command.exitCode, 0, 'Drive initialization failed; resources preserved. Inspect command output.');
  assert(['drive-prepared', 'prepared-state-preserved'].includes(stdout.trim()), 'Unexpected initializer result.');
  await sandbox.stop({ signal: AbortSignal.timeout(60_000) });
  const deadline = AbortSignal.timeout(60_000);
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await services.drive({ ...settings.credentials, name, region: REGION, maxSize: DRIVE_BYTES,
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
    if (!current.currentSessionId && !current.currentSandboxName) {
      receipt.event('initializer-detached', { name, sandbox: sandbox.name });
      return { drive: name, sandbox: sandbox.name, sessionId: sandbox.currentSession().sessionId, image: sandbox.image, prepared: true, detached: true };
    }
    await delay(1000, undefined, { signal: deadline });
  }
  throw new Error('Initializer Drive did not detach in time.');
}
