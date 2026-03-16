import { logInfo } from "@/server/log";
import { getOpenclawPackageSpec, isVercelDeployment } from "@/server/env";
import { isPinnedPackageSpec } from "@/server/deployment-contract";
import {
  buildForcePairScript,
  buildGatewayConfig,
  buildImageGenScript,
  buildImageGenSkill,
  buildStartupScript,
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";

import type { CommandResult, SandboxHandle } from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Structured command-failure error
// ---------------------------------------------------------------------------

export class CommandFailedError extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly trimmedOutput: string;

  constructor(opts: { command: string; exitCode: number; output: string }) {
    const trimmed = opts.output.trim().slice(-500);
    super(
      `Command "${opts.command}" failed with exit code ${opts.exitCode}: ${trimmed}`,
    );
    this.name = "CommandFailedError";
    this.command = opts.command;
    this.exitCode = opts.exitCode;
    this.trimmedOutput = trimmed;
  }

  toJSON() {
    return {
      error: this.name,
      command: this.command,
      exitCode: this.exitCode,
      output: this.trimmedOutput,
    };
  }
}

async function assertCommandSuccess(
  label: string,
  result: CommandResult,
): Promise<void> {
  if (result.exitCode !== 0) {
    const output = await result.output("both");
    throw new CommandFailedError({
      command: label,
      exitCode: result.exitCode,
      output,
    });
  }
}

export type BootstrapRuntime = {
  packageSpec: string;
  installedVersion: string | null;
  drift: boolean;
};

export async function setupOpenClaw(
  sandbox: SandboxHandle,
  options: {
    gatewayToken: string;
    apiKey?: string;
    proxyOrigin: string;
  },
): Promise<{ startupScript: string; openclawVersion: string | null; runtime: BootstrapRuntime }> {
  const startupScript = buildStartupScript();

  const packageSpec = getOpenclawPackageSpec();
  if (!packageSpec) {
    // Same wording as deployment-contract checkOpenclawPackageSpec for consistency.
    throw new Error(
      "OPENCLAW_PACKAGE_SPEC is required on Vercel deployments. " +
      "Set OPENCLAW_PACKAGE_SPEC to a pinned version such as openclaw@1.2.3 and redeploy.",
    );
  }

  if (isVercelDeployment() && !isPinnedPackageSpec(packageSpec)) {
    throw new Error(
      `OPENCLAW_PACKAGE_SPEC must be a pinned version on Vercel (got "${packageSpec}"). ` +
      "Set OPENCLAW_PACKAGE_SPEC to a pinned version such as openclaw@1.2.3 and redeploy.",
    );
  }

  logInfo("openclaw.setup.start", { sandboxId: sandbox.sandboxId, packageSpec });

  const installResult = await sandbox.runCommand("npm", [
    "install",
    "-g",
    packageSpec,
    "--ignore-scripts",
  ]);
  await assertCommandSuccess("npm install", installResult);

  await sandbox.writeFiles([
    {
      path: OPENCLAW_CONFIG_PATH,
      content: Buffer.from(
        buildGatewayConfig(options.apiKey, options.proxyOrigin),
      ),
    },
    {
      path: OPENCLAW_GATEWAY_TOKEN_PATH,
      content: Buffer.from(options.gatewayToken),
    },
    {
      path: OPENCLAW_AI_GATEWAY_API_KEY_PATH,
      content: Buffer.from(options.apiKey ?? ""),
    },
    {
      path: OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      content: Buffer.from(buildForcePairScript()),
    },
    {
      path: OPENCLAW_STARTUP_SCRIPT_PATH,
      content: Buffer.from(startupScript),
    },
    {
      path: OPENCLAW_IMAGE_GEN_SKILL_PATH,
      content: Buffer.from(buildImageGenSkill()),
    },
    {
      path: OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
      content: Buffer.from(buildImageGenScript()),
    },
    {
      path: OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
      content: Buffer.from(buildImageGenSkill()),
    },
    {
      path: OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
      content: Buffer.from(buildImageGenScript()),
    },
  ]);

  const versionResult = await sandbox.runCommand(OPENCLAW_BIN, ["--version"]);
  await assertCommandSuccess("openclaw --version", versionResult);
  const openclawVersion = normalizeOpenClawVersion(
    await versionResult.output("stdout"),
  );

  const drift = detectDrift(packageSpec, openclawVersion);
  const runtime: BootstrapRuntime = { packageSpec, installedVersion: openclawVersion, drift };

  logInfo("openclaw.setup.installed", {
    sandboxId: sandbox.sandboxId,
    packageSpec,
    installedVersion: openclawVersion,
    drift,
  });

  const startupResult = await sandbox.runCommand("bash", [OPENCLAW_STARTUP_SCRIPT_PATH]);
  await assertCommandSuccess("bash startup-script", startupResult);
  await waitForGatewayReady(sandbox);

  try {
    await sandbox.runCommand("node", [
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STATE_DIR,
    ]);
  } catch {
    // Best-effort only.
  }

  logInfo("openclaw.setup.ready", { sandboxId: sandbox.sandboxId, runtime });
  return { startupScript, openclawVersion, runtime };
}

export async function waitForGatewayReady(
  sandbox: SandboxHandle,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 60;
  const delayMs = options?.delayMs ?? 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(delayMs);
    try {
      const result = await sandbox.runCommand("curl", [
        "-s",
        "-f",
        "--max-time",
        "5",
        "http://localhost:3000/",
      ]);
      const body = await result.output("stdout");
      if (result.exitCode === 0 && body.includes("openclaw-app")) {
        return;
      }
    } catch {
      // Continue probing.
    }
  }

  throw new Error(`Gateway never became ready within ${maxAttempts} attempts.`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOpenClawVersion(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Detect whether the installed version drifts from the requested package spec.
 *
 * A pinned spec like "openclaw@1.2.3" should match the installed version exactly.
 * Range specs ("openclaw@^1.0.0") or "openclaw@latest" always report drift=true
 * because the resolved version is non-deterministic.
 */
export function detectDrift(packageSpec: string, installedVersion: string | null): boolean {
  if (!installedVersion) return true;

  // Extract the version part after @
  const atIdx = packageSpec.lastIndexOf("@");
  if (atIdx <= 0) return true;

  const specVersion = packageSpec.slice(atIdx + 1);

  // "latest", "next", or any dist-tag is always drifty
  if (!/^\d/.test(specVersion)) return true;

  // Range specs (^, ~, >=, etc.) are non-deterministic
  if (/[~^>=<|*x]/.test(specVersion)) return true;

  // Exact pinned version — compare directly
  return specVersion !== installedVersion;
}
