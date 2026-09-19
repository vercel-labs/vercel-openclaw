import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AllocationJournal } from '../src/journal.ts';
import { OWNER as WORKER_OWNER } from '../src/profile.ts';
import { REQUIRED } from './codex-e2e/policy.mjs';
import { assertCodexReceipt } from './codex-e2e/receipt.mjs';
import { readAllocations } from './codex-e2e/recovery.mjs';
import { hash, OWNER, redact } from './e2e/support.mjs';

function fixture() {
  const sha = hash('synthetic proof');
  const worker = (suffix: string) => ({ name: `worker-${suffix}`, tags: { owner: WORKER_OWNER, intent: sha }, cleanup: 'stopped' });
  const task = { pid: 123, startTicks: '456', nativeExecAncestor: true, administrativeEnvironmentAbsent: true };
  const workerProcesses = [{ pid: 122, role: 'exec-server', sha256: sha, administrativeEnvironmentAbsent: true }];
  const nativeRuntime = { gatewayProcesses: [{ pid: 200, role: 'app-server', sha256: sha }], workerProcesses, task };
  const traceBytes = Buffer.from(JSON.stringify({ status: { complete: true }, events: [
    ...Array.from({ length: 3 }, () => ({ kind: 'request', method: 'chat.send' })),
    { tool: 'session_status', phase: 'result', isError: false, runHash: sha },
  ] }));
  const assertions = [
    { name: 'public-auth' }, { name: 'native-enrollment' },
    { name: 'tool-authority', proof: 'configured-dynamic-exclusions-and-concrete-isolation', exhaustiveNativeInventory: false, excludedTools: ['exec', 'process', 'gateway', 'openclaw'] },
    { name: 'codex-repair', independentCases: 8, sha256: sha, markerSha256: sha, runHash: sha },
    { name: 'workspace-reconciliation', sha256: sha, isolationSha256: sha },
    { name: 'callback', tool: 'session_status' },
    { name: 'guardrails', processes: workerProcesses, task, gatewayCanaryAbsent: true, gatewayConfigAbsent: true, gatewayReachable: true, externalDenied: true, admittedNodeMutationDenied: true, fullFirewallPolicyMatched: true },
    { name: 'cancellation', pid: 123, processGone: true, heartbeatStopped: true, beforeNaturalDeadline: true },
    { name: 'worker-loss', terminalStatus: 'error', localFallbackAbsent: true, workerCount: 1 },
    { name: 'redispatch', freshNodeIdentity: true, acceptedSha256: sha, processesResumed: false },
    { name: 'native-reclaim' },
  ];
  const inner = { status: 'passed', model: 'synthetic/model-a', missingAssertions: [], parentRunId: 'synthetic-run', packageSha256: sha, catalogSha256: sha, toolProof: 'concrete-isolation', operatorTraceSha256: hash(traceBytes), resources: [worker('first'), worker('replacement')], assertions, nativeRuntime };
  const innerBytes = Buffer.from(JSON.stringify(inner));
  const lockBytes = Buffer.from(JSON.stringify({ packages: { 'node_modules/@tokenizer/token': { version: '0.3.0' } } }));
  const installation = { receipt: { lockSha256: hash(lockBytes), packageSha256: sha } };
  const archive = { sha256: sha, build: { commit: 'synthetic-source' } };
  const artifacts = { 'runner.mjs': sha };
  const receipt = {
    ...inner, runId: inner.parentRunId, mode: 'codex', journalRecovered: true,
    projectId: 'prj_test', teamId: 'team_example', artifacts, build: archive.build,
    packageSha256: sha, workerIntent: sha, installation: installation.receipt, vmReceiptSha256: hash(innerBytes),
    assertions: [...assertions, { name: 'cleanup' }], resources: [{ name: 'gateway', tags: { owner: OWNER, run: inner.parentRunId }, cleanup: 'stopped' }, ...inner.resources],
  };
  return { receipt, expected: { innerBytes, traceBytes, lockBytes, installation, archive, artifacts, projectId: receipt.projectId, teamId: receipt.teamId, model: inner.model } };
}

test('Codex receipt binds detailed evidence to one run, installation, project and owned cleanup', () => {
  const f = fixture();
  assertCodexReceipt(f.receipt, f.expected);
  const failures = [
    (x: typeof f) => { x.receipt.artifacts = { 'runner.mjs': hash('changed') }; },
    (x: typeof f) => { x.expected.innerBytes = Buffer.from('{}'); },
    (x: typeof f) => { x.expected.traceBytes = Buffer.from('{}'); },
    (x: typeof f) => { x.expected.lockBytes = Buffer.from('other'); },
    (x: typeof f) => { x.expected.lockBytes = Buffer.from(redact(x.expected.lockBytes.toString())); },
    (x: typeof f) => { x.receipt.runId = 'different-run'; },
    (x: typeof f) => { x.expected.projectId = 'prj_other'; },
    (x: typeof f) => { x.expected.teamId = 'team_other'; },
    (x: typeof f) => { x.receipt.resources[1].cleanup = 'unconfirmed'; },
    (x: typeof f) => { x.receipt.journalRecovered = false; },
    (x: typeof f) => { x.receipt.assertions = REQUIRED.map(name => ({ name })); },
  ];
  for (const mutate of failures) { const invalid = fixture(); mutate(invalid); assert.throws(() => assertCodexReceipt(invalid.receipt, invalid.expected)); }
});

test('allocation recovery includes uncertain creates and rejects foreign journal ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovery-test-'));
  const path = join(directory, 'allocations.sqlite');
  const journal = new AllocationJournal(path);
  const name = `ocw-${'a'.repeat(40)}`;
  try {
    journal.reserve(name, 'owned-intent');
    assert.deepEqual(readAllocations(path, 'owned-intent').map(row => ({ ...row })), [{ name, intent: 'owned-intent' }]);
    assert.throws(() => readAllocations(path, 'other-intent'), /ownership mismatch/);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Codex receipt rejects a different selected model even when its full catalog is unchanged', () => {
  const f = fixture();
  f.expected.model = 'synthetic/model-b';
  assert.throws(() => assertCodexReceipt(f.receipt, f.expected), /model/);
});

function smokeFixture() {
  const f = fixture();
  const deferred = ['guardrails', 'cancellation', 'worker-loss', 'redispatch'];
  const inner = JSON.parse(f.expected.innerBytes.toString());
  inner.suite = 'basic';
  inner.toolProof = 'basic-functional';
  inner.resources = inner.resources.slice(0, 1);
  inner.assertions = inner.assertions.filter((item: { name: string }) => !deferred.includes(item.name));
  inner.assertions.find((item: { name: string }) => item.name === 'tool-authority').proof = 'configured-dynamic-exclusions-only';
  delete inner.nativeRuntime;
  const trace = JSON.parse(f.expected.traceBytes.toString());
  trace.events = [trace.events[0], trace.events.at(-1)];
  f.expected.traceBytes = Buffer.from(JSON.stringify(trace));
  inner.operatorTraceSha256 = hash(f.expected.traceBytes);
  f.expected.innerBytes = Buffer.from(JSON.stringify(inner));
  Object.assign(f.receipt, { suite: 'basic', mode: 'codex-smoke', toolProof: inner.toolProof,
    assertions: [...inner.assertions, { name: 'cleanup' }], resources: [f.receipt.resources[0], ...inner.resources],
    vmReceiptSha256: hash(f.expected.innerBytes), operatorTraceSha256: inner.operatorTraceSha256 });
  return { receipt: f.receipt, expected: { ...f.expected, suite: 'basic' } };
}

test('basic smoke requires its own suite and cannot verify as full E2E', () => {
  const f = smokeFixture();
  assertCodexReceipt(f.receipt, f.expected);
  assert.throws(() => assertCodexReceipt(f.receipt, { ...f.expected, suite: 'full' }));
  const full = fixture();
  assert.throws(() => assertCodexReceipt(full.receipt, { ...full.expected, suite: 'basic' }));
  for (const missing of ['callback', 'workspace-reconciliation', 'codex-repair', 'native-reclaim', 'cleanup']) {
    const invalid = smokeFixture();
    invalid.receipt.assertions = invalid.receipt.assertions.filter(item => item.name !== missing);
    assert.throws(() => assertCodexReceipt(invalid.receipt, invalid.expected));
  }
});
