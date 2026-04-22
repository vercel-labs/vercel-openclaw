/**
 * Canonical deployment requirement IDs.
 * Shared between deployment-contract.ts and channel-connectability.ts
 * so both surfaces stay in sync without manual duplication.
 */
export type DeploymentRequirementId =
  | "public-origin"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "codex-credentials"
  | "openclaw-package-spec"
  | "oauth-client-id"
  | "oauth-client-secret"
  | "session-secret"
  | "cron-secret";

export type DeploymentRequirementStatus = "pass" | "warn" | "fail";
