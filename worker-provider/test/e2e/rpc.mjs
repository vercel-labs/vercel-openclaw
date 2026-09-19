import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

const { method, params, url, scopes, timeout = 30_000 } = JSON.parse(process.env.E2E_RPC_REQUEST);
try {
  const result = await callGatewayFromCli(method, {
    url, token: process.env.E2E_OPERATOR_TOKEN, timeout: String(timeout), json: true,
  }, params, { progress: false, sharedStateMode: 'read-only', ...(scopes ? { scopes } : {}) });
  process.stdout.write(`E2E_RPC_RESULT=${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`E2E_RPC_RESULT=${JSON.stringify({ ok: false, code: error.gatewayCode, message: error.message })}\n`);
  process.exitCode = 1;
}
