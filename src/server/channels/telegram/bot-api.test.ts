import assert from "node:assert/strict";
import test from "node:test";

import {
  clampTelegramText,
  sendMessage,
  sendChatAction,
  getMe,
  setWebhook,
  setMyCommands,
  getMyCommands,
  deleteWebhook,
  TelegramApiError,
  isRetryableTelegramSendError,
} from "@/server/channels/telegram/bot-api";

// ---------------------------------------------------------------------------
// clampTelegramText
// ---------------------------------------------------------------------------

test("clampTelegramText: returns text unchanged if within limit", () => {
  assert.equal(clampTelegramText("hello", 4096), "hello");
});

test("clampTelegramText: truncates long text with ellipsis marker", () => {
  const long = "a".repeat(5000);
  const clamped = clampTelegramText(long, 4096);
  assert.equal(clamped.length, 4096);
  assert.ok(clamped.endsWith("..."));
});

test("clampTelegramText: handles zero maxLen", () => {
  assert.equal(clampTelegramText("hello", 0), "");
});

test("clampTelegramText: handles maxLen smaller than marker", () => {
  assert.equal(clampTelegramText("hello world", 2), "..");
});

// ---------------------------------------------------------------------------
// TelegramApiError
// ---------------------------------------------------------------------------

test("TelegramApiError: captures method, status, description", () => {
  const err = new TelegramApiError({
    method: "sendMessage",
    status_code: 400,
    description: "Bad Request: chat not found",
  });
  assert.equal(err.method, "sendMessage");
  assert.equal(err.status_code, 400);
  assert.equal(err.description, "Bad Request: chat not found");
  assert.equal(err.retry_after, null);
  assert.ok(err.message.includes("sendMessage"));
  assert.ok(err.message.includes("400"));
});

test("TelegramApiError: captures retry_after", () => {
  const err = new TelegramApiError({
    method: "sendMessage",
    status_code: 429,
    description: "Too Many Requests",
    retry_after: 30,
  });
  assert.equal(err.retry_after, 30);
});

// ---------------------------------------------------------------------------
// isRetryableTelegramSendError
// ---------------------------------------------------------------------------

test("isRetryableTelegramSendError: 429 is retryable", () => {
  const err = new TelegramApiError({
    method: "sendMessage",
    status_code: 429,
    description: "Too Many Requests",
  });
  assert.equal(isRetryableTelegramSendError(err), true);
});

test("isRetryableTelegramSendError: 500+ is retryable", () => {
  const err = new TelegramApiError({
    method: "sendMessage",
    status_code: 502,
    description: "Bad Gateway",
  });
  assert.equal(isRetryableTelegramSendError(err), true);
});

test("isRetryableTelegramSendError: 400 is not retryable", () => {
  const err = new TelegramApiError({
    method: "sendMessage",
    status_code: 400,
    description: "Bad Request",
  });
  assert.equal(isRetryableTelegramSendError(err), false);
});

test("isRetryableTelegramSendError: network errors are retryable", () => {
  const err = new Error("fetch failed");
  assert.equal(isRetryableTelegramSendError(err), true);

  const timeout = new Error("request timed out");
  timeout.name = "TimeoutError";
  assert.equal(isRetryableTelegramSendError(timeout), true);
});

test("isRetryableTelegramSendError: non-errors return false", () => {
  assert.equal(isRetryableTelegramSendError("string error"), false);
  assert.equal(isRetryableTelegramSendError(null), false);
});

// ---------------------------------------------------------------------------
// sendMessage – correct payload
// ---------------------------------------------------------------------------

test("sendMessage: calls Telegram API with correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";

  globalThis.fetch = async (input, init) => {
    capturedUrl = typeof input === "string" ? input : (input as Request).url;
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 42, chat: { id: 123 } },
      }),
    );
  };

  try {
    const result = await sendMessage("bot-token-123", 123, "Hello Telegram");
    assert.equal(result.message_id, 42);
    assert.equal(result.chat.id, 123);

    assert.ok(capturedUrl.includes("bot-token-123/sendMessage"));
    assert.ok(capturedUrl.startsWith("https://api.telegram.org/bot"));

    const body = JSON.parse(capturedBody);
    assert.equal(body.chat_id, 123);
    assert.equal(body.text, "Hello Telegram");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage: clamps long text before sending", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 1, chat: { id: 1 } },
      }),
    );
  };

  try {
    const longText = "x".repeat(5000);
    await sendMessage("token", 1, longText);
    const body = JSON.parse(capturedBody);
    assert.equal(body.text.length, 4096);
    assert.ok(body.text.endsWith("..."));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage: includes optional thread id and parse mode", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 7, chat: { id: 123 } },
      }),
    );
  };

  try {
    await sendMessage("token", "123", "*Hello*", {
      messageThreadId: 99,
      parseMode: "Markdown",
    });

    const body = JSON.parse(capturedBody);
    assert.equal(body.chat_id, "123");
    assert.equal(body.text, "*Hello*");
    assert.equal(body.message_thread_id, 99);
    assert.equal(body.parse_mode, "Markdown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// sendChatAction – correct payload
// ---------------------------------------------------------------------------

test("sendChatAction: calls Telegram API with correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";

  globalThis.fetch = async (input, init) => {
    capturedUrl = typeof input === "string" ? input : (input as Request).url;
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({ ok: true, result: true }),
    );
  };

  try {
    await sendChatAction("bot-token-456", 789, "typing");

    assert.ok(capturedUrl.includes("bot-token-456/sendChatAction"));
    const body = JSON.parse(capturedBody);
    assert.equal(body.chat_id, 789);
    assert.equal(body.action, "typing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// API error handling – graceful without crashing
// ---------------------------------------------------------------------------

test("sendMessage: throws TelegramApiError on API failure (does not crash)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
      { status: 400 },
    );

  try {
    await assert.rejects(
      sendMessage("token", 999, "hello"),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.status_code, 400);
        assert.ok(error.description.includes("chat not found"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getMe: returns bot user info", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: {
          id: 12345,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
        },
      }),
    );

  try {
    const me = await getMe("bot-token");
    assert.equal(me.id, 12345);
    assert.equal(me.is_bot, true);
    assert.equal(me.username, "test_bot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setWebhook: sends correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({ ok: true, result: true }),
    );
  };

  try {
    await setWebhook("token", "https://example.com/webhook", "my-secret");
    const body = JSON.parse(capturedBody);
    assert.equal(body.url, "https://example.com/webhook");
    assert.equal(body.secret_token, "my-secret");
    assert.deepEqual(body.allowed_updates, [
      "message",
      "edited_message",
      "callback_query",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleteWebhook: sends correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({ ok: true, result: true }),
    );
  };

  try {
    await deleteWebhook("token");
    const body = JSON.parse(capturedBody);
    assert.equal(body.drop_pending_updates, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setMyCommands: sends command payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ ok: true, result: true }));
  };

  try {
    await setMyCommands("token", [
      { command: "ask", description: "Ask the AI a question" },
    ]);
    const body = JSON.parse(capturedBody);
    assert.deepEqual(body.commands, [
      { command: "ask", description: "Ask the AI a question" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getMyCommands: returns command list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: [{ command: "ask", description: "Ask the AI a question" }],
      }),
    );

  try {
    const commands = await getMyCommands("token");
    assert.deepEqual(commands, [
      { command: "ask", description: "Ask the AI a question" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage: handles non-JSON error response gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Internal Server Error", { status: 500 });

  try {
    await assert.rejects(
      sendMessage("token", 1, "hello"),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.status_code, 500);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
