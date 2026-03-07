const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_REQUEST_TIMEOUT_MS = 15_000;
const ERROR_BODY_PREVIEW_LENGTH = 200;

type TriggerTypingOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

type SendChannelMessageOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  allowedMentionsUserId?: string;
};

export async function triggerTyping(
  channelId: string,
  botToken: string,
  options: TriggerTypingOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DISCORD_REQUEST_TIMEOUT_MS;

  const response = await fetchFn(`${DISCORD_API_BASE}/channels/${channelId}/typing`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 204) {
    return;
  }

  const body = await response.text().catch(() => "");
  const detail = body.slice(0, ERROR_BODY_PREVIEW_LENGTH);
  throw new Error(
    detail.length > 0
      ? `discord_trigger_typing_failed status=${response.status} body=${detail}`
      : `discord_trigger_typing_failed status=${response.status}`,
  );
}

export async function sendChannelMessage(
  channelId: string,
  botToken: string,
  content: string,
  options: SendChannelMessageOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DISCORD_REQUEST_TIMEOUT_MS;
  const body: {
    content: string;
    allowed_mentions?: {
      users: string[];
      parse: string[];
    };
  } = {
    content,
  };

  if (options.allowedMentionsUserId) {
    body.allowed_mentions = {
      users: [options.allowedMentionsUserId],
      parse: [],
    };
  }

  return fetchFn(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
