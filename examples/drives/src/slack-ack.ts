import type { SlackEvent } from './slack-intake.js';

type SlackAckError =
  | 'invalid_event' | 'missing_token' | 'missing_scope' | 'invalid_auth'
  | 'token_expired' | 'token_revoked' | 'not_authed' | 'no_permission'
  | 'channel_not_found' | 'message_not_found' | 'ratelimited'
  | 'http_error' | 'slack_error' | 'invalid_response' | 'transport_error' | 'timeout';

export type SlackAckResult =
  | { ok: true; alreadyReacted: boolean }
  | { ok: false; error: SlackAckError };

const reportableErrors = new Set<SlackAckError>([
  'missing_scope', 'invalid_auth', 'token_expired', 'token_revoked',
  'not_authed', 'no_permission', 'channel_not_found', 'message_not_found', 'ratelimited',
]);

/** Call only after durable admission, authentication and the allowed-envelope check. */
export async function acknowledgeSlack(
  token: string,
  event: Pick<SlackEvent, 'channelId' | 'messageTs'>,
  { fetcher = fetch }: { fetcher?: typeof fetch } = {},
): Promise<SlackAckResult> {
  if (typeof token !== 'string' || !token.trim()) return { ok: false, error: 'missing_token' };
  if (!event || typeof event.channelId !== 'string' || !event.channelId.trim() ||
      typeof event.messageTs !== 'string' || !/^\d+\.\d+$/.test(event.messageTs)) {
    return { ok: false, error: 'invalid_event' };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bound the whole operation, including a stalled body or a fetcher ignoring abort.
  const deadline = new Promise<SlackAckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: 'timeout' });
      controller.abort();
    }, 2_000);
  });
  const request = async (): Promise<SlackAckResult> => {
    try {
      const response = await fetcher('https://slack.com/api/reactions.add', {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: event.channelId, timestamp: event.messageTs, name: 'eyes' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, error: response.status === 429 ? 'ratelimited' : 'http_error' };
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { return { ok: false, error: 'invalid_response' }; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'invalid_response' };
      }
      const result = data as { ok?: unknown; error?: unknown };
      if (result.ok === true) return { ok: true, alreadyReacted: false };
      if (result.ok !== false) return { ok: false, error: 'invalid_response' };
      if (result.error === 'already_reacted') return { ok: true, alreadyReacted: true };
      // Never return response text, arbitrary Slack errors or thrown exception messages.
      const error = typeof result.error === 'string' && reportableErrors.has(result.error as SlackAckError)
        ? result.error as SlackAckError : 'slack_error';
      return { ok: false, error };
    } catch {
      return { ok: false, error: controller.signal.aborted ? 'timeout' : 'transport_error' };
    }
  };
  try { return await Promise.race([deadline, request()]); }
  finally { clearTimeout(timer); }
}
