import assert from 'node:assert/strict';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BASE } from './policy.mjs';

const stat = pid => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');

export function recordProcess(kind, pid) {
  assert(['driver', 'gateway'].includes(kind));
  writeFileSync(`${BASE}/${kind}-identity.json`, JSON.stringify({ pid, startTicks: stat(pid)[19] }), { mode: 0o600 });
}

export function readAllocations(path, intent) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const records = db.prepare('SELECT name,intent FROM allocations').all();
    assert(records.length <= 2, 'Worker allocation budget exceeded');
    for (const record of records) {
      assert.equal(record.intent, intent, 'Allocation journal ownership mismatch');
      assert(/^ocw-[a-f0-9]{40}$/.test(record.name), 'Invalid allocation name');
    }
    return records;
  } finally { db.close(); }
}

export async function freezeAndRecover(intent) {
  assert.equal(process.platform, 'linux');
  for (const kind of ['driver', 'gateway']) {
    const path = `${BASE}/${kind}-identity.json`;
    if (!existsSync(path)) {
      assert(kind !== 'driver', 'Driver identity is unavailable; allocation outcome is uncertain');
      continue;
    }
    const identity = JSON.parse(readFileSync(path));
    assert(Number.isInteger(identity.pid) && identity.pid > 1);
    if (!existsSync(`/proc/${identity.pid}`)) continue;
    assert.equal(stat(identity.pid)[19], identity.startTicks, 'Process identity changed before recovery');
    assert.equal(readlinkSync(`/proc/${identity.pid}/cwd`), BASE, 'Process cwd changed before recovery');
    process.kill(identity.pid, 'SIGSTOP');
    const deadline = Date.now() + 3000;
    while (existsSync(`/proc/${identity.pid}`) && !['T', 't', 'Z'].includes(stat(identity.pid)[0])) {
      assert(Date.now() < deadline, 'Process did not freeze before journal recovery');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const path = `${BASE}/state/vercel-worker/allocations.sqlite`;
  const pending = existsSync(`${BASE}/vm-results/receipt.json`) && JSON.parse(readFileSync(`${BASE}/vm-results/receipt.json`)).pendingWorkerIntent;
  assert(existsSync(path) || !pending, 'Pending allocation has no recoverable journal');
  return existsSync(path) ? readAllocations(path, intent) : [];
}
