import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { config } = JSON.parse(readFileSync(`${base}/runtime-manifest.json`));
assert(config.nativeSlack, 'Native Slack preparation is not configured');
const env = { ...process.env, HOME: `${base}/home`, OPENCLAW_STATE_DIR: `${base}/state`, OPENCLAW_CONFIG_PATH: `${base}/state/openclaw.json`,
  OPENCLAW_SKIP_CHANNELS: '1', AI_GATEWAY_API_KEY: 'brokered-by-vercel-sandbox-firewall', SLACK_BOT_TOKEN: 'xoxb-brokered-by-vercel-firewall', SLACK_SIGNING_SECRET: 'setup-only-not-used-for-intake',
  npm_config_registry: config.npmRegistry, npm_config_min_release_age: String(config.npmAge), npm_config_min_release_age_exclude: '' };
const run = args => execFileSync(process.execPath, [`${base}/node_modules/openclaw/openclaw.mjs`, ...args], { cwd: base, env, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
if (!process.argv.includes('--verify')) process.stdout.write(run(['plugins', 'install', 'npm:@openclaw/slack@2026.9.2', '--pin']));
const report = JSON.parse(run(['plugins', 'inspect', 'slack', '--json']));
assert.equal(report.plugin.trust.reason, 'trusted-official', 'Slack must load from its verified official install');
assert.equal(report.plugin.version, '2026.9.2');
assert.equal(report.plugin.trust.registryPath, `${base}/state/state/openclaw.sqlite`);
process.stdout.write(`NATIVE_SLACK_INSTALL_VERIFIED=${JSON.stringify({ version: report.plugin.version, trust: report.plugin.trust, source: report.plugin.source })}\n`);
