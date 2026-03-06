import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDomains,
  normalizeDomain,
  normalizeDomainList,
} from "@/server/firewall/domains";

test("normalizeDomain accepts hostnames and strips schemes and paths", () => {
  assert.equal(normalizeDomain("https://api.openai.com/v1/chat/completions"), "api.openai.com");
  assert.equal(normalizeDomain("GITHUB.com/docs"), "github.com");
  assert.equal(normalizeDomain("127.0.0.1"), null);
});

test("normalizeDomainList separates valid and invalid entries", () => {
  const result = normalizeDomainList([
    "api.openai.com",
    "api.openai.com",
    "hello",
    "https://vercel.com/docs",
  ]);

  assert.deepEqual(result.valid, ["api.openai.com", "vercel.com"]);
  assert.deepEqual(result.invalid, ["hello"]);
});

test("extractDomains finds domains in mixed command log text", () => {
  const domains = extractDomains(`
curl https://api.openai.com/v1/chat/completions
HOST=github.com
dns lookup: registry.npmjs.org
echo done
  `);

  assert.deepEqual(domains, [
    "api.openai.com",
    "github.com",
    "registry.npmjs.org",
  ]);
});
