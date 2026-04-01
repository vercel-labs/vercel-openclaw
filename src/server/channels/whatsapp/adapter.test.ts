import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import {
  createWhatsAppAdapter,
  extractWhatsAppMessageId,
  isWhatsAppSignatureValid,
} from "@/server/channels/whatsapp/adapter";

const CONFIG = {
  enabled: true,
  configuredAt: Date.now(),
  phoneNumberId: "123456789",
  accessToken: "wa-access-token",
  verifyToken: "wa-verify-token",
  appSecret: "wa-app-secret",
};

test("isWhatsAppSignatureValid accepts a valid sha256 HMAC signature", () => {
  const rawBody = JSON.stringify({ hello: "world" });
  const digest = crypto.createHmac("sha256", CONFIG.appSecret).update(rawBody).digest("hex");

  assert.equal(
    isWhatsAppSignatureValid(CONFIG.appSecret, rawBody, `sha256=${digest}`),
    true,
  );
  assert.equal(
    isWhatsAppSignatureValid(CONFIG.appSecret, rawBody, "sha256=deadbeef"),
    false,
  );
});

test("createWhatsAppAdapter extracts inbound text messages", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const result = await adapter.extractMessage({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123456789" },
              contacts: [{ profile: { name: "Test User" }, wa_id: "15551234567" }],
              messages: [
                {
                  id: "wamid.abc123",
                  from: "15551234567",
                  type: "text",
                  text: { body: "hello whatsapp" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  assert.equal(result.message.text, "hello whatsapp");
  assert.equal(result.message.from, "15551234567");
  assert.equal(result.message.messageId, "wamid.abc123");
  assert.equal(result.message.phoneNumberId, "123456789");
  assert.equal(result.message.name, "Test User");
});

test("createWhatsAppAdapter skips statuses-only payloads", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const result = await adapter.extractMessage({
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.abc123" }] } }] }],
  });

  assert.deepEqual(result, { kind: "skip", reason: "no_messages" });
});

test("extractWhatsAppMessageId returns the first inbound message id", () => {
  assert.equal(
    extractWhatsAppMessageId({
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.1" }] } }] }],
    }),
    "wamid.1",
  );
});

test("createWhatsAppAdapter buildGatewayMessages formats history plus user message", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const messages = await adapter.buildGatewayMessages?.({
    text: "hello whatsapp",
    from: "15551234567",
    messageId: "wamid.abc123",
    phoneNumberId: "123456789",
    history: [{ role: "assistant", content: "prior reply" }],
  });

  assert.deepEqual(messages, [
    { role: "assistant", content: "prior reply" },
    { role: "user", content: "hello whatsapp" },
  ]);
});

test("createWhatsAppAdapter getSessionKey uses sender wa_id", () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  assert.equal(
    adapter.getSessionKey?.({
      text: "hello whatsapp",
      from: "15551234567",
      messageId: "wamid.abc123",
      phoneNumberId: "123456789",
    }),
    "whatsapp:dm:15551234567",
  );
});

test("createWhatsAppAdapter sendReply posts outbound message", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.sent1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReply(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      "reply",
    );

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.to, "15551234567");
    assert.equal(body.text.body, "reply");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter sendBootMessage sends starting message", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.boot1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    const handle = await adapter.sendBootMessage?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      "🦞 Waking up\u2026 one moment.",
    );

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.text.body, "🦞 Waking up\u2026 one moment.");
    await handle?.update("ignored");
    await handle?.clear();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter startProcessingIndicator marks message as read immediately and stops cleanly", async () => {
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ messaging_product: "whatsapp" });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    const indicator = await adapter.startProcessingIndicator?.({
      text: "hi",
      from: "15551234567",
      messageId: "wamid.input",
      phoneNumberId: CONFIG.phoneNumberId,
    });

    assert.ok(indicator, "startProcessingIndicator should return an indicator");
    assert.equal(bodies.length, 1, "should fire first pulse immediately");

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.status, "read");
    assert.equal(body.message_id, "wamid.input");

    await indicator?.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// sendReplyRich — rich media delivery
// ---------------------------------------------------------------------------

test("sendReplyRich sends text-only reply without media via sendReply", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.text1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      { text: "Just text, no media." },
    );

    assert.equal(bodies.length, 1);
    const body = JSON.parse(bodies[0]!);
    assert.equal(body.type, "text");
    assert.equal(body.text.body, "Just text, no media.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich delivers inline audio as native WhatsApp media (upload + send)", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isFormData = init?.body instanceof FormData;
    calls.push({ url, body: isFormData ? "FormData" : JSON.parse(String(init?.body ?? "{}")) });

    // Media upload response
    if (url.includes("/media")) {
      return Response.json({ id: "media_upload_id_1" });
    }
    // Message send response
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.media1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      {
        text: "Here is the audio.",
        media: [
          {
            type: "audio",
            source: {
              kind: "data",
              mimeType: "audio/mpeg",
              base64: "SUQzBAAAAAAA",
              filename: "answer.mp3",
            },
          },
        ],
      },
    );

    // Should send text first, then upload media, then send media message.
    assert.equal(calls.length, 3, `expected 3 API calls, got ${calls.length}`);

    // 1. Text message
    const textCall = calls[0]!;
    assert.equal((textCall.body as { type?: string }).type, "text");
    assert.equal(
      ((textCall.body as { text?: { body?: string } }).text as { body?: string })?.body,
      "Here is the audio.",
    );

    // 2. Media upload
    assert.ok(calls[1]!.url.includes("/media"), "second call should be media upload");
    assert.equal(calls[1]!.body, "FormData");

    // 3. Media send — uses uploaded media id
    const mediaCall = calls[2]!;
    assert.equal((mediaCall.body as { type?: string }).type, "audio");
    assert.deepEqual((mediaCall.body as { audio?: unknown }).audio, { id: "media_upload_id_1" });

    // Verify NO call body contains "[inline " placeholder text
    for (const call of calls) {
      const bodyStr = JSON.stringify(call.body);
      assert.equal(bodyStr.includes("[inline "), false, `Found "[inline " in API call: ${bodyStr}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich delivers URL image as native WhatsApp media", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ body: unknown }> = [];

  globalThis.fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.img1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      {
        text: "Check this out.",
        media: [
          {
            type: "image",
            source: {
              kind: "url",
              url: "https://example.com/photo.jpg",
            },
          },
        ],
      },
    );

    assert.equal(calls.length, 2, "text + image send");

    const imgCall = calls[1]!;
    assert.equal((imgCall.body as { type?: string }).type, "image");
    assert.deepEqual(
      (imgCall.body as { image?: unknown }).image,
      { link: "https://example.com/photo.jpg" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich gracefully degrades when media upload fails", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isFormData = init?.body instanceof FormData;

    // Fail media uploads
    if (url.includes("/media")) {
      return new Response(
        JSON.stringify({ error: { message: "upload failed", code: 100 } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    calls.push({ url, body: isFormData ? "FormData" : JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.fallback1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      {
        text: "Here is a file.",
        media: [
          {
            type: "file",
            source: {
              kind: "data",
              mimeType: "application/pdf",
              base64: "JVBERi0x",
              filename: "report.pdf",
            },
          },
        ],
      },
    );

    // Text message + graceful degradation message (upload failed)
    assert.equal(calls.length, 2);

    const fallbackCall = calls[1]!;
    const fallbackText = ((fallbackCall.body as { text?: { body?: string } }).text as { body?: string })?.body ?? "";

    // Must NOT contain "[inline " placeholder
    assert.equal(fallbackText.includes("[inline "), false, `Found "[inline " in fallback: ${fallbackText}`);
    // Should mention the filename or type
    assert.ok(
      fallbackText.includes("report.pdf") || fallbackText.includes("could not be delivered"),
      `Fallback should describe limitation: ${fallbackText}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich rethrows retryable media upload failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url.includes("/media")) {
      return new Response(
        JSON.stringify({ error: { message: "temporary outage", code: 1 } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.retryable1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    assert.ok(adapter.sendReplyRich, "sendReplyRich must be defined");
    await assert.rejects(
      adapter.sendReplyRich(
        {
          text: "hi",
          from: "15551234567",
          messageId: "wamid.input",
          phoneNumberId: CONFIG.phoneNumberId,
        },
        {
          text: "Here is an image.",
          media: [
            {
              type: "image",
              source: {
                kind: "data",
                mimeType: "image/png",
                base64: "iVBOR",
                filename: "chart.png",
              },
            },
          ],
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof RetryableSendError);
        return true;
      },
    );

    assert.equal(calls.length, 1, "should not send degradation text for retryable failures");
    const body = calls[0]?.body as { type?: string };
    assert.equal(body?.type, "text", "only the initial text message should be sent before retryable failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich delivers inline video as native WhatsApp media", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isFormData = init?.body instanceof FormData;
    calls.push({ url, body: isFormData ? "FormData" : JSON.parse(String(init?.body ?? "{}")) });

    if (url.includes("/media")) {
      return Response.json({ id: "media_video_id" });
    }
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.vid1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      {
        text: "",
        media: [
          {
            type: "video",
            source: {
              kind: "data",
              mimeType: "video/mp4",
              base64: "AAAA",
              filename: "demo.mp4",
            },
          },
        ],
      },
    );

    // No text (empty), so: upload + media send = 2 calls
    assert.equal(calls.length, 2);

    const mediaCall = calls[1]!;
    assert.equal((mediaCall.body as { type?: string }).type, "video");
    assert.deepEqual((mediaCall.body as { video?: unknown }).video, { id: "media_video_id" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendReplyRich never emits [inline placeholder for any media type", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/media")) {
      return Response.json({ id: "media_id_generic" });
    }
    const body = init?.body instanceof FormData ? null : JSON.parse(String(init?.body ?? "{}"));
    if (body?.text?.body) {
      sentTexts.push(body.text.body);
    }
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.multi1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReplyRich?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      {
        text: "Results attached.",
        media: [
          { type: "image", source: { kind: "data", mimeType: "image/png", base64: "iVBOR", filename: "chart.png" } },
          { type: "audio", source: { kind: "data", mimeType: "audio/mpeg", base64: "SUQz", filename: "voice.mp3" } },
          { type: "video", source: { kind: "data", mimeType: "video/mp4", base64: "AAAA", filename: "clip.mp4" } },
          { type: "file", source: { kind: "data", mimeType: "application/pdf", base64: "JVBERi0x", filename: "doc.pdf" } },
        ],
      },
    );

    for (const text of sentTexts) {
      assert.equal(text.includes("[inline "), false, `Found "[inline " in sent text: "${text}"`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter sendReply throws RetryableSendError on rate limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "rate limited",
          code: 4,
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await assert.rejects(
      adapter.sendReply(
        {
          text: "hi",
          from: "15551234567",
          messageId: "wamid.input",
          phoneNumberId: CONFIG.phoneNumberId,
        },
        "reply",
      ),
      (error) => {
        assert.ok(error instanceof RetryableSendError);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
