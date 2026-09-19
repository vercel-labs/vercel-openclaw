import { createHmac, timingSafeEqual } from 'node:crypto';

export function sleepCapability(name: string, platformSessionId: string, runtimeDigest: string, key = process.env.OPENCLAW_GATEWAY_TOKEN) {
  if (!key || !name || !platformSessionId || !/^[a-f0-9]{64}$/.test(runtimeDigest)) throw new Error('Incomplete sleep binding');
  return createHmac('sha256', key).update(JSON.stringify(['openclaw-sleep-v1', name, platformSessionId, runtimeDigest])).digest('hex');
}

export function authorizeSleep(authorization: string | null, name: string, platformSessionId: string, runtimeDigest: string) {
  const expected = Buffer.from(`Bearer ${sleepCapability(name, platformSessionId, runtimeDigest)}`);
  const supplied = Buffer.from(authorization ?? '');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function sleepUrl(env: Record<string, string | undefined> = process.env) {
  const url = new URL(env.OPENCLAW_CODEX_SLEEP_URL ?? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/api/codex/sleep`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname === 'undefined' || url.pathname !== '/api/codex/sleep') throw new Error('Public HTTPS Codex sleep callback required');
  return url.toString();
}
