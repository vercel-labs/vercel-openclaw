type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SlackAckResult =
  | { ok: true }
  | { ok: false; skipped: true }
  | { ok: false; error: string };

/**
 * Adds a visible acknowledgement before the slower sandbox wake. This is
 * deliberately best-effort: a missing Slack scope must not drop the message.
 */
export async function addSlackAckReaction(
  rawBody: ArrayBuffer | string,
  botToken: string,
  fetcher: Fetcher = fetch,
): Promise<SlackAckResult> {
  const text =
    typeof rawBody === 'string'
      ? rawBody
      : Buffer.from(rawBody).toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, skipped: true };
  }
  const event = (payload as { event?: unknown })?.event as
    | { channel?: unknown; ts?: unknown }
    | undefined;
  if (typeof event?.channel !== 'string' || typeof event.ts !== 'string') {
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetcher('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        channel: event.channel,
        timestamp: event.ts,
        name: 'eyes',
      }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (result.ok || result.error === 'already_reacted') return { ok: true };
    return { ok: false, error: result.error ?? 'unknown_error' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
