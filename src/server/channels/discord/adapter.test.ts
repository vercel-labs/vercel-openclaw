import {
  generateKeyPairSync,
  sign as signBuffer,
} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordAdapter,
  verifyDiscordRequestSignature,
} from "@/server/channels/discord/adapter";

const DISCORD_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function exportRawPublicKeyHex(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  assert.ok(Buffer.isBuffer(spkiDer));
  const buffer = spkiDer as Buffer;
  assert.equal(buffer.subarray(0, DISCORD_ED25519_SPKI_PREFIX.length).equals(DISCORD_ED25519_SPKI_PREFIX), true);
  return buffer.subarray(DISCORD_ED25519_SPKI_PREFIX.length).toString("hex");
}

test("verifyDiscordRequestSignature validates ed25519-signed interaction payloads", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = exportRawPublicKeyHex(publicKey);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 2, data: { name: "ask" } });
  const signature = signBuffer(null, Buffer.from(`${timestamp}${rawBody}`), privateKey).toString("hex");

  assert.equal(
    verifyDiscordRequestSignature(rawBody, signature, timestamp, publicKeyHex),
    true,
  );
  assert.equal(
    verifyDiscordRequestSignature(rawBody, `${signature.slice(0, -2)}aa`, timestamp, publicKeyHex),
    false,
  );
});

test("createDiscordAdapter extracts slash command text", async () => {
  const adapter = createDiscordAdapter({
    publicKey: "a".repeat(64),
    applicationId: "app-123",
    botToken: "bot-token",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    id: "interaction-1",
    type: 2,
    token: "interaction-token",
    channel_id: "channel-1",
    application_id: "app-123",
    member: {
      user: { id: "user-1" },
    },
    data: {
      name: "ask",
      options: [
        {
          name: "text",
          value: "hello discord",
        },
      ],
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello discord");
  assert.equal(result.message.channelId, "channel-1");
  assert.equal(result.message.userId, "user-1");
});
