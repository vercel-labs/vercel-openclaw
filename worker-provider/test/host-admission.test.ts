import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { registerHostAdmission } from '../src/host-admission.ts';

test('native Slack cannot run before exact remote placement admission, and delivery is observed separately', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ocw-admission-')), 'admission.json');
  const hooks = new Map<string, Function>();
  registerHostAdmission({ on: (name: string, handler: Function) => hooks.set(name, handler) } as never, path);
  const run = hooks.get('before_dispatch')!;
  const ctx = { sessionKey: 'agent:main:slack:channel:c123:thread:123.456', messageId: '123.456', senderId: 'U123' };
  assert.equal(run(ctx).handled, true);
  assert(!existsSync(join(path, '..', 'host-activity.json')));
  const admission = { ...ctx, eventId: 'Ev1', expiresAt: Date.now() + 10000 };
  writeFileSync(path, JSON.stringify(admission));
  assert.equal(run({ ...ctx, sessionKey: 'other' }).handled, true);
  assert.equal(run({ ...ctx, senderId: 'other' }).handled, true);
  assert.equal(run({ ...ctx, messageId: 'other' }).handled, true);
  assert.equal(run(ctx).handled, false);
  hooks.get('message_sent')!({ success: true, messageId: 'reply', content: 'not retained' }, { channelId: 'slack', sessionKey: 'other' });
  let events = readFileSync(`${path}.events`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(item => item.type), ['admitted']);
  hooks.get('message_sent')!({ success: true, messageId: 'reply', content: 'not retained' }, { channelId: 'slack', sessionKey: ctx.sessionKey });
  events = readFileSync(`${path}.events`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(item => item.type), ['admitted', 'delivered']);
  assert(!readFileSync(`${path}.events`, 'utf8').includes('not retained'));
  writeFileSync(path, JSON.stringify({ ...admission, expiresAt: 0 }));
  assert.equal(run(ctx).handled, true);
});

test('model and tool activity refresh the resident clock without recording message text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocw-activity-'));
  const hooks = new Map<string, Function>();
  registerHostAdmission({ on: (name: string, handler: Function) => hooks.set(name, handler) } as never, join(dir, 'admission.json'));
  for (const hook of ['llm_input', 'llm_output', 'agent_end', 'before_tool_call', 'after_tool_call']) {
    hooks.get(hook)!({ text: 'private' }, {});
    const activity = JSON.parse(readFileSync(join(dir, 'host-activity.json'), 'utf8'));
    assert.deepEqual(Object.keys(activity), ['at']);
    assert(Number.isFinite(activity.at));
  }
  assert(!hooks.has('health') && !hooks.has('tick'));
});
