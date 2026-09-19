type NativeSlackPolicy = { teamId: string; channels: string[]; users: string[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = (value: unknown, pattern: RegExp): value is string[] => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && pattern.test(id));

export function nativeSlackAllowed(body: unknown, rawPolicy = process.env.OPENCLAW_NATIVE_SLACK_CONFIG): boolean {
  const policy: unknown = JSON.parse(rawPolicy ?? 'null');
  if (!object(policy) || typeof policy.teamId !== 'string' || !/^T[A-Z0-9]+$/.test(policy.teamId) ||
      !ids(policy.channels, /^[CG][A-Z0-9]+$/) || !ids(policy.users, /^[UW][A-Z0-9]+$/)) {
    throw new Error('Native Slack admission policy is not configured');
  }
  const { teamId, channels, users } = policy as NativeSlackPolicy;
  if (!object(body) || body.type !== 'event_callback' || body.team_id !== teamId ||
      typeof body.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.event_id) || !object(body.event)) return false;
  const event = body.event;
  return event.type === 'app_mention' && !event.bot_id && !event.bot_profile && !event.subtype &&
    typeof event.channel === 'string' && channels.includes(event.channel) &&
    typeof event.user === 'string' && users.includes(event.user) &&
    typeof event.ts === 'string' && /^\d+\.\d+$/.test(event.ts) &&
    (event.thread_ts === undefined || (typeof event.thread_ts === 'string' && /^\d+\.\d+$/.test(event.thread_ts))) &&
    typeof event.text === 'string' && Boolean(event.text.trim()) && event.text.length <= 40_000;
}
