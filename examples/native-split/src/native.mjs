import {spawn} from 'node:child_process';
import {mkdir, writeFile, rename, open, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {gatewayConfig, gatewayEnvironment} from './config.mjs';

export async function run(runtime, args, env, timeout = 30000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', x => { stdout += x; if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', x => { stderr = (stderr + x).slice(-16384); });
    child.once('error', err => {clearTimeout(timer); reject(err);});
    child.once('exit', code => {clearTimeout(timer); if (code !== 0) { const safe = stderr.replaceAll(env.OPENCLAW_GATEWAY_TOKEN, '[redacted]'); writeFile(`${env.OPENCLAW_STATE_DIR}/last-command-error.log`, safe, {mode: 0o600}).catch(() => {}); reject(new Error(`OpenClaw ${args[0]} failed (exit ${code}); inspect private runtime logs`)); } else resolve(stdout);});
  });
}
export class NativeGateway {
  constructor(config, root, token) { this.config = config; this.root = root; this.env = gatewayEnvironment(root, token); this.child = undefined; }
  async configure(deviceId) {
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const file = `${this.root}/openclaw.json`; const temp = `${file}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(gatewayConfig(this.config.model, deviceId)), {mode: 0o600, flag: 'wx'});
    await rename(temp, file);
    await run(this.config.runtime, ['config', 'validate', '--json'], this.env, 60000);
  }
  async start() {
    if (this.child) throw new Error('Gateway process already allocated');
    const log = await open(`${this.root}/gateway.log`, 'a', 0o600);
    this.child = spawn(process.execPath, [this.config.runtime, 'gateway', 'run'], {env: this.env, stdio: ['ignore', log.fd, log.fd]});
    await log.close();
    this.exited = new Promise(resolve => {this.child.once('exit', (code, signal) => resolve({code, signal})); this.child.once('error', () => resolve({code: -1}));});
    for (let i = 0; i < 180; i++) {
      if (this.child.exitCode !== null || this.child.signalCode) throw new Error('Native gateway exited; inspect its saved log');
      try { const r = await fetch('http://127.0.0.1:18789/healthz', {signal: AbortSignal.timeout(1000)}); if (r.ok) return; } catch {}
      await delay(500);
    }
    this.child.kill('SIGKILL');
    await this.exited;
    throw new Error('Native gateway did not become ready; process terminated');
  }
  async stop() {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    const result = await Promise.race([this.exited, delay(25000).then(() => {throw new Error('Gateway shutdown unconfirmed');})]);
    if (result.code !== 0) throw new Error('Gateway shutdown did not exit cleanly');
    this.child = undefined;
  }
  async diagnostics() {
    const logs = {};
    for (const name of ['gateway.log', 'last-command-error.log']) { try {logs[name] = (await readFile(`${this.root}/${name}`, 'utf8')).slice(-32768).replaceAll(this.env.OPENCLAW_GATEWAY_TOKEN, '[redacted]');} catch {logs[name] = '';}}
    return logs;
  }
  async rpc(method, params, timeout = 60000) {
    const raw = await run(this.config.runtime, ['gateway', 'call', method, '--json', '--timeout', String(timeout), '--params', JSON.stringify(params)], this.env, timeout + 5000);
    return JSON.parse(raw);
  }
}
