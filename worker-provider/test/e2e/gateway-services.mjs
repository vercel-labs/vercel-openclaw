import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createWorkerRelay, WORKER_PATH } from './worker-probe.mjs';
import { startModelFixture } from './model-fixture.mjs';

export async function startIngress({ origin, upstreamPort, port = 0, workerProbe = false, upgradeRelay }) {
  const relay = upgradeRelay ?? (workerProbe ? await createWorkerRelay() : undefined);
  const hostname = new URL(origin).host;
  const headers = req => {
    const out = { ...req.headers, host: hostname, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1' };
    delete out.forwarded;
    delete out['x-real-ip'];
    delete out['x-forwarded-host'];
    return out;
  };
  const sockets = new Set();
  const proxy = createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: headers(req) }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (req, socket, head) => {
    if (relay && req.url === (relay.path ?? WORKER_PATH)) { relay.upgrade(req, socket, head, upstreamPort, headers(req)); return; }
    const upstream = request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: headers(req) });
    upstream.on('upgrade', (res, peer, peerHead) => {
      sockets.add(peer);
      peer.on('close', () => sockets.delete(peer));
      socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` + res.rawHeaders.reduce((text, value, i, all) => i % 2 ? text : text + `${value}: ${all[i + 1]}\r\n`, '') + '\r\n');
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
      socket.on('close', () => peer.destroy());
    });
    upstream.on('response', res => { socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`); res.resume(); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, '0.0.0.0', resolve); });
  return { port: proxy.address().port, probe: request => { if (!relay) throw new Error('Worker probe is disabled'); return relay.probe(request); }, close: () => new Promise(resolve => { relay?.close(); for (const socket of sockets) socket.destroy(); proxy.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await startModelFixture({ token: process.env.E2E_MODEL_TOKEN, port: 4000, upstream: process.env.E2E_REAL_MODEL ? { model: process.env.E2E_REAL_MODEL, token: process.env.AI_GATEWAY_API_KEY } : undefined });
  const ingress = await startIngress({ origin: process.env.E2E_ORIGIN, upstreamPort: 18789, port: 3000, workerProbe: true });
  const armPath = '/vercel/sandbox/e2e/authority-arm.json';
  const resultPath = '/vercel/sandbox/e2e/authority-result.json';
  let probing = false;
  const poll = setInterval(async () => {
    if (probing || !existsSync(armPath)) return;
    probing = true;
    try {
      const request = JSON.parse(readFileSync(armPath, 'utf8'));
      renameSync(armPath, `${armPath}.consumed`);
      const proof = await ingress.probe(request);
      writeFileSync(`${resultPath}.tmp`, JSON.stringify({ ok: true, proof }), { mode: 0o600 });
    } catch {
      writeFileSync(`${resultPath}.tmp`, JSON.stringify({ ok: false, error: 'Worker authorization probe failed' }), { mode: 0o600 });
    }
    renameSync(`${resultPath}.tmp`, resultPath);
    clearInterval(poll);
  }, 100);
  process.stdout.write('E2E_SERVICES_READY\n');
  process.once('SIGTERM', async () => { clearInterval(poll); await ingress.close(); await fixture.close(); });
}
