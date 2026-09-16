import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { IdleClock, MAX_TURN_MS } from './idle-policy.mjs';
import { prepareHostSleep } from './remote-turn.mjs';
import { redact } from '../test/e2e/support.mjs';

export function localRequest(base, token, path, body, timeoutMs = 250_000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: `${base}/runtime.sock`, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) throw new Error(`Resident ${path} refused (${res.statusCode})`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Resident request timeout')));
    req.end(JSON.stringify(body));
  });
}

function writeCredential(base, credential) {
  assert(typeof credential === 'string' && credential.trim(), 'Fresh controller credential required');
  const path = `${base}/host-credentials.json`;
  writeFileSync(`${path}.tmp`, JSON.stringify({ token: credential }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function submitResident({ base, token, input, credential }) {
  assert(token && input?.platformSessionId && input.runtimeDigest, 'Bound platform session required');
  const binding = { platformSessionId: input.platformSessionId, runtimeDigest: input.runtimeDigest };
  try { await localRequest(base, token, '/status', binding, 3000); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || input.action === 'sleep') throw error;
    const marker = `${base}/resident-session.json`;
    if (existsSync(marker)) assert(JSON.parse(readFileSync(marker, 'utf8')).platformSessionId !== input.platformSessionId, 'Resident disappeared within this session; inspect before restarting');
    if (existsSync(`${base}/runtime.sock`)) unlinkSync(`${base}/runtime.sock`);
    writeFileSync(marker, JSON.stringify(binding), { mode: 0o600 });
    writeCredential(base, credential);
    const log = openSync(`${base}/resident.log`, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [`${base}/runtime/turn.mjs`, '--daemon'], { cwd: base, env: { ...process.env, OPENCLAW_HOST_INPUT: JSON.stringify(input) }, detached: true, stdio: ['ignore', log, log] });
      child.unref();
    } finally { closeSync(log); }
    const deadline = Date.now() + 90_000;
    while (true) {
      try { await localRequest(base, token, '/status', binding, 3000); break; }
      catch (bootError) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(bootError.code) || Date.now() >= deadline) throw bootError;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }
  const result = await localRequest(base, token, input.action === 'sleep' ? '/sleep' : '/turn', { ...input, credential });
  process.stdout.write(`OPENCLAW_HOST_RESULT=${JSON.stringify(result)}\n`);
}

export async function serveResident({ base, token, input, execute, reclaim, rpc, stopGateway, gatewayHasExited, now = Date.now, fetcher = fetch, onReady = () => {}, signal, pollMs = 1000 }) {
  assert(input.sleepUrl && input.sleepCapability, 'Authenticated host sleep callback required');
  const clock = new IdleClock({ now, hardDeadlineMs: input.hardDeadlineMs, idleTimeoutMs: input.idleTimeoutMs });
  const binding = { platformSessionId: input.platformSessionId, runtimeDigest: input.runtimeDigest };
  let busy = false, sleeping, failed = false, callbackPending = false;
  let callbackCredential = existsSync(`${base}/host-credentials.json`) ? JSON.parse(readFileSync(`${base}/host-credentials.json`, 'utf8')).token : undefined;
  const events = `${base}/host-activity.json`;
  if (existsSync(events)) unlinkSync(events);
  let lastObservedActivity = 0;
  const observeActivity = () => {
    if (!existsSync(events)) return;
    const at = JSON.parse(readFileSync(events, 'utf8')).at;
    if (Number.isFinite(at) && at > lastObservedActivity) {
      lastObservedActivity = at;
      clock.lastActivityAt = Math.max(clock.lastActivityAt, at);
    }
  };
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'unauthorized' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert(size <= 2 * 1024 * 1024, 'Request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert(body.platformSessionId === binding.platformSessionId && body.runtimeDigest === binding.runtimeDigest, 'Stale resident session');
      observeActivity();
      if (req.url === '/status') return reply(200, { ...binding, ...clock.snapshot(), busy, sleeping: Boolean(sleeping), failed });
      if (busy) return reply(409, { error: 'busy' });
      if (req.url === '/sleep' && sleeping) {
        assert(gatewayHasExited(), 'Gateway exit is no longer confirmed');
        return reply(200, sleeping);
      }
      if (sleeping || failed && req.url !== '/sleep') return reply(409, { error: 'resident fenced' });
      if (!['/turn', '/sleep'].includes(req.url)) return reply(404, {});
      busy = true;
      try {
        writeCredential(base, body.credential);
        callbackCredential = body.credential;
        if (req.url === '/turn') {
          assert(clock.canStartTurn(), 'Platform session must roll over before another turn');
          const executionMs = Math.floor(Math.min(MAX_TURN_MS, body.executionDeadlineMs - now()));
          assert(Number.isFinite(executionMs) && executionMs > 0, 'Host execution deadline has elapsed');
          clock.begin();
          try {
            const result = { ...await execute({ ...body, signal: AbortSignal.timeout(executionMs) }), ...binding, idleTimeoutMs: clock.idleTimeoutMs };
            writeFileSync(`${base}/host-last-result.json`, JSON.stringify(result), { mode: 0o600 });
            reply(200, result);
          }
          catch (error) { failed = true; throw error; }
          finally { clock.end(); }
        } else {
          // Failed turns stay fenced, but must request cleanup without waiting for idle expiry.
          const reason = failed ? 'failure' : body.rollover === true && !clock.canStartTurn() ? 'deadline' : clock.reason();
          if (!reason) return reply(200, { action: 'none', ...binding });
          const work = await rpc('gateway.restart.preflight');
          assert(typeof work.safe === 'boolean', 'Unknown activity state');
          if (!work.safe) { clock.touch(); return reply(200, { action: 'busy', ...binding }); }
          await reclaim();
          const suspension = await prepareHostSleep({ rpc, requestId: `idle-${binding.platformSessionId}`, drain: reason !== 'idle' });
          await stopGateway();
          assert(gatewayHasExited(), 'Gateway exit is unconfirmed');
          unlinkSync(`${base}/host-credentials.json`);
          sleeping = { action: 'sleep', reason, ...binding, suspension, gatewayStopped: true, residentFenced: true, workerStopped: true };
          reply(200, sleeping);
        }
      } finally { busy = false; }
    } catch (error) {
      const credential = existsSync(`${base}/host-credentials.json`) ? JSON.parse(readFileSync(`${base}/host-credentials.json`, 'utf8')).token : undefined;
      writeFileSync(`${base}/host-last-error.log`, redact(error.stack ?? error, [token, credential, input.sleepCapability, process.env.VERCEL_OIDC_TOKEN]), { mode: 0o600 });
      console.error('Resident operation failed', JSON.stringify({ name: error?.name, code: error?.code }));
      reply(500, { error: 'Resident operation failed; inspect private runtime logs' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`${base}/runtime.sock`, resolve); });
  signal?.addEventListener('abort', () => server.close(), { once: true });
  onReady(clock);
  const timer = setInterval(async () => {
    if (callbackPending || busy) return;
    try {
      observeActivity();
      if (!failed && !clock.reason() && !sleeping) return;
      callbackPending = true;
      assert(callbackCredential, 'Project OIDC required for the protected sleep callback');
      const result = await fetcher(input.sleepUrl, { method: 'POST', headers: { authorization: `Bearer ${input.sleepCapability}`, 'x-vercel-trusted-oidc-idp-token': callbackCredential, 'content-type': 'application/json' }, body: JSON.stringify({ ...binding }), redirect: 'error', signal: AbortSignal.timeout(170_000) });
      if (!result.ok) console.error(`Host sleep callback returned ${result.status}`);
    } catch { console.error('Host sleep callback failed; retrying without claiming a snapshot'); }
    finally { callbackPending = false; }
  }, pollMs);
  try { await new Promise(resolve => server.once('close', resolve)); }
  finally { clearInterval(timer); }
}
