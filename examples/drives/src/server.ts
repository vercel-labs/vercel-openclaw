import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { settingsFromEnv } from './config.js';
import { Controller } from './controller.js';
import { RedisRest, RedisStore } from './controller-store.js';
import { createHTTPServer } from './http.js';

try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, results: { type: 'string', default: 'results/controller' } } });
  const envFile = values['env-file'] ?? (existsSync('.env.local') ? '.env.local' : undefined);
  if (envFile) loadEnvFile(resolve(envFile));
  const settings = settingsFromEnv(process.env);
  const url = process.env.KV_REST_API_URL, redisToken = process.env.KV_REST_API_TOKEN;
  assert(url && redisToken, 'KV_REST_API_URL and KV_REST_API_TOKEN are required.');
  const token = process.env.OPENCLAW_CONTROL_TOKEN;
  assert(token && token.length >= 32, 'OPENCLAW_CONTROL_TOKEN must contain at least 32 characters.');
  const namespace = process.env.OPENCLAW_CONTROLLER_NAMESPACE ?? settings.credentials.projectId;
  const store = new RedisStore(new RedisRest(url, redisToken), namespace);
  const controller = new Controller(settings, store, resolve(values.results!));
  const port = Number(process.env.OPENCLAW_CONTROLLER_PORT ?? 8787);
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid HTTP port.');
  const server = createHTTPServer(controller, token);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(JSON.stringify({ status: 'listening', url: `http://127.0.0.1:${typeof address === 'object' ? address?.port : port}` }));
  });
  const close = () => { server.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Controller setup failed.');
  process.exitCode = 1;
}
