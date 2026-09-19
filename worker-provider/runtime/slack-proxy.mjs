import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function startSlackProxy({ fetcher = fetch } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      assert(['GET', 'POST'].includes(req.method) && /^\/api\/[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9.]*$/.test(url.pathname), 'Unsupported Slack API request');
      url.searchParams.delete('token');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; assert(size <= 1024 * 1024, 'Slack request exceeds bound'); chunks.push(chunk); }
      let body = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type']?.split(';')[0];
      if (body) {
        // Bolt sends its placeholder token in the body, which outranks firewall-injected headers.
        if (type === 'application/x-www-form-urlencoded') { const form = new URLSearchParams(body); form.delete('token'); body = form.toString(); }
        else if (type === 'application/json') { const json = JSON.parse(body); assert(json && !Array.isArray(json) && typeof json === 'object'); delete json.token; body = JSON.stringify(json); }
        else throw new Error('Unsupported Slack request encoding');
      }
      const upstream = await fetcher(`https://slack.com${url.pathname}${url.search}`, {
        method: req.method, headers: type ? { 'content-type': type } : {}, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...(upstream.headers.has('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {}) });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(400); res.end('{"ok":false,"error":"slack_relay_failed"}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/api/`, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
