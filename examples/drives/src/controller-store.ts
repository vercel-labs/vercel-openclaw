import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export interface MessageInput { agent: string; requestId: string; conversation: string; message: string }
export interface Resource { name: string; sessionId?: string; image?: string; kind: 'initializer' | 'workload' }
export interface Job {
  requestId: string; agent: string; conversation: string; fingerprint: string; owner: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted'; phase: string;
  createdAt: number; updatedAt: number; resources: Resource[];
  drive?: { name: string; id?: string };
  reply?: string; nativeSessionId?: string; error?: string;
}
export interface ReadyAgent { fingerprint: string; image?: string }
export type Admission = { kind: 'accepted'; job: Job; ready: ReadyAgent | null } |
  { kind: 'duplicate'; job: Job } | { kind: 'busy' | 'conflict' | 'configuration-conflict' };
export interface Store {
  begin(input: MessageInput, runtimeFingerprint: string): Promise<Admission>;
  patch(agent: string, requestId: string, owner: string, patch: Partial<Job>, finish?: boolean): Promise<Job>;
  ready(agent: string, owner: string, value: ReadyAgent): Promise<void>;
  get(agent: string, requestId: string): Promise<Job | null>;
}
export interface Redis { command(args: Array<string | number>): Promise<unknown> }

export class RedisRest implements Redis {
  constructor(private url: string, private token: string) {
    const endpoint = new URL(url);
    assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password, 'Redis REST requires HTTPS without embedded credentials.');
    assert(token, 'Redis REST token is required.');
  }
  async command(args: Array<string | number>): Promise<unknown> {
    const response = await fetch(this.url, { method: 'POST', headers: {
      authorization: `Bearer ${this.token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) });
    assert(response.ok, `Redis HTTP ${response.status}.`);
    const body = await response.json() as { result?: unknown; error?: string };
    assert(!body.error, 'Redis rejected the command.');
    return body.result;
  }
}

const NOW = `local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)\n`;
const RECONCILE = `
if job.status == 'running' and redis.call('GET',KEYS[2]) ~= job.owner then
  job.status='interrupted'; job.error='Controller ownership expired. Outcome uncertain; request was not replayed.'; job.updatedAt=now
  redis.call('SET',KEYS[1],cjson.encode(job),'KEEPTTL')
end
`;
const CLAIM = NOW + `
local saved=redis.call('GET',KEYS[1])
if saved then
  local job=cjson.decode(saved)
  if job.fingerprint ~= ARGV[1] then return cjson.encode({kind='conflict'}) end
  ${RECONCILE}
  return cjson.encode({kind='duplicate',job=job})
end
local ready=redis.call('GET',KEYS[3])
if ready and cjson.decode(ready).fingerprint ~= ARGV[2] then return cjson.encode({kind='configuration-conflict'}) end
if not redis.call('SET',KEYS[2],ARGV[3],'NX','PX',ARGV[4]) then return cjson.encode({kind='busy'}) end
local job=cjson.decode(ARGV[5]); job.createdAt=now; job.updatedAt=now
redis.call('SET',KEYS[1],cjson.encode(job),'EX',ARGV[6])
return cjson.encode({kind='accepted',job=job,ready=ready and cjson.decode(ready) or cjson.null})
`;
const UPDATE = NOW + `
if redis.call('GET',KEYS[2]) ~= ARGV[1] then return false end
local saved=redis.call('GET',KEYS[1]); if not saved then return false end
local job=cjson.decode(saved); if job.owner ~= ARGV[1] or job.status ~= 'running' then return false end
local patch=cjson.decode(ARGV[2]); for k,v in pairs(patch) do job[k]=v end; job.updatedAt=now
redis.call('SET',KEYS[1],cjson.encode(job),'KEEPTTL')
if ARGV[3]=='finish' then redis.call('DEL',KEYS[2]) end
return cjson.encode(job)
`;
const GET = NOW + `
local saved=redis.call('GET',KEYS[1]); if not saved then return false end
local job=cjson.decode(saved)
${RECONCILE}
return cjson.encode(job)
`;
const READY = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2]); return 1`;

export class RedisStore implements Store {
  constructor(readonly redis: Redis, readonly namespace: string, readonly leaseMs = 30 * 60_000) {
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(namespace), 'Invalid controller namespace.');
    assert(Number.isSafeInteger(leaseMs) && leaseMs > 0, 'Invalid lease duration.');
  }
  keys(agent: string, requestId = ''): [string, string, string] {
    const scope = createHash('sha256').update(`${this.namespace}:${agent}`).digest('hex');
    const base = `openclaw-drives:controller:{${scope}}`;
    return [`${base}:request:${requestId}`, `${base}:owner`, `${base}:ready`];
  }
  async begin(input: MessageInput, runtimeFingerprint: string): Promise<Admission> {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const job = { requestId: input.requestId, agent: input.agent, conversation: input.conversation,
      fingerprint, owner: randomUUID(), status: 'running', phase: 'admitted', resources: [] };
    const result = await this.redis.command(['EVAL', CLAIM, 3, ...this.keys(input.agent, input.requestId),
      fingerprint, runtimeFingerprint, job.owner, this.leaseMs, JSON.stringify(job), 7 * 24 * 3600]);
    return this.decode(result) as Admission;
  }
  async patch(agent: string, requestId: string, owner: string, patch: Partial<Job>, finish = false): Promise<Job> {
    assert(!['owner','fingerprint','agent','requestId','createdAt'].some(k => k in patch), 'Immutable request identity.');
    const result = await this.redis.command(['EVAL', UPDATE, 2, ...this.keys(agent, requestId).slice(0,2), owner, JSON.stringify(patch), finish ? 'finish' : 'keep']);
    assert(result, 'Controller ownership lost; refusing further work.');
    return this.decode(result) as Job;
  }
  async ready(agent: string, owner: string, value: ReadyAgent): Promise<void> {
    const keys = this.keys(agent);
    const result = await this.redis.command(['EVAL', READY, 2, keys[1], keys[2], owner, JSON.stringify(value)]);
    assert.equal(result, 1, 'Controller ownership lost before saving agent setup.');
  }
  async get(agent: string, requestId: string): Promise<Job | null> {
    const result = await this.redis.command(['EVAL', GET, 2, ...this.keys(agent, requestId).slice(0,2)]);
    return result ? this.decode(result) as Job : null;
  }
  private decode(value: unknown): unknown {
    assert(typeof value === 'string', 'Invalid Redis response.');
    const result = JSON.parse(value);
    // Redis Lua encodes empty arrays as objects; keep the wire representation stable.
    const job = result.job ?? result;
    if (job.resources && !Array.isArray(job.resources) && Object.keys(job.resources).length === 0) job.resources = [];
    return result;
  }
}
