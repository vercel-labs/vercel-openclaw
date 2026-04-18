import { createHash } from "node:crypto";

import { logWarn } from "@/server/log";

export type ProjectIdentity = {
  /** Sanitized Vercel scope/team slug, lowercase [a-z0-9-]. */
  scope: string;
  /** Sanitized Vercel project name, lowercase [a-z0-9-]. */
  name: string;
  /** `${scope}-${name}`, pre-truncation. */
  combined: string;
};

const SLASH_COMMAND_MAX = 32; // Slack cap, includes leading "/"
const DISPLAY_NAME_MAX = 35; // Slack app display_information.name cap
const DESCRIPTION_MAX = 140; // Slack display_information.description cap
const BOT_DISPLAY_NAME_MAX = 80; // Slack bot_user.display_name cap
const FALLBACK_SCOPE = "vclaw";

function sanitize(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getProjectIdentity(): ProjectIdentity {
  const rawScope = process.env.VCLAW_PROJECT_SCOPE;
  const rawName = process.env.VCLAW_PROJECT_NAME;
  const scope = sanitize(rawScope);
  const name = sanitize(rawName);

  if (scope && name) {
    return { scope, name, combined: `${scope}-${name}` };
  }

  const projectIdTail = sanitize(process.env.VERCEL_PROJECT_ID).slice(-8);
  const fallbackName = name || projectIdTail || "local";
  const fallbackScope = scope || FALLBACK_SCOPE;

  logWarn("project_identity.env_missing", {
    hasScope: Boolean(rawScope),
    hasName: Boolean(rawName),
    resolvedScope: fallbackScope,
    resolvedName: fallbackName,
  });

  return {
    scope: fallbackScope,
    name: fallbackName,
    combined: `${fallbackScope}-${fallbackName}`,
  };
}

/**
 * Build a Slack slash command (including leading "/") from a project identity.
 * Slack caps slash commands at 32 chars. When `${scope}-${name}` exceeds the
 * budget, truncate each half proportionally and append a 4-hex-char hash of
 * the full `${scope}-${name}` string so two long identities never collide.
 */
export function slugifyForSlash(identity: ProjectIdentity): string {
  const budget = SLASH_COMMAND_MAX - 1; // minus leading "/"
  if (identity.combined.length <= budget) {
    return `/${identity.combined}`;
  }

  const hash = createHash("sha256")
    .update(identity.combined)
    .digest("hex")
    .slice(0, 4);

  // Reserve: "-<hash>" = 5 chars. Remaining is split between scope and name.
  const reserved = 1 + hash.length; // "-" + hash
  const scopeAndNameBudget = budget - reserved - 1; // minus "-" between scope and name
  const halfBudget = Math.max(2, Math.floor(scopeAndNameBudget / 2));
  const scopeSlice = identity.scope.slice(0, halfBudget);
  const nameSlice = identity.name.slice(0, scopeAndNameBudget - scopeSlice.length);
  const body = `${scopeSlice}-${nameSlice}-${hash}`;
  return `/${body.replace(/-+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function buildDisplayName(identity: ProjectIdentity): string {
  const full = `${identity.name} (${identity.scope})`;
  return truncate(full, DISPLAY_NAME_MAX);
}

/**
 * Slack's bot_user.display_name only allows [a-z0-9-_.]. Scope and name are
 * already sanitized to [a-z0-9-], so join with "." to stay inside the allowed
 * set while keeping scope and name visually separable.
 */
export function buildBotDisplayName(identity: ProjectIdentity): string {
  return truncate(`${identity.name}.${identity.scope}`, BOT_DISPLAY_NAME_MAX);
}

/**
 * Always includes the full untruncated `scope=<scope> project=<name>` pair so
 * an operator looking at a Slack app's About page can identify the owning
 * Vercel project even when the slash command or display name was truncated.
 */
export function buildDescription(identity: ProjectIdentity): string {
  const tag = `scope=${identity.scope} project=${identity.name}`;
  const full = `VClaw (${tag}) — OpenClaw`;
  return truncate(full, DESCRIPTION_MAX);
}
