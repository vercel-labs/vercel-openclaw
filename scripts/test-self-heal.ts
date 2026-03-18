#!/usr/bin/env tsx
/**
 * Run just the selfHealTokenRefresh smoke phase against a live deployment.
 *
 * Usage:
 *   SMOKE_AUTH_COOKIE="<cookie>" npx tsx scripts/test-self-heal.ts --base-url https://...
 */
import { parseArgs } from "node:util";
import { selfHealTokenRefresh } from "../src/server/smoke/remote-phases.js";
import { setAuthCookie } from "../src/server/smoke/remote-auth.js";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    timeout: { type: "string", default: "180" },
  },
  strict: false,
});

const baseUrl = values["base-url"] as string | undefined;
if (!baseUrl) {
  console.error("Usage: npx tsx scripts/test-self-heal.ts --base-url <url>");
  process.exit(1);
}

const cookie = process.env.SMOKE_AUTH_COOKIE;
if (cookie) setAuthCookie(cookie);

const timeoutMs = Number(values.timeout) * 1000;

async function main() {
  console.error(`Running selfHealTokenRefresh against ${baseUrl} (timeout: ${timeoutMs / 1000}s)`);
  const result = await selfHealTokenRefresh(baseUrl!, timeoutMs, { requestTimeoutMs: 30_000 });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
