const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_TEXT_LEN = 4096;
export const TELEGRAM_MAX_CAPTION_LEN = 1024;
const TELEGRAM_TRUNCATION_MARKER = "...";
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

type TelegramSendMessageResult = {
  message_id: number;
  chat: { id: number };
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
};

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status_code: number;
  readonly description: string;
  readonly retry_after: number | null;

  constructor(opts: {
    method: string;
    status_code: number;
    description: string;
    retry_after?: number;
  }) {
    super(`Telegram ${opts.method} failed (${opts.status_code}): ${opts.description}`);
    this.name = "TelegramApiError";
    this.method = opts.method;
    this.status_code = opts.status_code;
    this.description = opts.description;
    this.retry_after = opts.retry_after ?? null;
  }
}

export function clampTelegramText(text: string, maxLen = TELEGRAM_MAX_TEXT_LEN): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= TELEGRAM_TRUNCATION_MARKER.length) {
    return TELEGRAM_TRUNCATION_MARKER.slice(0, maxLen);
  }
  return `${text.slice(0, maxLen - TELEGRAM_TRUNCATION_MARKER.length)}${TELEGRAM_TRUNCATION_MARKER}`;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("socket")
  );
}

export function isRetryableTelegramSendError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    return error.status_code === 429 || error.status_code >= 500;
  }
  return isLikelyNetworkError(error);
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  let payload: TelegramApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as TelegramApiResponse<T>;
  } catch {
    payload = null;
  }

  if (!payload || !payload.ok || payload.result === undefined) {
    const statusCode = typeof payload?.error_code === "number" ? payload.error_code : response.status;
    const description =
      typeof payload?.description === "string"
        ? payload.description
        : `HTTP ${response.status}`;
    const retryAfter =
      typeof payload?.parameters?.retry_after === "number"
        ? payload.parameters.retry_after
        : undefined;
    throw new TelegramApiError({
      method,
      status_code: statusCode,
      description,
      retry_after: retryAfter,
    });
  }

  return payload.result;
}

export async function getMe(botToken: string): Promise<TelegramUser> {
  return callTelegramApi<TelegramUser>(botToken, "getMe");
}

export async function setWebhook(
  botToken: string,
  url: string,
  secretToken: string,
): Promise<void> {
  await callTelegramApi(botToken, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(botToken: string): Promise<void> {
  await callTelegramApi(botToken, "deleteWebhook", { drop_pending_updates: false });
}

export async function sendChatAction(
  botToken: string,
  chatId: number | string,
  action: string,
): Promise<void> {
  await callTelegramApi(botToken, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

export async function sendMessage(
  botToken: string,
  chatId: number | string,
  text: string,
): Promise<TelegramSendMessageResult> {
  return callTelegramApi<TelegramSendMessageResult>(botToken, "sendMessage", {
    chat_id: chatId,
    text: clampTelegramText(text),
  });
}

type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
};

export async function getFile(
  botToken: string,
  fileId: string,
): Promise<TelegramFile> {
  return callTelegramApi<TelegramFile>(botToken, "getFile", { file_id: fileId });
}

export async function downloadFile(
  botToken: string,
  filePath: string,
): Promise<Buffer> {
  const url = `${TELEGRAM_API_BASE}/file/bot${botToken}/${filePath}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new TelegramApiError({
      method: "downloadFile",
      status_code: response.status,
      description: `HTTP ${response.status}`,
    });
  }

  return Buffer.from(await response.arrayBuffer());
}

export type TelegramPhotoInput =
  | { kind: "url"; url: string }
  | { kind: "buffer"; buffer: Buffer; filename: string; mimeType: string };

export async function sendPhoto(
  botToken: string,
  chatId: number | string,
  photo: TelegramPhotoInput,
  caption?: string,
): Promise<TelegramSendMessageResult> {
  if (photo.kind === "url") {
    return callTelegramApi<TelegramSendMessageResult>(botToken, "sendPhoto", {
      chat_id: chatId,
      photo: photo.url,
      ...(caption ? { caption: clampTelegramText(caption, TELEGRAM_MAX_CAPTION_LEN) } : {}),
    });
  }

  const formData = new FormData();
  formData.set("chat_id", String(chatId));
  formData.set(
    "photo",
    new Blob([Uint8Array.from(photo.buffer)], { type: photo.mimeType }),
    photo.filename,
  );
  if (caption) {
    formData.set("caption", clampTelegramText(caption, TELEGRAM_MAX_CAPTION_LEN));
  }

  const apiUrl = `${TELEGRAM_API_BASE}/bot${botToken}/sendPhoto`;
  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(15_000),
  });

  let payload: TelegramApiResponse<TelegramSendMessageResult> | null = null;
  try {
    payload = (await response.json()) as TelegramApiResponse<TelegramSendMessageResult>;
  } catch {
    payload = null;
  }

  if (!payload || !payload.ok || payload.result === undefined) {
    const statusCode = typeof payload?.error_code === "number" ? payload.error_code : response.status;
    const description =
      typeof payload?.description === "string"
        ? payload.description
        : `HTTP ${response.status}`;
    const retryAfter =
      typeof payload?.parameters?.retry_after === "number"
        ? payload.parameters.retry_after
        : undefined;
    throw new TelegramApiError({
      method: "sendPhoto",
      status_code: statusCode,
      description,
      retry_after: retryAfter,
    });
  }

  return payload.result;
}
