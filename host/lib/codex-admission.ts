import { createHash, randomUUID } from 'node:crypto';
import { RedisRestClient, resolveRedisRestConfig } from './redis-rest';

const CLAIM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'duplicate' end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', 360) == false then return 'busy' end
redis.call('SET', KEYS[1], '1', 'EX', 86400)
return 'accepted'`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export async function admitCodexEvent(name: string, eventId: string | undefined, client?: Pick<RedisRestClient, 'command'>) {
  if (!eventId || !/^[A-Za-z0-9_-]{1,160}$/.test(eventId)) throw new Error('Slack event ID required');
  if (!client) {
    const config = resolveRedisRestConfig();
    if (!config) throw new Error('Codex host requires Redis for event admission');
    client = new RedisRestClient({ ...config, timeoutMs: 1000, label: 'Codex admission' });
  }
  const scope = createHash('sha256').update(`${process.env.VERCEL_PROJECT_ID}:${name}`).digest('hex');
  const lock = `openclaw:codex:{${scope}}:lock`;
  const event = `openclaw:codex:{${scope}}:event:${eventId}`;
  const owner = randomUUID();
  const status = await client.command(['EVAL', CLAIM, 2, event, lock, owner]);
  if (!['accepted', 'duplicate', 'busy'].includes(String(status))) throw new Error('Invalid event admission result');
  return { status: status as 'accepted' | 'duplicate' | 'busy', release: async () => {
    if (status === 'accepted') await client.command(['EVAL', RELEASE, 1, lock, owner]);
  } };
}

export async function claimCodexSleep(name: string, client?: Pick<RedisRestClient, 'command'>) {
  if (!client) {
    const config = resolveRedisRestConfig();
    if (!config) throw new Error('Codex host requires Redis for sleep admission');
    client = new RedisRestClient({ ...config, timeoutMs: 1000, label: 'Codex sleep' });
  }
  const scope = createHash('sha256').update(`${process.env.VERCEL_PROJECT_ID}:${name}`).digest('hex');
  const lock = `openclaw:codex:{${scope}}:lock`;
  const owner = randomUUID();
  const claimed = await client.command(['SET', lock, owner, 'NX', 'EX', 360]);
  return { accepted: claimed === 'OK', release: async () => {
    if (claimed === 'OK') await client.command(['EVAL', RELEASE, 1, lock, owner]);
  } };
}
