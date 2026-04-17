import IORedis from "ioredis";
import { readFileSync, unlinkSync, existsSync } from "fs";

const envPath = process.argv[2];
if (!envPath || !existsSync(envPath)) {
  console.error("usage: node release-lifecycle-lock.mjs <env-file>");
  process.exit(2);
}

const env = {};
for (const l of readFileSync(envPath, "utf8").split("\n")) {
  if (l.startsWith("#") || !l.includes("=")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"|"$/g, "");
}

const url = env.REDIS_URL ?? env.KV_URL;
if (!url) {
  console.error("no REDIS_URL/KV_URL in env file");
  process.exit(2);
}

const instanceId =
  (env.OPENCLAW_INSTANCE_ID && env.OPENCLAW_INSTANCE_ID.trim()) ||
  (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID.trim());
if (!instanceId) {
  console.error("no OPENCLAW_INSTANCE_ID or VERCEL_PROJECT_ID in env file");
  process.exit(2);
}

const prefix = `${instanceId}:`;
const locks = [
  `${prefix}lock:lifecycle`,
  `${prefix}lock:start`,
  `${prefix}lock:init`,
  `${prefix}lock:token-refresh`,
];

const redis = new IORedis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
try {
  for (const k of locks) {
    const existed = await redis.get(k);
    if (existed !== null) {
      const del = await redis.del(k);
      console.log(`DEL ${k} -> ${del} (prev token=${String(existed).slice(0, 16)}...)`);
    } else {
      console.log(`skip ${k} (not held)`);
    }
  }
  const pending = await redis.get(`${prefix}pending-operation`);
  console.log(`pending-operation: ${pending ?? "<unset>"}`);
} finally {
  await redis.quit();
}
