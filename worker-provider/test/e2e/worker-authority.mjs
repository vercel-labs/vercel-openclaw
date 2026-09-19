import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export async function probeOperatorAuthority(origin) {
  const root = join(homedir(), '.openclaw-vercel-worker');
  const runtimes = readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(runtimes.length, 1, 'Expected exactly one bootstrapped runtime');
  const state = join(root, 'state');
  const db = new DatabaseSync(join(state, 'state/openclaw.sqlite'), { readOnly: true });
  let tokens;
  try {
    tokens = db.prepare("SELECT DISTINCT token FROM device_auth_tokens WHERE role = 'node' UNION SELECT DISTINCT token FROM gateway_origin_device_tokens WHERE role = 'node'").all();
  } finally { db.close(); }
  assert(tokens.length > 0, 'Native node credential was not found');
  const require = createRequire(join(root, runtimes[0], 'package.json'));
  const { callGatewayFromCli } = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/gateway-runtime')));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = state;
  const denied = {};
  try {
    for (const method of ['config.get', 'config.patch']) {
      for (const { token } of tokens) {
        let rejected = false;
        try {
          await callGatewayFromCli(method, { url: origin.replace('https:', 'wss:'), token, json: true, timeout: '10000' },
            method === 'config.patch' ? { raw: '{"tools":{"elevated":{"enabled":true}}}', baseHash: '0'.repeat(64) } : {},
            { progress: false, sharedStateMode: 'read-only' });
        } catch (error) {
          rejected = /unauthorized|device token mismatch|token_mismatch|role mismatch|missing scope|pairing required/i.test(error.message);
        }
        assert(rejected, `${method} did not return an explicit authorization rejection`);
      }
      denied[method] = true;
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
  return denied;
}
