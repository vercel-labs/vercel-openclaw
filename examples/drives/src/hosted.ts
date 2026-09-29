import { getVercelOidcTokenSync } from '@vercel/oidc';
import { timingSafeEqual, createHash } from 'node:crypto';
import { settingsFromEnv } from './config.js';
import { Controller } from './controller.js';
import { RedisRest, RedisStore } from './controller-store.js';
import { handler } from './http.js';

type Factory = (env: NodeJS.ProcessEnv) => Promise<(request: Request) => Promise<Response>>;
export function hostedHandler(options: {
  env?: NodeJS.ProcessEnv;
  token?: () => string;
  factory?: Factory;
} = {}) {
  const env = options.env ?? process.env;
  const factory: Factory = options.factory ?? (async requestEnv => {
    const settings = settingsFromEnv(requestEnv, Date.now(), 15 * 60_000);
    const store = new RedisStore(new RedisRest(requestEnv.KV_REST_API_URL!, requestEnv.KV_REST_API_TOKEN!),
      requestEnv.OPENCLAW_CONTROLLER_NAMESPACE ?? settings.credentials.projectId);
    const controller = new Controller(settings, store, '/tmp/openclaw-drives');
    return handler(controller, requestEnv.OPENCLAW_CONTROL_TOKEN!);
  });
  return async (request: Request): Promise<Response> => {
    const token = env.OPENCLAW_CONTROL_TOKEN;
    if (!token || token.length < 32) return Response.json({ error: 'Controller is not configured' }, { status: 503 });
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${token}`))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
      const requestEnv = { ...env, VERCEL_OIDC_TOKEN: (options.token ?? getVercelOidcTokenSync)() };
      const url = new URL(request.url);
      if (url.pathname === '/api/messages') url.pathname = '/messages';
      if (url.pathname === '/api/requests') url.pathname = '/requests';
      return await (await factory(requestEnv))(new Request(url, request));
    } catch {
      return Response.json({ error: 'Controller is unavailable. Retry only with the same request ID.' },
        { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  };
}
