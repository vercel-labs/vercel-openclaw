import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base = process.env.SPLIT_PUBLIC_URL;
assert(base && process.env.SPLIT_CONTROL_TOKEN, 'SPLIT_PUBLIC_URL and SPLIT_CONTROL_TOKEN required');
const headers = {Authorization: `Bearer ${process.env.SPLIT_CONTROL_TOKEN}`, 'Content-Type': 'application/json'};
if (process.env.VERCEL_OIDC_TOKEN) headers['x-vercel-trusted-oidc-idp-token'] = process.env.VERCEL_OIDC_TOKEN;
async function call(path, input) {
  const response = await fetch(new URL(path, base), {method: 'POST', headers, body: JSON.stringify(input ?? {}), redirect: 'error', signal: AbortSignal.timeout(300000)});
  assert(response.ok, `${path}: HTTP ${response.status}. Inspect; do not retry uncertain work automatically.`);
  return await response.json();
}
const ready = await call('/_split/bootstrap');
assert.equal(ready.phase, 'ready'); assert(ready.worker.sessionId && ready.deviceId);
const session = await call('/_split/session');
const marker = `split-proof-${randomUUID()}`;
const result = await call('/_split/message', {sessionKey: session.key, idempotencyKey: randomUUID(), message: `Write the exact text ${marker} to split-proof.txt in the workspace, with no trailing newline, then read it and reply with its contents.`});
assert.equal(result.completed.status, 'ok', 'Native run did not complete successfully');
const proof = await call('/_split/proof', {sessionKey: session.key});
assert.equal(proof.file, marker, 'Independent worker file read did not match');
assert.equal(proof.worker.sessionId, ready.worker.sessionId, 'Worker session changed');
assert(proof.transcript.messages?.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes(marker)), 'Gateway transcript has no matching assistant reply');
const followup = await call('/_split/message', {sessionKey: session.key, idempotencyKey: randomUUID(), message: 'Read split-proof.txt and reply with its exact contents.'});
assert.equal(followup.completed.status, 'ok');
const reused = await call('/_split/proof', {sessionKey: session.key});
assert.equal(reused.worker.sessionId, ready.worker.sessionId); assert.equal(reused.file, marker);
console.log(JSON.stringify({ready, sessionKey: session.key, marker, result, followup, proof: reused}, null, 2));
