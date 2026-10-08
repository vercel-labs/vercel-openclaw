import test from 'node:test';
import assert from 'node:assert/strict';
import {Owner, RedisStore} from '../src/owner.mjs';
import {Worker} from '../src/worker.mjs';

function store() { const data = new Map(); return {data, command: async ([op, key, value, nx]) => {if (op === 'GET') return data.get(key) ?? null; assert.equal(op, 'SET'); assert.equal(nx, 'NX'); if (data.has(key)) return null; data.set(key, value); return 'OK';}}; }
test('concurrent Function instances admit exactly one owner, with no TTL takeover', async () => {
  const redis = store(); const owners = Array.from({length: 20}, (_, i) => new Owner(redis, 'agent', `instance-${i}`));
  const results = await Promise.allSettled(owners.map(x => x.acquire()));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const winner = owners[results.findIndex(x => x.status === 'fulfilled')]; winner.fence();
  await assert.rejects(new Owner(redis, 'agent').acquire(), /Another gateway/);
});
test('Redis errors and missing ownership stop operations', async () => {
  const redis = store(); const owner = new Owner(redis, 'agent'); await owner.acquire(); redis.data.clear();
  await assert.rejects(owner.assertCurrent(), /Another gateway/);
  const bad = new RedisStore('https://store.example', 'private', async () => new Response('{}', {status: 503}));
  await assert.rejects(new Owner(bad, 'agent').acquire(), /unavailable/);
});
test('parallel worker allocation starts one Sandbox; failed creation is not repeated', async () => {
  let created = 0;
  const worker = new Worker({agent: 'test', image: 'pinned', publicUrl: new URL('https://gateway.example'), model: 'test', credentials: {}}, {assertCurrent: async () => {}}, {
    Drive: {getOrCreate: async () => ({name: 'drive'})},
    Sandbox: {create: async () => {created++; throw new Error('uncertain allocation');}},
  });
  const result = await Promise.allSettled(Array.from({length: 12}, () => worker.allocate()));
  assert.equal(created, 1); assert(result.every(x => x.status === 'rejected'));
  await assert.rejects(worker.allocate(), /uncertain/); assert.equal(created, 1);
});
test('an attached Drive blocks worker creation', async () => {
  let called = false;
  const worker = new Worker({agent: 'test', credentials: {}}, {assertCurrent: async () => {}}, {Drive: {getOrCreate: async () => ({currentSessionId: 'other'})}, Sandbox: {create: async () => {called = true;}}});
  await assert.rejects(worker.allocate(), /already attached/); assert.equal(called, false);
});
