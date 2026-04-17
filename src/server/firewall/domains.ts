import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { DomainCategory, LearnedDomain } from "@/shared/types";
import { getRegistrableDomain } from "@/shared/domain-grouping";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UNICODE_DOTS = /[\u3002\uFF0E\uFF61]/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const HOST_PATTERN = /\bhost\s*[:=]\s*([^\s"'<>]+)/gi;
const DNS_PATTERN =
  /\b(?:dns(?:\s+(?:query|lookup|resolve|request))?|lookup|resolve(?:d)?)\s*[:=]?\s*([^\s"'<>]+)/gi;
const ENV_VAR_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:URL|HOST|ENDPOINT|ORIGIN|DOMAIN|SERVER|REGISTRY|BASE)\s*=\s*["']?([^\s"']+)/g;
const JS_NETWORK_PATTERN =
  /\b(?:fetch|require|import|axios\.(?:get|post|put|delete|patch|request))\s*\(\s*["'`]([^"'`\s]+)["'`]/gi;
const BARE_DOMAIN_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z0-9-]+\b/gi;
const HOST_LABEL_PATTERN = /^[a-z0-9-]+$/;
const TLD_PATTERN = /^([a-z]{2,}|xn--[a-z0-9-]{2,})$/;
const AMBIGUOUS_TLDS = new Set(["get", "js", "json", "log", "mov", "py", "rs", "ts", "zip"]);

export function normalizeDomain(input: string): string | null {
  if (!input || CONTROL_CHARS.test(input)) {
    return null;
  }

  const cleanedInput = input.trim().replace(UNICODE_DOTS, ".");
  if (!cleanedInput) {
    return null;
  }

  const parsedInput =
    URL_SCHEME.test(cleanedInput) || cleanedInput.startsWith("//")
      ? cleanedInput
      : `https://${cleanedInput}`;

  let hostname = "";
  try {
    hostname = new URL(parsedInput).hostname;
  } catch {
    const withoutScheme = cleanedInput.replace(URL_SCHEME, "").replace(/^\/\//, "");
    const withoutAuth = withoutScheme.split("@").at(-1) ?? "";
    const withoutPath = withoutAuth.split(/[/?#]/, 1)[0] ?? "";
    hostname = withoutPath.split(":", 1)[0] ?? "";
  }

  if (!hostname || hostname.includes("*")) {
    return null;
  }

  const asciiHostname = domainToASCII(
    hostname.replace(UNICODE_DOTS, ".").replace(/\.$/, "").toLowerCase(),
  );
  if (!asciiHostname) {
    return null;
  }

  if (
    asciiHostname.length > 253 ||
    asciiHostname.startsWith(".") ||
    asciiHostname.endsWith(".") ||
    asciiHostname.includes("..") ||
    isIP(asciiHostname)
  ) {
    return null;
  }

  const labels = asciiHostname.split(".");
  if (labels.length < 2) {
    return null;
  }

  for (const label of labels) {
    if (
      !label ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-") ||
      !HOST_LABEL_PATTERN.test(label)
    ) {
      return null;
    }
  }

  const tld = labels.at(-1) ?? "";
  if (!TLD_PATTERN.test(tld) || AMBIGUOUS_TLDS.has(tld)) {
    return null;
  }

  return asciiHostname;
}

export function normalizeDomainList(domains: string[]): {
  valid: string[];
  invalid: string[];
} {
  const valid = new Set<string>();
  const invalid = new Set<string>();

  for (const domain of domains) {
    const normalized = normalizeDomain(domain);
    if (normalized) {
      valid.add(normalized);
    } else {
      invalid.add(domain);
    }
  }

  return {
    valid: [...valid].sort((left, right) => left.localeCompare(right)),
    invalid: [...invalid],
  };
}

export function extractDomains(logText: string): string[] {
  if (!logText.trim()) {
    return [];
  }

  const matches = new Set<string>();
  const add = (value: string | null | undefined): void => {
    if (!value) {
      return;
    }

    const normalized = normalizeDomain(
      value
        .trim()
        .replace(/^[('"`\[{<]+/, "")
        .replace(/[)"'`\]}>.,;]+$/, ""),
    );

    if (normalized) {
      matches.add(normalized);
    }
  };

  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(logText); match; match = URL_PATTERN.exec(logText)) {
    add(match[0]);
  }

  HOST_PATTERN.lastIndex = 0;
  for (let match = HOST_PATTERN.exec(logText); match; match = HOST_PATTERN.exec(logText)) {
    add(match[1]);
  }

  DNS_PATTERN.lastIndex = 0;
  for (let match = DNS_PATTERN.exec(logText); match; match = DNS_PATTERN.exec(logText)) {
    add(match[1]);
  }

  ENV_VAR_PATTERN.lastIndex = 0;
  for (let match = ENV_VAR_PATTERN.exec(logText); match; match = ENV_VAR_PATTERN.exec(logText)) {
    add(match[1]);
  }

  JS_NETWORK_PATTERN.lastIndex = 0;
  for (
    let match = JS_NETWORK_PATTERN.exec(logText);
    match;
    match = JS_NETWORK_PATTERN.exec(logText)
  ) {
    add(match[1]);
  }

  BARE_DOMAIN_PATTERN.lastIndex = 0;
  for (
    let match = BARE_DOMAIN_PATTERN.exec(logText);
    match;
    match = BARE_DOMAIN_PATTERN.exec(logText)
  ) {
    const index = match.index ?? 0;
    if (logText[index - 1] === "@" || logText[index - 1] === "/") {
      continue;
    }
    add(match[0]);
  }

  return [...matches].sort((left, right) => left.localeCompare(right));
}

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: DomainCategory }> = [
  { pattern: /\bnpm\b|npmjs\.org|\byarn\b|\bpnpm\b/i, category: "npm" },
  { pattern: /\bcurl\b|\bwget\b/i, category: "curl" },
  { pattern: /\bdns\b|\blookup\b|\bresolve[d]?\b|\bnslookup\b|\bdig\s/i, category: "dns" },
  { pattern: /\bfetch\s*\(|\baxios\b|\brequire\s*\(|\bimport\s*\(/i, category: "fetch" },
  { pattern: /\bgit\s|\bgit$|github\.com|gitlab\.com|bitbucket\.org/i, category: "git" },
];

export function inferCategory(line: string): DomainCategory {
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(line)) {
      return category;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Command redaction — strip secrets before persisting in events
// ---------------------------------------------------------------------------

/** Matches ENV_VAR=value patterns for known secret variable names */
const SECRET_ENV_ASSIGN = /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN|VERCEL_TOKEN|GITHUB_TOKEN|NPM_TOKEN|SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN|CRON_SECRET|DATABASE_URL|REDIS_URL|KV_URL|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|API_KEY|API_SECRET|AUTH_TOKEN|SESSION_SECRET|JWT_SECRET|ENCRYPTION_KEY|PASSWORD|PASSWD|CREDENTIALS)\s*=\s*\S+/gi;
const BEARER_TOKEN = /\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9_\-./+=]{8,}/gi;
const URL_CREDENTIALS = /(:\/\/)[^@\s]+@/g;
const INLINE_KEY_VALUES = /--(?:token|key|secret|password|api-key|auth)\s*[=\s]\s*\S+/gi;
const LONG_HEX_OR_BASE64 = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9\-]{20,}|xoxp-[A-Za-z0-9\-]{20,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{40,})\b/g;

/**
 * Redact likely secrets from a shell command string before persisting.
 * The goal is best-effort — we redact common patterns, not all possible secrets.
 */
export function redactCommand(command: string): string {
  return command
    .replace(SECRET_ENV_ASSIGN, (match) => {
      const eqIndex = match.indexOf("=");
      return match.slice(0, eqIndex + 1) + "[REDACTED]";
    })
    .replace(BEARER_TOKEN, (match) => {
      const spaceIndex = match.indexOf(" ");
      return match.slice(0, spaceIndex + 1) + "[REDACTED]";
    })
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(INLINE_KEY_VALUES, (match) => {
      const sepIndex = match.search(/[\s=]/);
      const afterFlag = match.slice(sepIndex).search(/\S/);
      return match.slice(0, sepIndex + afterFlag) + "[REDACTED]";
    })
    .replace(LONG_HEX_OR_BASE64, "[REDACTED]");
}

export type DomainWithContext = {
  domain: string;
  sourceCommand: string;
  category: DomainCategory;
};

export function extractDomainsWithContext(logText: string): DomainWithContext[] {
  if (!logText.trim()) {
    return [];
  }

  const seen = new Map<string, DomainWithContext>();
  const lines = logText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const domains = extractDomains(trimmed);
    if (domains.length === 0) continue;

    const category = inferCategory(trimmed);
    const redacted = redactCommand(trimmed);
    for (const domain of domains) {
      if (!seen.has(domain)) {
        seen.set(domain, { domain, sourceCommand: redacted, category });
      }
    }
  }

  return [...seen.values()].sort((left, right) =>
    left.domain.localeCompare(right.domain),
  );
}

// ---------------------------------------------------------------------------
// eTLD+1 domain grouping — re-exported from shared module
// ---------------------------------------------------------------------------

export { getRegistrableDomain, MULTI_LABEL_SUFFIXES } from "@/shared/domain-grouping";

export type DomainGroup = {
  registrableDomain: string;
  domains: LearnedDomain[];
};

/**
 * Group learned domains by their registrable domain (eTLD+1).
 * Groups are sorted alphabetically by registrable domain;
 * domains within each group are sorted alphabetically.
 */
export function groupByRegistrableDomain(
  domains: LearnedDomain[],
): DomainGroup[] {
  const groups = new Map<string, LearnedDomain[]>();

  for (const entry of domains) {
    const key = getRegistrableDomain(entry.domain);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  // Sort domains within each group
  for (const list of groups.values()) {
    list.sort((a, b) => a.domain.localeCompare(b.domain));
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([registrableDomain, domains]) => ({ registrableDomain, domains }));
}
