import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildAuthProfilesJson,
  CODEX_AUTH_PROFILE_KEY,
  isCodexActive,
  normalizeCodexCredentialsForStorage,
  parsePastedCodexPayload,
  readCodexCredentials,
  redactCodexCredentials,
} from "@/server/codex/credentials";
import type { CodexCredentials, SingleMeta } from "@/shared/types";
import { createDefaultMeta, ensureMetaShape } from "@/shared/types";

function makeCreds(overrides: Partial<CodexCredentials> = {}): CodexCredentials {
  return {
    access: "eyJhbGciOi.access-jwt",
    refresh: "rt_refresh_token_value",
    expires: 1_800_000_000_000,
    accountId: "acct_abc123",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function metaWith(codex: CodexCredentials | null | undefined): SingleMeta {
  const meta = createDefaultMeta(1_000, "gw-token");
  if (codex === undefined) return meta;
  return { ...meta, codexCredentials: codex };
}

// ---------------------------------------------------------------------------
// readCodexCredentials / isCodexActive
// ---------------------------------------------------------------------------

describe("readCodexCredentials / isCodexActive", () => {
  test("returns null when codexCredentials is absent", () => {
    const meta = metaWith(undefined);
    assert.equal(readCodexCredentials(meta), null);
    assert.equal(isCodexActive(meta), false);
  });

  test("returns null when codexCredentials is explicitly null", () => {
    const meta = metaWith(null);
    assert.equal(readCodexCredentials(meta), null);
    assert.equal(isCodexActive(meta), false);
  });

  test("returns credentials when present and reports active", () => {
    const creds = makeCreds();
    const meta = metaWith(creds);
    assert.deepStrictEqual(readCodexCredentials(meta), creds);
    assert.equal(isCodexActive(meta), true);
  });
});

// ---------------------------------------------------------------------------
// redactCodexCredentials
// ---------------------------------------------------------------------------

describe("redactCodexCredentials", () => {
  test("never exposes access or refresh tokens", () => {
    const creds = makeCreds();
    const redacted = redactCodexCredentials(creds);
    const json = JSON.stringify(redacted);
    assert.ok(!Object.hasOwn(redacted, "access"), "redacted must not include access");
    assert.ok(!Object.hasOwn(redacted, "refresh"), "redacted must not include refresh");
    assert.equal(
      json.includes(creds.access),
      false,
      "serialized redacted payload must not contain access token",
    );
    assert.equal(
      json.includes(creds.refresh),
      false,
      "serialized redacted payload must not contain refresh token",
    );
  });

  test("surfaces connected flag, expires, accountId, and updatedAt", () => {
    const redacted = redactCodexCredentials(makeCreds());
    assert.deepStrictEqual(redacted, {
      connected: true,
      expires: 1_800_000_000_000,
      accountId: "acct_abc123",
      updatedAt: 1_700_000_000_000,
    });
  });

  test("omits accountId when undefined, preserves null", () => {
    const noAccount = redactCodexCredentials(
      makeCreds({ accountId: undefined as unknown as null }),
    );
    assert.ok(!("accountId" in noAccount));

    const nullAccount = redactCodexCredentials(makeCreds({ accountId: null }));
    assert.equal(nullAccount.accountId, null);
  });
});

// ---------------------------------------------------------------------------
// buildAuthProfilesJson
// ---------------------------------------------------------------------------

describe("buildAuthProfilesJson", () => {
  test("emits the OpenClaw-expected shape under openai-codex:default", () => {
    const json = buildAuthProfilesJson(makeCreds());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.ok(parsed[CODEX_AUTH_PROFILE_KEY], "default profile entry must exist");
    const entry = parsed[CODEX_AUTH_PROFILE_KEY] as Record<string, unknown>;
    assert.equal(entry.type, "oauth");
    assert.equal(entry.provider, "openai-codex");
    assert.equal(entry.access, "eyJhbGciOi.access-jwt");
    assert.equal(entry.refresh, "rt_refresh_token_value");
    assert.equal(entry.expires, 1_800_000_000_000);
    assert.equal(entry.accountId, "acct_abc123");
  });

  test("is pretty-printed with 2-space indent and no trailing newline", () => {
    const json = buildAuthProfilesJson(makeCreds());
    assert.ok(json.includes('\n  "'), "should use 2-space indent");
    assert.equal(json.endsWith("\n"), false, "must not end with a trailing newline");
  });

  test("omits accountId when null or undefined", () => {
    const noField = JSON.parse(
      buildAuthProfilesJson(makeCreds({ accountId: undefined as unknown as null })),
    ) as Record<string, Record<string, unknown>>;
    assert.ok(!Object.hasOwn(noField[CODEX_AUTH_PROFILE_KEY], "accountId"));

    const nullField = JSON.parse(
      buildAuthProfilesJson(makeCreds({ accountId: null })),
    ) as Record<string, Record<string, unknown>>;
    assert.ok(!Object.hasOwn(nullField[CODEX_AUTH_PROFILE_KEY], "accountId"));
  });
});

// ---------------------------------------------------------------------------
// normalizeCodexCredentialsForStorage
// ---------------------------------------------------------------------------

describe("normalizeCodexCredentialsForStorage", () => {
  test("accepts canonical camelCase input", () => {
    const result = normalizeCodexCredentialsForStorage({
      access: "a",
      refresh: "r",
      expires: 42,
      accountId: "acct",
    });
    assert.equal(result.access, "a");
    assert.equal(result.refresh, "r");
    assert.equal(result.expires, 42);
    assert.equal(result.accountId, "acct");
    assert.equal(typeof result.updatedAt, "number");
  });

  test("accepts snake_case aliases", () => {
    const result = normalizeCodexCredentialsForStorage({
      access_token: "a",
      refresh_token: "r",
      expires_at: 99,
      account_id: "acct",
    });
    assert.equal(result.access, "a");
    assert.equal(result.refresh, "r");
    assert.equal(result.expires, 99);
    assert.equal(result.accountId, "acct");
  });

  test("derives expires from last_refresh when no direct expiry given", () => {
    const result = normalizeCodexCredentialsForStorage({
      access_token: "a",
      refresh_token: "r",
      last_refresh: 1_000_000,
    });
    assert.equal(result.expires, 1_000_000 + 60 * 60 * 1000);
  });

  test("parses ISO-8601 last_refresh strings", () => {
    const iso = "2024-01-01T00:00:00.000Z";
    const result = normalizeCodexCredentialsForStorage({
      access_token: "a",
      refresh_token: "r",
      last_refresh: iso,
    });
    assert.equal(result.expires, Date.parse(iso) + 60 * 60 * 1000);
  });

  test("omits accountId when missing entirely", () => {
    const result = normalizeCodexCredentialsForStorage({
      access: "a",
      refresh: "r",
      expires: 1,
    });
    assert.ok(!("accountId" in result));
  });

  test("preserves explicit null accountId", () => {
    const result = normalizeCodexCredentialsForStorage({
      access: "a",
      refresh: "r",
      expires: 1,
      accountId: null,
    });
    assert.equal(result.accountId, null);
  });

  test("throws when access token is missing", () => {
    assert.throws(
      () =>
        normalizeCodexCredentialsForStorage({
          refresh: "r",
          expires: 1,
        }),
      /missing access token/,
    );
  });

  test("throws when refresh token is missing", () => {
    assert.throws(
      () =>
        normalizeCodexCredentialsForStorage({
          access: "a",
          expires: 1,
        }),
      /missing refresh token/,
    );
  });

  test("throws when expires cannot be resolved", () => {
    assert.throws(
      () =>
        normalizeCodexCredentialsForStorage({
          access: "a",
          refresh: "r",
        }),
      /expires \/ expires_at \/ last_refresh/,
    );
  });

  test("rejects empty-string tokens", () => {
    assert.throws(
      () =>
        normalizeCodexCredentialsForStorage({
          access: "",
          refresh: "r",
          expires: 1,
        }),
      /missing access token/,
    );
  });
});

// ---------------------------------------------------------------------------
// parsePastedCodexPayload — three accepted shapes
// ---------------------------------------------------------------------------

describe("parsePastedCodexPayload", () => {
  test("shape (1): raw ~/.codex/auth.json with nested tokens + last_refresh", () => {
    const raw = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "ignored.id-token",
        access_token: "jwt-access",
        refresh_token: "rt_pasted",
        account_id: "acct_xyz",
      },
      last_refresh: 1_700_000_000_000,
    });

    const result = parsePastedCodexPayload(raw);
    assert.equal(result.access, "jwt-access");
    assert.equal(result.refresh, "rt_pasted");
    assert.equal(result.accountId, "acct_xyz");
    assert.equal(result.expires, 1_700_000_000_000 + 60 * 60 * 1000);
  });

  test("shape (2): single flat entry in camelCase", () => {
    const raw = JSON.stringify({
      access: "acc-2",
      refresh: "rt-2",
      expires: 12345,
      accountId: "acct-2",
    });
    const result = parsePastedCodexPayload(raw);
    assert.equal(result.access, "acc-2");
    assert.equal(result.refresh, "rt-2");
    assert.equal(result.expires, 12345);
    assert.equal(result.accountId, "acct-2");
  });

  test("shape (3): full auth-profiles.json map extracts default entry", () => {
    const raw = JSON.stringify({
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "full-acc",
        refresh: "full-rt",
        expires: 55555,
        accountId: "acct-full",
      },
      "some-other-profile": { type: "oauth" },
    });
    const result = parsePastedCodexPayload(raw);
    assert.equal(result.access, "full-acc");
    assert.equal(result.refresh, "full-rt");
    assert.equal(result.expires, 55555);
    assert.equal(result.accountId, "acct-full");
  });

  test("tolerates surrounding whitespace", () => {
    const raw = `\n   ${JSON.stringify({
      access: "a",
      refresh: "r",
      expires: 1,
    })}   \n`;
    const result = parsePastedCodexPayload(raw);
    assert.equal(result.access, "a");
  });

  test("throws on empty input", () => {
    assert.throws(() => parsePastedCodexPayload("   "), /empty/);
  });

  test("throws on invalid JSON", () => {
    assert.throws(() => parsePastedCodexPayload("not-json"), /not valid JSON/);
  });

  test("throws when JSON is not an object", () => {
    assert.throws(() => parsePastedCodexPayload("[1,2,3]"), /must be a JSON object/);
  });

  test("throws when auth-profiles default entry is malformed", () => {
    const raw = JSON.stringify({ "openai-codex:default": "not-an-object" });
    assert.throws(
      () => parsePastedCodexPayload(raw),
      /must be an object/,
    );
  });

  test("propagates missing-field errors from normalization", () => {
    const raw = JSON.stringify({ access: "a" });
    assert.throws(
      () => parsePastedCodexPayload(raw),
      /missing refresh token/,
    );
  });
});

// ---------------------------------------------------------------------------
// ensureMetaShape interop — hydration must round-trip codexCredentials
// ---------------------------------------------------------------------------

describe("ensureMetaShape + codexCredentials", () => {
  test("absent field continues to hydrate cleanly (no migration needed)", () => {
    const legacy = {
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
    };
    const hydrated = ensureMetaShape(legacy);
    assert.ok(hydrated);
    assert.equal(hydrated.codexCredentials, undefined);
    assert.equal(isCodexActive(hydrated), false);
  });

  test("valid codexCredentials round-trip through ensureMetaShape", () => {
    const creds = makeCreds();
    const hydrated = ensureMetaShape({
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      codexCredentials: creds,
    });
    assert.ok(hydrated);
    assert.ok(hydrated.codexCredentials);
    assert.equal(hydrated.codexCredentials.access, creds.access);
    assert.equal(hydrated.codexCredentials.refresh, creds.refresh);
    assert.equal(hydrated.codexCredentials.expires, creds.expires);
    assert.equal(hydrated.codexCredentials.accountId, creds.accountId);
    assert.equal(isCodexActive(hydrated), true);
  });

  test("explicit null codexCredentials hydrates to null (Codex disabled)", () => {
    const hydrated = ensureMetaShape({
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      codexCredentials: null,
    });
    assert.ok(hydrated);
    assert.equal(hydrated.codexCredentials, null);
    assert.equal(isCodexActive(hydrated), false);
  });

  test("malformed codexCredentials collapses to null rather than activating Codex", () => {
    const hydrated = ensureMetaShape({
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      codexCredentials: { access: 42, refresh: null },
    });
    assert.ok(hydrated);
    assert.equal(hydrated.codexCredentials, null);
    assert.equal(isCodexActive(hydrated), false);
  });
});
