import IORedis from "ioredis";
import { readFileSync, existsSync } from "fs";

function parseArgs(argv) {
  const out = { envFile: null, instanceId: null, redisUrl: null, dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--instance-id" || a === "-i") {
      out.instanceId = argv[++i] ?? null;
    } else if (a.startsWith("--instance-id=")) {
      out.instanceId = a.slice("--instance-id=".length);
    } else if (a === "--redis-url") {
      out.redisUrl = argv[++i] ?? null;
    } else if (a.startsWith("--redis-url=")) {
      out.redisUrl = a.slice("--redis-url=".length);
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      console.error(`unknown flag: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  out.envFile = positional[0] ?? null;
  return out;
}

function printUsage() {
  console.error(
    `usage: node release-lifecycle-lock.mjs [env-file] [--instance-id <id>] [--redis-url <url>] [--dry-run]\n` +
      `\n` +
      `  env-file         Path to .env file with REDIS_URL/KV_URL and optionally OPENCLAW_INSTANCE_ID/VERCEL_PROJECT_ID\n` +
      `  --instance-id    Override instance id (takes precedence over env file)\n` +
      `  --redis-url      Override Redis URL (takes precedence over env file)\n` +
      `  --dry-run        Report held locks without deleting\n` +
      `\n` +
      `Env vars: OPENCLAW_INSTANCE_ID, VERCEL_PROJECT_ID, REDIS_URL, KV_URL can be read from process env\n` +
      `when no env-file is supplied.`,
  );
}

function loadEnvFile(path) {
  const env = {};
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    env[l.slice(0, i).trim()] = l
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return env;
}

const args = parseArgs(process.argv.slice(2));

const fileEnv = args.envFile
  ? existsSync(args.envFile)
    ? loadEnvFile(args.envFile)
    : (() => {
        console.error(`env file not found: ${args.envFile}`);
        process.exit(2);
      })()
  : {};

const redisUrl =
  args.redisUrl ?? fileEnv.REDIS_URL ?? fileEnv.KV_URL ?? process.env.REDIS_URL ?? process.env.KV_URL;
if (!redisUrl) {
  console.error("missing Redis URL: pass --redis-url, set REDIS_URL/KV_URL, or include in env file");
  process.exit(2);
}

const instanceId =
  (args.instanceId && args.instanceId.trim()) ||
  (fileEnv.OPENCLAW_INSTANCE_ID && fileEnv.OPENCLAW_INSTANCE_ID.trim()) ||
  (fileEnv.VERCEL_PROJECT_ID && fileEnv.VERCEL_PROJECT_ID.trim()) ||
  (process.env.OPENCLAW_INSTANCE_ID && process.env.OPENCLAW_INSTANCE_ID.trim()) ||
  (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID.trim());
if (!instanceId) {
  console.error(
    "missing instance id: pass --instance-id, set OPENCLAW_INSTANCE_ID/VERCEL_PROJECT_ID, or include in env file",
  );
  process.exit(2);
}

const prefix = `${instanceId}:`;
const locks = [
  `${prefix}lock:lifecycle`,
  `${prefix}lock:start`,
  `${prefix}lock:init`,
  `${prefix}lock:token-refresh`,
];

console.error(`instance: ${instanceId}${args.dryRun ? " (dry-run)" : ""}`);

const redis = new IORedis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
try {
  for (const k of locks) {
    const existed = await redis.get(k);
    const ttl = existed !== null ? await redis.ttl(k) : -2;
    if (existed === null) {
      console.log(`skip ${k} (not held)`);
      continue;
    }
    const token = String(existed).slice(0, 16);
    if (args.dryRun) {
      console.log(`HELD ${k} (token=${token}..., ttl=${ttl}s)`);
    } else {
      const del = await redis.del(k);
      console.log(`DEL ${k} -> ${del} (prev token=${token}..., ttl=${ttl}s)`);
    }
  }
  const pending = await redis.get(`${prefix}pending-operation`);
  console.log(`pending-operation: ${pending ?? "<unset>"}`);
} finally {
  await redis.quit();
}
