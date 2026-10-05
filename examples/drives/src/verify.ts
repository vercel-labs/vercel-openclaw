import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeDrive } from './initialize.js';
import { AgentRun, type Inventory } from './runtime.js';
import { sessionId, PREPARED_MARKER, PREPARED_CONTENT, STATE, WORKSPACE, VERSION, type Settings } from './config.js';
import { assertNativeMemory } from './openclaw.js';
import { digest, Receipt } from './receipt.js';

export function assertInventory(before: Inventory, after: Inventory): void {
  assert(Object.keys(before).length > 0, 'Cannot verify an empty state inventory.');
  assert.deepEqual(after, before, 'Fresh sandbox did not recover the exact saved state.');
}

export function assertRecall(reply: string, expected: string, label: string): void {
  assert.equal(reply.trim(), expected, `${label}: reply must contain only the original marker.`);
}

export async function verifyRestart(settings: Settings, receipt: Receipt): Promise<Record<string, unknown>> {
  const run = randomBytes(6).toString('hex');
  const agent = `verify-${run}`;
  const conversation = sessionId(`verify-${run}-conversation`);
  const freshConversation = sessionId(`verify-${run}-memory-only`);
  const history = `history-${randomBytes(12).toString('hex')}`;
  const memory = `memory-${randomBytes(12).toString('hex')}`;
  const file = `file-${randomBytes(12).toString('hex')}\n`;
  const initializer = await initializeDrive(settings, agent, receipt);
  const a = await AgentRun.attach(settings, agent, receipt);
  const firstInventory = await a.inventory();
  assert.deepEqual(firstInventory, { [PREPARED_MARKER]: {sha256: digest(PREPARED_CONTENT), bytes: Buffer.byteLength(PREPARED_CONTENT)} }, 'Acceptance test requires only the initial preparation marker.');
  await a.start();
  const first = await a.turn(conversation, [
    `For this synthetic test, remember this conversation-only marker: ${history}. Do not write that marker to any file.`,
    `Use the write tool to create ${WORKSPACE}/MEMORY.md with exactly this UTF-8 content:`,
    JSON.stringify(`Restart memory marker: ${memory}\n`),
    `Use the write tool to create ${WORKSPACE}/restart-proof.txt with exactly this UTF-8 content:`,
    JSON.stringify(file),
    'Reply only READY after both writes succeed.',
  ].join('\n'));
  assert.equal(first.harness, 'openclaw', 'Native harness identity was not reported.');
  assert(first.promptReport?.tools?.entries, 'Missing actual tool catalog in prompt report.');
  assert(first.promptReport.tools.entries.every(tool => ['read', 'write'].includes(tool.name)), 'Unexpected tool exposed in bounded acceptance run.');
  const memoryBefore = await a.readWorkspaceFile('MEMORY.md');
  const fileBefore = await a.readWorkspaceFile('restart-proof.txt');
  assert.equal(memoryBefore.toString(), `Restart memory marker: ${memory}\n`, 'Agent did not write the expected memory.');
  assert.equal(fileBefore.toString(), file, 'Agent did not write the expected project file.');
  const warm = await a.turn(conversation, 'What was the conversation-only marker I gave you? Reply with only the exact marker.');
  assertRecall(warm.text, history, 'Warm conversation recall');
  assert.equal(warm.sessionId, first.sessionId, 'Warm turn used a different OpenClaw session.');
  await a.quiesce();
  const before = await a.inventory();
  receipt.event('checkpoint-inventory', { statePath: STATE, files: before });
  await a.stop();
  const b = await AgentRun.attach(settings, agent, receipt, { image: a.sandbox.image });
  assert.notEqual(a.sandbox.name, b.sandbox.name, 'Must create a new sandbox.');
  assert.notEqual(a.sandbox.currentSession().sessionId, b.sandbox.currentSession().sessionId, 'Must create a new VM session.');
  assert.equal(a.drive.driveId, b.drive.driveId, 'Must reuse the same Drive.');
  assertInventory(before, await b.inventory());
  await b.start();
  assert.deepEqual(await b.readWorkspaceFile('MEMORY.md'), memoryBefore);
  assert.deepEqual(await b.readWorkspaceFile('restart-proof.txt'), fileBefore);
  const recalledHistory = await b.turn(conversation, 'What was the conversation-only marker I gave you? Reply with only the exact marker.');
  assertRecall(recalledHistory.text, history, 'Conversation recall');
  assert.equal(recalledHistory.sessionId, first.sessionId, 'Restart did not resume the durable OpenClaw conversation.');
  const recalledMemory = await b.turn(freshConversation,
    'From your loaded memory, what is the Restart memory marker? Reply with only its value. Do not use tools.');
  assertRecall(recalledMemory.text, memory, 'Memory recall in a fresh conversation');
  assert.notEqual(recalledMemory.sessionId, first.sessionId, 'Memory test must use a fresh conversation.');
  assertNativeMemory(recalledMemory);
  await b.quiesce();
  await b.stop();
  return { initializer, release: VERSION, image: b.sandbox.image, drive: b.drive.name,
    sandboxes: [a.sandbox.name, b.sandbox.name],
    sessionIds: [a.sandbox.currentSession().sessionId, b.sandbox.currentSession().sessionId],
    checks: { distinctVMs: true, sameDrive: true, sandboxSnapshotsDisabled: true, exactStateInventory: true,
      exactMemoryBytes: true, exactProjectBytes: true, conversationRecall: true, nativeMemoryInjectionInNewConversation: true,
      cleanShutdown: true, detachedAfterStop: true },
    hashes: { memory: digest(memoryBefore), projectFile: digest(fileBefore) },
    notTested: ['abrupt crash recovery', 'interrupted turn continuation', 'automatic semantic memory search',
      'dependency caching', 'Codex remote execution', 'Slack', 'multi-user isolation', 'runtime upgrades'],
  };
}
