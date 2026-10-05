import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SLACK_BODY_LIMIT = 1024 * 1024;
export interface SlackPolicy { teamId: string; appId: string; channelId: string; userId: string; botUserId: string }
export interface SlackEvent {
  rawBody: string; sha256: string; eventId: string; teamId: string;
  channelId: string; userId: string; messageTs: string; threadTs: string;
}
export const bodyHash = (body: string): string => createHash('sha256').update(body).digest('hex');
export function slackPolicy(raw: string | undefined): SlackPolicy {
  const p = JSON.parse(raw ?? 'null');
  assert(p && /^T[A-Z0-9]+$/.test(p.teamId) && /^A[A-Z0-9]+$/.test(p.appId) &&
    /^[CG][A-Z0-9]+$/.test(p.channelId) && /^[UW][A-Z0-9]+$/.test(p.userId) &&
    /^[UW][A-Z0-9]+$/.test(p.botUserId), 'Explicit Slack test policy is required.');
  return p;
}
export function parseSlackEnvelope(rawBody: string, policy: SlackPolicy): SlackEvent | null {
  assert(Buffer.byteLength(rawBody) <= SLACK_BODY_LIMIT, 'Slack envelope is too large.');
  const b = JSON.parse(rawBody), e = b?.event;
  if (b?.type !== 'event_callback' || b.team_id !== policy.teamId || b.api_app_id !== policy.appId ||
    e?.type !== 'app_mention' || e.channel !== policy.channelId || e.user !== policy.userId ||
    e.bot_id || e.bot_profile || e.subtype) return null;
  assert(typeof b.event_id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(b.event_id), 'Invalid Slack event ID.');
  assert(typeof e.ts === 'string' && /^\d+\.\d+$/.test(e.ts), 'Invalid Slack timestamp.');
  const thread = e.thread_ts ?? e.ts;
  assert(typeof thread === 'string' && /^\d+\.\d+$/.test(thread), 'Invalid Slack thread.');
  assert(typeof e.text === 'string' && e.text.trim() && e.text.length <= 40_000, 'Invalid Slack text.');
  if (!e.text.includes(`<@${policy.botUserId}>`)) return null;
  return { rawBody, sha256: bodyHash(rawBody), eventId: b.event_id, teamId: b.team_id,
    channelId: e.channel, userId: e.user, messageTs: e.ts, threadTs: thread };
}
export function slackIntake(options: {
  policy: () => SlackPolicy;
  verify: (request: Request, rawBody: string) => Promise<unknown>;
  enqueue: (event: SlackEvent) => Promise<void>;
}) {
  return async (request: Request): Promise<Response> => {
    const result = (status: number, body: object) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return result(405, { error: 'Method not allowed' });
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return result(415, { error: 'Expected application/json' });
    let rawBody: string;
    try {
      const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > SLACK_BODY_LIMIT) { await reader.cancel(); return result(413, { error: 'Slack envelope too large' }); }
        chunks.push(next.value);
      }
      rawBody = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch { return result(400, { error: 'Invalid request body' }); }
    try { await options.verify(request, rawBody); }
    catch { return result(401, { error: 'Unauthorized' }); }
    let policy: SlackPolicy;
    try { policy = options.policy(); }
    catch { return result(503, { error: 'Slack test policy is not configured' }); }
    let event: SlackEvent | null;
    try { event = parseSlackEnvelope(rawBody, policy); }
    catch { return result(400, { error: 'Invalid Slack envelope' }); }
    if (!event) return result(200, { ok: true, ignored: true });
    try { await options.enqueue(event); }
    catch { return result(503, { error: 'Slack event was not acknowledged; retry delivery' }); }
    return result(200, { ok: true, eventId: event.eventId, sha256: event.sha256 });
  };
}
