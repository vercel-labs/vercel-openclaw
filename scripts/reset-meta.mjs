import IORedis from "ioredis";
import { readFileSync } from "fs";

const lines = readFileSync(".env.local", "utf8").split("\n");
const env = { ...process.env };
for (const l of lines) {
  if (l.startsWith("#") || !l.includes("=")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"|"$/g, "");
}

function getOpenclawInstanceId() {
  const raw = env.OPENCLAW_INSTANCE_ID;
  if (raw == null) {
    return "openclaw-single";
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("OPENCLAW_INSTANCE_ID must not be blank.");
  }
  if (trimmed.includes(":")) {
    throw new Error("OPENCLAW_INSTANCE_ID must not contain ':'.");
  }

  return trimmed;
}

const url = env.REDIS_URL ?? env.KV_URL;
if (!url) {
  throw new Error("Set REDIS_URL (or KV_URL) in .env.local to reset meta.");
}

const targetMetaKey = `${getOpenclawInstanceId()}:meta`;

const redis = new IORedis(url, { lazyConnect: false });
console.log("Target key:", targetMetaKey);
const raw = await redis.get(targetMetaKey);
console.log("Raw type:", typeof raw);
console.log("Raw value (first 200):", JSON.stringify(raw).slice(0, 200));

const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
if (!meta) {
  console.log("No metadata found — nothing to reset");
  await redis.quit();
  process.exit(0);
}

console.log("Current sandboxId:", meta.sandboxId);
console.log("Current status:", meta.status);
console.log("Current snapshotId:", meta.snapshotId);

meta.sandboxId = null;
meta.snapshotId = null;
meta.status = "uninitialized";
meta.lastError = null;
meta.portUrls = {};

await redis.set(targetMetaKey, JSON.stringify(meta));
console.log("Reset to stopped — will create fresh v2 sandbox on next ensure");
await redis.quit();
