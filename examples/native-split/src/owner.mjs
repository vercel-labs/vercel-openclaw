import {randomUUID} from 'node:crypto';

export class Unavailable extends Error { statusCode = 503; }
export class RedisStore {
  constructor(url, token, request = fetch) { this.url = url; this.token = token; this.request = request; }
  async command(args) {
    const response = await this.request(this.url, {method: 'POST', headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(args), signal: AbortSignal.timeout(5000), redirect: 'error'});
    if (!response.ok) throw new Unavailable('Owner store unavailable');
    const data = await response.json();
    if (data.error) throw new Unavailable('Owner store rejected operation');
    return data.result;
  }
}
export class Owner {
  constructor(store, agent, id = randomUUID()) { this.store = store; this.key = `openclaw:native-split:${agent}:owner`; this.id = id; this.fenced = false; }
  async acquire() {
    if (this.fenced) throw new Unavailable('This process has stopped');
    // No TTL or automatic takeover: an expired lease would not prove the old writer stopped.
    await this.store.command(['SET', this.key, this.id, 'NX']);
    await this.assertCurrent();
  }
  async assertCurrent() {
    if (this.fenced || await this.store.command(['GET', this.key]) !== this.id) throw new Unavailable('Another gateway owns this agent; replacement requires confirmed termination');
  }
  fence() { this.fenced = true; }
}
