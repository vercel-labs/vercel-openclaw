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
  | "openclaw-package-spec"
  | "oauth-client-id"
  | "oauth-client-secret"
  | "session-secret";

export type DeploymentRequirementStatus = "pass" | "warn" | "fail";
