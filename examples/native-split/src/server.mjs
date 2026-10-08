import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {settings, SOURCE_COMMIT} from './config.mjs';
import {Controller} from './controller.mjs';
import {proxyHttp, proxyUpgrade} from './proxy.mjs';

export function authorized(req, token) {
  const value = req.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  return !!token && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {bytes += chunk.length; if (bytes > 512 * 1024) throw Object.assign(new Error('Request too large'), {statusCode: 413}); chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const json = (res, code, data) => {res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data));};
export function createServer({getController, controlToken, port = 18789}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/_split/health' && req.method === 'GET') return json(res, 200, {service: 'native-split', sourceCommit: SOURCE_COMMIT, configured: !!controlToken});
      if (req.url?.startsWith('/_split/')) {
        if (!authorized(req, controlToken)) return json(res, 401, {error: 'Unauthorized'});
        const control = getController();
        if (req.url === '/_split/diagnostics' && req.method === 'GET') return json(res, 200, await control.gateway?.diagnostics() ?? {});
        if (req.url === '/_split/status' && req.method === 'GET') return json(res, 200, control.status());
        if (req.url === '/_split/bootstrap' && req.method === 'POST') return json(res, 200, await control.bootstrap());
        if (req.url === '/_split/session' && req.method === 'POST') return json(res, 200, await control.session());
        if (req.url === '/_split/proof' && req.method === 'POST') return json(res, 200, await control.proof(await body(req)));
        if (req.url === '/_split/message' && req.method === 'POST') return json(res, 200, await control.message(await body(req)));
        return json(res, 404, {error: 'Unknown control route'});
      }
      const control = getController(); await control.owner.assertCurrent();
      if (!['enrolling', 'ready'].includes(control.phase)) return json(res, 503, {error: 'Gateway not accepting connections'});
      proxyHttp(req, res, port);
    } catch (error) {
      console.error(JSON.stringify({event: 'request-failed', name: error.name, status: error.statusCode ?? 500}));
      if (!res.headersSent) json(res, error.statusCode ?? 500, {error: 'Native split request failed; inspect the preserved runtime evidence. No automatic retry or takeover.'});
      else res.destroy();
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (req.url?.startsWith('/_split/')) throw new Error('No control upgrades');
      const control = getController(); await control.owner.assertCurrent();
      if (!['enrolling', 'ready'].includes(control.phase)) throw new Error('Gateway not accepting connections');
      proxyUpgrade(req, socket, head, port);
    } catch {socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');}
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let controller;
  const server = createServer({controlToken: process.env.SPLIT_CONTROL_TOKEN, getController: () => controller ??= new Controller(settings())});
  server.listen(Number(process.env.PORT ?? 80), '0.0.0.0');
  process.once('SIGTERM', () => {server.close(); controller?.close().catch(() => console.error('Gateway shutdown unconfirmed; owner reservation retained'));});
}
