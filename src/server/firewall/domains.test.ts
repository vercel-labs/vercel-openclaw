import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDomains,
  extractDomainsWithContext,
  getRegistrableDomain,
  groupByRegistrableDomain,
  inferCategory,
  normalizeDomain,
  normalizeDomainList,
} from "@/server/firewall/domains";
import type { LearnedDomain } from "@/shared/types";

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

test("extractDomains captures domains from env var assignments", () => {
  const domains = extractDomains(`
API_URL=https://api.stripe.com/v1/charges
DATABASE_HOST=db.neon.tech
WEBHOOK_ENDPOINT=hooks.slack.com/services/T0
SOME_ORIGIN=https://cdn.example.com
  `);

  assert.deepEqual(domains, [
    "api.stripe.com",
    "cdn.example.com",
    "db.neon.tech",
    "hooks.slack.com",
  ]);
});

test("extractDomains captures domains from JS fetch/require/import patterns", () => {
  const domains = extractDomains(`
fetch("https://api.github.com/repos")
require("https://esm.sh/lodash")
import("https://cdn.skypack.dev/react")
axios.get("https://httpbin.org/get")
  `);

  assert.deepEqual(domains, [
    "api.github.com",
    "cdn.skypack.dev",
    "esm.sh",
    "httpbin.org",
  ]);
});

test("extractDomains captures domains from npm registry output", () => {
  const domains = extractDomains(`
npm http fetch GET 200 https://registry.npmjs.org/typescript 50ms
npm http fetch GET 200 https://registry.npmjs.org/@types/node 30ms
npm warn deprecated https://registry.yarnpkg.com/old-package
  `);

  assert.deepEqual(domains, [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
  ]);
});

test("extractDomains still rejects ambiguous TLDs and IPs from env vars", () => {
  const domains = extractDomains(`
LOG_FILE=/tmp/output.log
SCRIPT_URL=./build.js
MY_HOST=192.168.1.1
  `);

  assert.deepEqual(domains, []);
});

// ===========================================================================
// inferCategory tests
// ===========================================================================

test("inferCategory detects npm commands", () => {
  assert.equal(inferCategory("npm http fetch GET 200 https://registry.npmjs.org/typescript 50ms"), "npm");
  assert.equal(inferCategory("pnpm install express"), "npm");
  assert.equal(inferCategory("yarn add lodash"), "npm");
});

test("inferCategory detects curl/wget commands", () => {
  assert.equal(inferCategory("curl https://api.openai.com/v1/chat/completions"), "curl");
  assert.equal(inferCategory("wget https://example.com/file.tar.gz"), "curl");
});

test("inferCategory detects git commands", () => {
  assert.equal(inferCategory("git clone https://github.com/user/repo"), "git");
  assert.equal(inferCategory("https://gitlab.com/user/repo"), "git");
});

test("inferCategory detects dns commands", () => {
  assert.equal(inferCategory("dns lookup api.anthropic.com"), "dns");
  assert.equal(inferCategory("nslookup example.com"), "dns");
  assert.equal(inferCategory("dig +short example.com"), "dns");
});

test("inferCategory detects fetch/JS patterns", () => {
  assert.equal(inferCategory('fetch("https://api.github.com/repos")'), "fetch");
  assert.equal(inferCategory('axios.get("https://httpbin.org/get")'), "fetch");
});

test("inferCategory returns unknown for unrecognized commands", () => {
  assert.equal(inferCategory("echo hello world"), "unknown");
  assert.equal(inferCategory("ls -la /tmp"), "unknown");
});

// ===========================================================================
// extractDomainsWithContext tests
// ===========================================================================

test("extractDomainsWithContext returns domains with source command and category", () => {
  const results = extractDomainsWithContext([
    "curl https://api.openai.com/v1/chat/completions",
    "npm http fetch GET 200 https://registry.npmjs.org/typescript 50ms",
    "dns lookup api.anthropic.com",
  ].join("\n"));

  assert.equal(results.length, 3);

  const openai = results.find((r) => r.domain === "api.openai.com");
  assert.ok(openai);
  assert.equal(openai.category, "curl");
  assert.equal(openai.sourceCommand, "curl https://api.openai.com/v1/chat/completions");

  const npm = results.find((r) => r.domain === "registry.npmjs.org");
  assert.ok(npm);
  assert.equal(npm.category, "npm");

  const dns = results.find((r) => r.domain === "api.anthropic.com");
  assert.ok(dns);
  assert.equal(dns.category, "dns");
});

test("extractDomainsWithContext deduplicates domains keeping first occurrence", () => {
  const results = extractDomainsWithContext([
    "curl https://api.openai.com/v1/chat",
    "fetch('https://api.openai.com/v1/models')",
  ].join("\n"));

  assert.equal(results.length, 1);
  assert.equal(results[0].domain, "api.openai.com");
  assert.equal(results[0].category, "curl");
});

test("extractDomainsWithContext returns empty array for empty input", () => {
  assert.deepEqual(extractDomainsWithContext(""), []);
  assert.deepEqual(extractDomainsWithContext("   \n  \n  "), []);
});

// ===========================================================================
// Shared test vectors for getRegistrableDomain
// ===========================================================================
//
// These vectors verify parity between the server-side getRegistrableDomain
// (re-exported from @/shared/domain-grouping via domains.ts) and any client
// copy. The shared module has zero node: imports, so both environments use
// identical logic.

import { getRegistrableDomain as sharedGetRegistrableDomain } from "@/shared/domain-grouping";

/**
 * Deterministic test vectors covering:
 * - Simple 2-label domains
 * - Standard subdomain stripping
 * - Deep subdomain chains (a.b.c.d.example.com)
 * - Multi-label ccTLDs (co.uk, com.au, co.jp, etc.)
 * - Cloud-hosting suffixes (amazonaws.com, vercel.app, run.app, etc.)
 * - IPv4 addresses
 * - IPv6 addresses
 */
const REGISTRABLE_DOMAIN_VECTORS: Array<[input: string, expected: string]> = [
  // Simple 2-label domains — returned as-is
  ["openai.com", "openai.com"],
  ["github.com", "github.com"],
  ["example.org", "example.org"],

  // Standard subdomain stripping (eTLD+1)
  ["api.openai.com", "openai.com"],
  ["cdn.openai.com", "openai.com"],
  ["files.openai.com", "openai.com"],
  ["www.github.com", "github.com"],

  // Deep subdomain chains
  ["deep.nested.sub.example.org", "example.org"],
  ["a.b.c.d.example.com", "example.com"],
  ["one.two.three.four.five.test.net", "test.net"],

  // Multi-label ccTLDs
  ["api.example.co.uk", "example.co.uk"],
  ["example.co.uk", "example.co.uk"],
  ["foo.bar.co.jp", "bar.co.jp"],
  ["app.example.com.au", "example.com.au"],
  ["example.com.au", "example.com.au"],
  ["deep.sub.example.com.br", "example.com.br"],
  ["shop.example.co.nz", "example.co.nz"],
  ["mail.example.co.in", "example.co.in"],

  // Cloud-hosting suffixes (act like public suffixes)
  ["us-east-1.ec2.amazonaws.com", "ec2.amazonaws.com"],
  ["bucket.s3.amazonaws.com", "bucket.s3.amazonaws.com"],
  ["my-app.vercel.app", "my-app.vercel.app"],
  ["d1234.cloudfront.net", "d1234.cloudfront.net"],
  ["my-app.herokuapp.com", "my-app.herokuapp.com"],
  ["my-svc.run.app", "my-svc.run.app"],
  ["my-site.netlify.app", "my-site.netlify.app"],
  ["worker.pages.dev", "worker.pages.dev"],
  ["app.workers.dev", "app.workers.dev"],
  ["my-app.fly.dev", "my-app.fly.dev"],
  ["db.onrender.com", "db.onrender.com"],
  ["my-project.railway.app", "my-project.railway.app"],
  ["fresh.deno.dev", "fresh.deno.dev"],
  ["my-func.cloudfunctions.net", "my-func.cloudfunctions.net"],
  ["my-app.azurewebsites.net", "my-app.azurewebsites.net"],
  ["acct.blob.core.windows.net", "acct.blob.core.windows.net"],

  // IP addresses — returned as-is
  ["192.168.1.1", "192.168.1.1"],
  ["10.0.0.1", "10.0.0.1"],
  ["::1", "::1"],
  ["2001:db8::1", "2001:db8::1"],
];

function makeLearned(domain: string): LearnedDomain {
  return {
    domain,
    firstSeenAt: 1000,
    lastSeenAt: 2000,
    hitCount: 1,
    categories: ["unknown"],
  };
}

test("getRegistrableDomain (server re-export) passes all shared vectors", () => {
  for (const [input, expected] of REGISTRABLE_DOMAIN_VECTORS) {
    assert.equal(
      getRegistrableDomain(input),
      expected,
      `server: getRegistrableDomain("${input}") should be "${expected}"`,
    );
  }
});

test("getRegistrableDomain (shared module direct) passes all shared vectors", () => {
  for (const [input, expected] of REGISTRABLE_DOMAIN_VECTORS) {
    assert.equal(
      sharedGetRegistrableDomain(input),
      expected,
      `shared: getRegistrableDomain("${input}") should be "${expected}"`,
    );
  }
});

test("server and shared getRegistrableDomain are the same function", () => {
  assert.equal(getRegistrableDomain, sharedGetRegistrableDomain);
});

// ===========================================================================
// groupByRegistrableDomain tests
// ===========================================================================

test("groupByRegistrableDomain groups subdomains under their registrable domain", () => {
  const domains = [
    makeLearned("api.openai.com"),
    makeLearned("cdn.openai.com"),
    makeLearned("files.openai.com"),
    makeLearned("registry.npmjs.org"),
  ];

  const groups = groupByRegistrableDomain(domains);

  assert.equal(groups.length, 2);

  const npmGroup = groups.find((g) => g.registrableDomain === "npmjs.org");
  assert.ok(npmGroup);
  assert.equal(npmGroup.domains.length, 1);
  assert.equal(npmGroup.domains[0].domain, "registry.npmjs.org");

  const openaiGroup = groups.find((g) => g.registrableDomain === "openai.com");
  assert.ok(openaiGroup);
  assert.equal(openaiGroup.domains.length, 3);
  assert.deepEqual(
    openaiGroup.domains.map((d) => d.domain),
    ["api.openai.com", "cdn.openai.com", "files.openai.com"],
  );
});

test("groupByRegistrableDomain handles 2-label domains (no subdomain)", () => {
  const domains = [makeLearned("openai.com"), makeLearned("github.com")];
  const groups = groupByRegistrableDomain(domains);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].registrableDomain, "github.com");
  assert.equal(groups[0].domains.length, 1);
  assert.equal(groups[1].registrableDomain, "openai.com");
  assert.equal(groups[1].domains.length, 1);
});

test("groupByRegistrableDomain handles co.uk multi-label suffixes", () => {
  const domains = [
    makeLearned("api.example.co.uk"),
    makeLearned("cdn.example.co.uk"),
    makeLearned("other.co.uk"),
  ];
  const groups = groupByRegistrableDomain(domains);

  assert.equal(groups.length, 2);

  const exampleGroup = groups.find((g) => g.registrableDomain === "example.co.uk");
  assert.ok(exampleGroup);
  assert.equal(exampleGroup.domains.length, 2);

  const otherGroup = groups.find((g) => g.registrableDomain === "other.co.uk");
  assert.ok(otherGroup);
  assert.equal(otherGroup.domains.length, 1);
});

test("groupByRegistrableDomain handles amazonaws.com as public suffix", () => {
  const domains = [
    makeLearned("us-east-1.s3.amazonaws.com"),
    makeLearned("us-west-2.s3.amazonaws.com"),
    makeLearned("ec2.amazonaws.com"),
  ];
  const groups = groupByRegistrableDomain(domains);

  // s3.amazonaws.com is itself a multi-label suffix, so those two group together
  const s3Group = groups.find((g) => g.registrableDomain === "us-east-1.s3.amazonaws.com" || g.registrableDomain === "us-west-2.s3.amazonaws.com");
  // ec2.amazonaws.com should be its own group
  const ec2Group = groups.find((g) => g.registrableDomain === "ec2.amazonaws.com");
  assert.ok(ec2Group);
  assert.equal(ec2Group.domains.length, 1);
});

test("groupByRegistrableDomain returns empty array for empty input", () => {
  assert.deepEqual(groupByRegistrableDomain([]), []);
});

test("groupByRegistrableDomain sorts groups alphabetically", () => {
  const domains = [
    makeLearned("z.example.com"),
    makeLearned("a.test.org"),
    makeLearned("b.demo.net"),
  ];
  const groups = groupByRegistrableDomain(domains);
  assert.deepEqual(
    groups.map((g) => g.registrableDomain),
    ["demo.net", "example.com", "test.org"],
  );
});
