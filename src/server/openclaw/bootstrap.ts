import type { Sandbox } from "@vercel/sandbox";

import { logInfo } from "@/server/log";
import {
  buildForcePairScript,
  buildGatewayConfig,
  buildStartupScript,
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";

export async function setupOpenClaw(
  sandbox: Sandbox,
  options: {
    gatewayToken: string;
    apiKey?: string;
    proxyOrigin: string;
  },
): Promise<{ startupScript: string }> {
  const startupScript = buildStartupScript();
  logInfo("openclaw.setup.start", { sandboxId: sandbox.sandboxId });

  await sandbox.runCommand("npm", [
    "install",
    "-g",
    "openclaw@latest",
    "--ignore-scripts",
  ]);

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
  ]);

  const versionResult = await sandbox.runCommand(OPENCLAW_BIN, ["--version"]);
  logInfo("openclaw.setup.installed", {
    sandboxId: sandbox.sandboxId,
    version: (await versionResult.output("stdout")).trim(),
  });

  await sandbox.runCommand("bash", [OPENCLAW_STARTUP_SCRIPT_PATH]);
  await waitForGatewayReady(sandbox);

  try {
    await sandbox.runCommand("node", [
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STATE_DIR,
    ]);
  } catch {
    // Best-effort only.
  }

  logInfo("openclaw.setup.ready", { sandboxId: sandbox.sandboxId });
  return { startupScript };
}

export async function waitForGatewayReady(sandbox: Sandbox): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(1000);
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

  throw new Error("Gateway never became ready within 60 seconds.");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
