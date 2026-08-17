/**
 * Who is allowed to drive the agent.
 *
 * This exists because the Connect front door bypasses OpenClaw's own channel
 * gates. OpenClaw normally decides this itself through DM allowlists, pairing,
 * mention activation and route gates (docs.openclaw.ai/plugins/sdk-channel-ingress),
 * but none of that runs when the host owns the channel and only hands OpenClaw a
 * message. Andrew Qu flagged exactly this on 2026-08-14: "a lot of the configs
 * of the actual openclaw installation won't be respected".
 *
 * So the policy has to live here, and it fails closed. An unset or empty
 * allowlist admits nobody: a misconfigured deployment that silently let the
 * whole workspace drive an agent with tools and workspace access would be a
 * worse outcome than one that answers no one.
 */

export interface AccessDecision {
  allowed: boolean;
  /** Machine-readable reason, for logs. Never returned to the caller. */
  reason: 'allowed' | 'not_configured' | 'user_not_allowed' | 'no_user';
}

/** Parses the allowlist env var. Accepts commas and whitespace. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Decides whether a Slack user may invoke the agent.
 *
 * Slack user ids are case-sensitive and opaque, so they are compared exactly
 * rather than normalized.
 */
export function decideAccess(
  userId: string | undefined,
  raw: string | undefined = process.env.OPENCLAW_ALLOWED_SLACK_USERS,
): AccessDecision {
  const allowlist = parseAllowlist(raw);
  if (allowlist.length === 0) return { allowed: false, reason: 'not_configured' };
  if (!userId) return { allowed: false, reason: 'no_user' };
  if (!allowlist.includes(userId)) return { allowed: false, reason: 'user_not_allowed' };
  return { allowed: true, reason: 'allowed' };
}
