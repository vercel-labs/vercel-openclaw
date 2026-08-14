export interface RedisRestConfig {
  url: string;
  token: string;
}

type RedisEnvironment = Record<string, string | undefined>;

/** Resolve one complete credential pair without mixing separate integrations. */
export function resolveRedisRestConfig(
  env: RedisEnvironment = process.env,
): RedisRestConfig | undefined {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    };
  }
  return undefined;
}

interface RedisRestClientOptions extends RedisRestConfig {
  timeoutMs: number;
  label: string;
}

/** Minimal Upstash-compatible Redis REST transport shared by durable stores. */
export class RedisRestClient {
  constructor(private readonly options: RedisRestClientOptions) {}

  async command(command: Array<string | number>): Promise<unknown> {
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${this.options.label} request failed: ${response.status}`);
    }

    const body = (await response.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(`${this.options.label} error: ${body.error}`);
    return body.result;
  }
}
