import http from 'node:http';
import {pipeline} from 'node:stream';

function headers(req, upgrade) {
  const result = {...req.headers, host: '127.0.0.1:18789', 'x-forwarded-for': '192.0.2.1', 'x-forwarded-proto': 'https'};
  for (const name of Object.keys(result)) if (name.startsWith('x-vercel-') || name.startsWith('x-split-')) delete result[name];
  if (!upgrade) { delete result.connection; delete result.upgrade; }
  return result;
}
export function proxyHttp(req, res, port = 18789) {
  const upstream = http.request({hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: headers(req, false)}, response => {
    res.writeHead(response.statusCode, response.headers);
    pipeline(response, res, () => {});
  });
  upstream.on('error', () => {if (!res.headersSent) res.writeHead(502); res.end();});
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {if (!res.writableFinished) upstream.destroy();});
  pipeline(req, upstream, () => {});
}
export function proxyUpgrade(req, socket, head, port = 18789) {
  const upstream = http.request({hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: headers(req, true)});
  upstream.on('upgrade', (response, remote, remoteHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + response.rawHeaders.reduce((s, value, i, all) => i % 2 ? s : s + `${value}: ${all[i + 1]}\r\n`, '') + '\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
  });
  upstream.on('response', response => {socket.end(`HTTP/1.1 ${response.statusCode} Upstream refused\r\nConnection: close\r\n\r\n`);response.resume();});
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}
