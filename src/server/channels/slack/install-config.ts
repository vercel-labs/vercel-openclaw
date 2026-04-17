/**
 * Resolves Slack OAuth app credentials used by the install flow and the
 * webhook signature check.
 *
 * Resolution order:
 *   1. Redis `slack:app-config` — written by `apps.manifest.create`
 *      via `POST /api/channels/slack/app`. This is the default path
 *      for `vclaw create --slack`.
 *   2. `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`
 *      env vars — preserved for operators who pre-created the app by hand.
 */

import { getSlackAppConfig } from "@/server/channels/slack/app-config";

export type SlackInstallConfig = {
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  /** Where the credentials came from. Useful for operator telemetry. */
  source: "redis" | "env" | "none";
  /** True when all three credentials are present. */
  enabled: boolean;
};

export async function getSlackInstallConfig(): Promise<SlackInstallConfig> {
  const stored = await getSlackAppConfig().catch(() => null);
  if (stored?.clientId && stored.clientSecret && stored.signingSecret) {
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      signingSecret: stored.signingSecret,
      source: "redis",
      enabled: true,
    };
  }

  const clientId = process.env.SLACK_CLIENT_ID?.trim() || null;
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || null;
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim() || null;
  const enabled = Boolean(clientId && clientSecret && signingSecret);

  return {
    clientId,
    clientSecret,
    signingSecret,
    source: enabled ? "env" : "none",
    enabled,
  };
}
