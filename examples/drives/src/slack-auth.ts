import { createHmac, timingSafeEqual } from 'node:crypto';
import { bodyHash, type SlackEvent, type SlackPolicy } from './slack-intake.js';
import type { Redis } from './controller-store.js';

export class PermanentSlackError extends Error {}
export interface QueuedSlackEvent extends SlackEvent { signature: string }
export function envelopeKey(namespace: string, event: Pick<SlackEvent,'teamId'|'eventId'>) {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(namespace))throw Error('Invalid Slack namespace.');
  return bodyHash(`${namespace}:${event.teamId}:${event.eventId}`);
}
function signature(event: SlackEvent, namespace: string, secret: string | undefined) {
  if(!secret || secret.length<32)throw Error('Slack queue signing key is not configured.');
  return createHmac('sha256',secret).update(JSON.stringify(['slack-queue-v1',namespace,event.eventId,event.teamId,event.sha256])).digest();
}
export function signQueuedEvent(event: SlackEvent, namespace: string, secret: string | undefined): QueuedSlackEvent {
  return {...event,signature:signature(event,namespace,secret).toString('hex')};
}
export function verifyQueuedEvent(payload: QueuedSlackEvent, namespace: string, secret: string | undefined): void {
  if(!payload || typeof payload.rawBody!=='string' || typeof payload.signature!=='string' || !/^[a-f0-9]{64}$/.test(payload.signature) ||
    payload.sha256!==bodyHash(payload.rawBody))throw new PermanentSlackError('Invalid signed queue envelope.');
  if(!timingSafeEqual(signature(payload,namespace,secret),Buffer.from(payload.signature,'hex')))throw new PermanentSlackError('Queue envelope signature is invalid.');
}
export async function verifyEnvelopeBinding(redis: Redis, namespace: string, event: SlackEvent) {
  const stored=await redis.command(['GET',`openclaw-drives:slack-envelope:${envelopeKey(namespace,event)}`]);
  if(stored!==event.sha256)throw new PermanentSlackError('Slack event has no matching durable ingress record.');
}
export async function verifySlackIdentity(token: string, policy: SlackPolicy, fetcher = fetch) {
  const r=await fetcher('https://slack.com/api/auth.test',{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('Slack identity check is unavailable.');
  const identity=await r.json() as {ok?:boolean;team_id?:string;user_id?:string};
  if(!identity.ok)throw Error('Slack token could not be authenticated.');
  if(identity.team_id!==policy.teamId || identity.user_id!==policy.botUserId)throw new PermanentSlackError('Slack connector does not match the configured workspace and bot.');
}
export function slackRetry(error: unknown) {
  return error instanceof PermanentSlackError ? { acknowledge: true as const } : { afterSeconds: 15 };
}
