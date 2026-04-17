import { logInfo } from "@/server/log";

const VALID_VCPUS = new Set([1, 2, 4, 8]);

let vcpusLogged = false;

export function _resetSandboxVcpusLoggedForTesting(): void {
  vcpusLogged = false;
}

/**
 * Return the configured sandbox vCPU count.
 *
 * Reads `OPENCLAW_SANDBOX_VCPUS` and validates it against the set of
 * values the Vercel Sandbox API accepts (1, 2, 4, 8).  Falls back to 1
 * when the variable is missing or invalid.
 *
 * Pure function of the environment variable — no side effects beyond a
 * single structured log line on first resolution.
 */
export function getSandboxVcpus(): number {
  const raw = process.env.OPENCLAW_SANDBOX_VCPUS;
  if (raw === undefined || raw === "") {
    return 1;
  }

  const parsed = Number.parseInt(raw, 10);
  if (VALID_VCPUS.has(parsed)) {
    if (!vcpusLogged) {
      vcpusLogged = true;
      logInfo("sandbox.resources.vcpus_resolved", { vcpus: parsed, source: "env" });
    }
    return parsed;
  }

  if (!vcpusLogged) {
    vcpusLogged = true;
    logInfo("sandbox.resources.vcpus_fallback", {
      raw,
      parsed,
      fallback: 1,
      reason: "invalid_value",
    });
  }
  return 1;
}
