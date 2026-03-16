import { getAuthMode } from "@/server/env";
import { getProtectionBypassSecret } from "@/server/public-url";

export type WebhookBypassRequirementReason =
  | "admin-secret"
  | "sign-in-with-vercel"
  | "local-or-non-vercel";

export type WebhookBypassRequirement = {
  required: boolean;
  configured: boolean;
  reason: WebhookBypassRequirementReason;
};

export function getWebhookBypassRequirement(): WebhookBypassRequirement {
  const configured = Boolean(getProtectionBypassSecret());

  // Webhook bypass is never required with admin-secret auth — the app
  // handles auth itself. If VERCEL_AUTOMATION_BYPASS_SECRET is set, it is
  // applied opportunistically to webhook URLs.
  const reason = getAuthMode() === "admin-secret" ? "admin-secret" : "sign-in-with-vercel";
  return { required: false, configured, reason };
}

export function getWebhookBypassStatusMessage(
  input: WebhookBypassRequirement,
): string {
  if (input.configured) {
    return "Webhook URLs will include x-vercel-protection-bypass (opportunistic).";
  }

  return "Webhook bypass is not required — the app handles auth via admin secret.";
}
