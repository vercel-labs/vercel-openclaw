import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
import { Controller, publicJob, validateMessage } from './controller.js';
import { agentDriveName } from './config.js';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
export function handler(controller: Controller, token: string): (request: Request) => Promise<Response> {
  assert(token.length >= 32, 'OPENCLAW_CONTROL_TOKEN must contain at least 32 characters.');
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return async request => {
    if (!timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${token}`))) return json({ error: 'Unauthorized' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/requests') {
      const agent = url.searchParams.get('agent') ?? '', id = url.searchParams.get('requestId') ?? '';
      try { agentDriveName(agent); assert(/^[A-Za-z0-9_-]{1,120}$/.test(id)); }
      catch { return json({ error: 'Invalid agent or request ID' }, 400); }
      try { const job = await controller.store.get(agent, id); return job ? json({ job: publicJob(job) }) : json({ error: 'Not found' }, 404); }
      catch { return json({ error: 'Request status is unavailable' }, 503); }
    }
    if (request.method !== 'POST' || url.pathname !== '/messages') return json({ error: 'Not found' }, 404);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return json({ error: 'Expected application/json' }, 415);
    let input;
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > 32768) { await reader.cancel(); return json({ error: 'Message body too large' }, 413); }
        chunks.push(next.value);
      }
      input = validateMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { return json({ error: 'Invalid message body' }, 400); }
    try { const result = await controller.message(input); return json(result.body, result.status); }
    catch { return json({ error: 'Request admission is unavailable. Retry only with the same request ID.' }, 503); }
  };
}

export function createHTTPServer(controller: Controller, token: string) {
  const handle = handler(controller, token);
  return createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
      const response = await handle(new Request(`http://localhost${req.url}`, init));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Request failed"}'); }
  });
}
