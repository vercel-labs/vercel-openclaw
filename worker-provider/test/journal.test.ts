import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllocationJournal } from '../src/journal.ts';

test('restart retains create intent and prevents duplicate allocation', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ocw-journal-')), 'state.sqlite');
  const first = new AllocationJournal(path);
  assert.equal(first.reserve('worker', 'intent').created, true);
  first.close();
  const second = new AllocationJournal(path);
  assert.equal(second.reserve('worker', 'intent').created, false);
  assert.throws(() => second.reserve('worker', 'changed'), /intent changed/);
  second.transition('worker', ['creating'], 'destroying');
  second.transition('worker', ['destroying'], 'destroyed');
  assert.equal(second.reserve('worker', 'intent').allocation.phase, 'destroyed');
  assert.throws(() => second.transition('worker', ['creating'], 'active'), /authority changed/);
  second.close();
});

test('separate journal connections reserve a single operation', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ocw-journal-')), 'state.sqlite');
  const first = new AllocationJournal(path);
  const second = new AllocationJournal(path);
  assert.equal(first.reserve('worker', 'intent').created, true);
  assert.equal(second.reserve('worker', 'intent').created, false);
  first.close(); second.close();
});
