import { createServer } from 'node:http';

export function completion(payload) {
  const messages = payload.messages ?? [];
  const userIndex = messages.findLastIndex(message => message.role === 'user');
  const text = JSON.stringify(messages[userIndex]?.content ?? '');
  const name = text.match(/E2E_CASE=(success|loss|cancel|restored|authority)/)?.[1];
  if (!name) throw new Error('Unknown fixture request');
  const finished = messages.slice(userIndex + 1).some(message => message.role === 'tool');
  if (finished) return { delta: { role: 'assistant', content: `E2E_FINISHED_${name}` }, reason: 'stop' };
  if (!payload.tools?.some(tool => tool.function?.name === 'exec')) throw new Error('Native turn did not offer exec');
  return {
    delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_e2e_${name}`, type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command: `node e2e-task.mjs ${name}`, yieldMs: 120000, timeoutSeconds: 110 }) } }] },
    reason: 'tool_calls',
  };
}

/** @param {{token: string, port?: number, upstream?: {model: string, token: string}, fetchUpstream?: typeof fetch}} options */
export async function startModelFixture({ token, port = 0, upstream, fetchUpstream = fetch }) {
  if (!token) throw new Error('Model endpoint requires authentication');
  let count = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      let body = '';
      for await (const part of req) {
        body += part;
        if (Buffer.byteLength(body) > (upstream ? 65_536 : 2_000_000)) throw new Error('Oversize model request');
      }
      if (++count > (upstream ? 4 : 16)) throw new Error('Model-call budget exhausted');
      const payload = JSON.parse(body);
      if (upstream) {
        if (payload.model !== upstream.model) throw new Error('Unexpected model');
        delete payload.max_completion_tokens;
        const response = await fetchUpstream('https://ai-gateway.vercel.sh/v1/chat/completions', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Bearer ${upstream.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, max_tokens: 1024, n: 1 }),
        });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        if (response.body) for await (const chunk of response.body) res.write(chunk);
        res.end();
        return;
      }
      const result = completion(payload);
      const chunk = (delta, finish_reason) => ({ id: `chatcmpl-e2e-${count}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(chunk(result.delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, result.reason), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Fixture contract rejected request' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, port: server.address().port, count: () => count, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
