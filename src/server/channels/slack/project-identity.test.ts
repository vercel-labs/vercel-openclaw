import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBotDisplayName,
  buildDescription,
  buildDisplayName,
  getProjectIdentity,
  slugifyForSlash,
  type ProjectIdentity,
} from "./project-identity";

function identity(scope: string, name: string): ProjectIdentity {
  return { scope, name, combined: `${scope}-${name}` };
}

function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key]!;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key]!;
    }
  }
}

test("getProjectIdentity: reads and sanitizes env vars", () => {
  withEnv(
    { VCLAW_PROJECT_SCOPE: "Vercel_Labs!", VCLAW_PROJECT_NAME: "My Bot.v2" },
    () => {
      const id = getProjectIdentity();
      assert.equal(id.scope, "vercel-labs");
      assert.equal(id.name, "my-bot-v2");
      assert.equal(id.combined, "vercel-labs-my-bot-v2");
    },
  );
});

test("getProjectIdentity: falls back when env vars missing", () => {
  withEnv(
    {
      VCLAW_PROJECT_SCOPE: undefined,
      VCLAW_PROJECT_NAME: undefined,
      VERCEL_PROJECT_ID: "prj_abc123xyz",
    },
    () => {
      const id = getProjectIdentity();
      assert.equal(id.scope, "vclaw");
      // prj_abc123xyz → sanitize → prj-abc123xyz → slice(-8) = "bc123xyz"
      assert.equal(id.name, "bc123xyz");
    },
  );
});

test("slugifyForSlash: short identity is returned verbatim", () => {
  assert.equal(slugifyForSlash(identity("vercel-labs", "my-bot")), "/vercel-labs-my-bot");
});

test("slugifyForSlash: truncates and appends hash when over 31 chars", () => {
  const id = identity("some-really-long-org-slug", "a-very-very-long-project-name-indeed");
  const slashed = slugifyForSlash(id);
  assert.ok(slashed.startsWith("/"));
  assert.ok(slashed.length <= 32, `got ${slashed.length}: ${slashed}`);
  // Hash suffix keeps identical-prefix identities distinct.
  const other = slugifyForSlash(
    identity("some-really-long-org-slug", "a-very-very-long-project-name-variant"),
  );
  assert.notEqual(slashed, other);
});

test("slugifyForSlash: deterministic for same input", () => {
  const id = identity("aaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbb");
  assert.equal(slugifyForSlash(id), slugifyForSlash(id));
});

test("buildDisplayName: format is `name (scope)` and ≤ 35 chars", () => {
  assert.equal(buildDisplayName(identity("vercel-labs", "my-bot")), "my-bot (vercel-labs)");
  const long = buildDisplayName(
    identity("very-long-scope-here", "very-long-project-name-here"),
  );
  assert.ok(long.length <= 35);
});

test("buildBotDisplayName: uses `.` separator to satisfy Slack's [a-z0-9-_.] rule", () => {
  const name = buildBotDisplayName(identity("vercel-labs", "my-bot"));
  assert.equal(name, "my-bot.vercel-labs");
  assert.match(name, /^[a-z0-9._-]+$/);
});

test("buildDescription: always includes full untruncated `scope=X project=Y` and ≤ 140 chars", () => {
  const desc = buildDescription(identity("vercel-labs", "my-bot"));
  assert.ok(desc.includes("scope=vercel-labs project=my-bot"));
  assert.ok(desc.length <= 140);
});
