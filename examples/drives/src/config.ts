import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const VERSION = '2026.9.6';
export const IMAGE_REPOSITORY = 'openclaw-foundation/openclaw/openclaw';
export const MOUNT = '/data';
export const STATE = `${MOUNT}/openclaw`;
export const PREPARED_MARKER = '.vercel-drive-prepared.json';
export const PREPARED_CONTENT = JSON.stringify({ format: 1, uid: 1000, gid: 1000 });
export const WORKSPACE = `${STATE}/workspace`;
export const REGION = 'iad1' as const;
export const DRIVE_BYTES = 1024 ** 3;

export interface Settings {
  credentials: { token: string; projectId: string; teamId: string };
  gatewayKey: string;
  image: string;
  model: string;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv, now = Date.now(), minimumValidityMs = 45 * 60_000): Settings {
  const token = env.VERCEL_OIDC_TOKEN;
  assert(token, 'Missing VERCEL_OIDC_TOKEN. Run vercel env pull, then load the resulting file.');
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()); }
  catch { throw new Error('VERCEL_OIDC_TOKEN is not a readable JWT.'); }
  assert(Number.isSafeInteger(minimumValidityMs) && minimumValidityMs > 0, 'Invalid credential validity budget.');
  assert(typeof claims.exp === 'number' && claims.exp * 1000 > now + minimumValidityMs,
    `VERCEL_OIDC_TOKEN is expired or has less than ${minimumValidityMs / 60_000} minutes left. Refresh local credentials with vercel env pull.`);
  assert(typeof claims.project_id === 'string' && claims.project_id.startsWith('prj_'), 'OIDC project scope is missing.');
  assert(typeof claims.owner_id === 'string' && claims.owner_id.startsWith('team_'), 'OIDC team scope is missing.');
  assert(env.AI_GATEWAY_API_KEY?.trim(), 'Missing AI_GATEWAY_API_KEY for the synthetic model turns.');
  const image = env.OPENCLAW_IMAGE ?? `${IMAGE_REPOSITORY}:${VERSION}`;
  assert(image === `${IMAGE_REPOSITORY}:${VERSION}` ||
    new RegExp(`^${IMAGE_REPOSITORY}@sha256:[a-f0-9]{64}$`).test(image),
    `Use the official ${VERSION} image tag or a digest from that release; moving tags are not accepted.`);
  const model = env.OPENCLAW_MODEL ?? 'openai/gpt-5.4';
  assert(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(model), 'Invalid AI Gateway model identifier.');
  return { credentials: { token, projectId: claims.project_id, teamId: claims.owner_id },
    gatewayKey: env.AI_GATEWAY_API_KEY!, image, model };
}

export function agentDriveName(agent: string): string {
  assert(/^[a-z0-9][a-z0-9-]{0,47}$/.test(agent), 'Agent name must be 1–48 lowercase letters, numbers or hyphens.');
  return `openclaw-${agent}`;
}

export function sessionId(label: string): string {
  assert(label.length > 0 && label.length <= 128, 'Conversation label must be 1–128 characters.');
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}

export function assertVersion(stdout: string): void {
  const version = stdout.match(/^(?:OpenClaw\s+)?(\d{4}\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/m)?.[1];
  assert.equal(version, VERSION, 'The running image does not match the verified OpenClaw release.');
}

export function redact(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]');
}
