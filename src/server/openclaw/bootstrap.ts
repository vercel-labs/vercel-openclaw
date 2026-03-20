import { logError, logInfo, logWarn } from "@/server/log";
import { getOpenclawPackageSpec, isVercelDeployment } from "@/server/env";
import { isPinnedPackageSpec } from "@/server/deployment-contract";
import {
  buildFastRestoreScript,
  buildForcePairScript,
  buildGatewayConfig,
  buildImageGenScript,
  buildImageGenSkill,
  buildStartupScript,
  buildWebSearchSkill,
  buildWebSearchScript,
  buildVisionSkill,
  buildVisionScript,
  buildTtsSkill,
  buildTtsScript,
  buildStructuredExtractSkill,
  buildStructuredExtractScript,
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  BUN_BIN,
  BUN_DOWNLOAD_SHA256,
  BUN_DOWNLOAD_URL,
  BUN_INSTALL_DIR,
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
  OPENCLAW_VISION_SKILL_PATH,
  OPENCLAW_VISION_SCRIPT_PATH,
  OPENCLAW_TTS_SKILL_PATH,
  OPENCLAW_TTS_SCRIPT_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_BOT_TOKEN_PATH,
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
    telegramBotToken?: string;
    slackCredentials?: { botToken: string; signingSecret: string };
  },
): Promise<{ startupScript: string; openclawVersion: string | null; runtime: BootstrapRuntime }> {
  const startupScript = buildStartupScript();

  const packageSpec = getOpenclawPackageSpec();
  const onVercel = isVercelDeployment();

  if (onVercel && !isPinnedPackageSpec(packageSpec)) {
    logError("openclaw.setup.unpinned_package_spec", {
      sandboxId: sandbox.sandboxId,
      packageSpec,
      reason: "Vercel deployments require a pinned OPENCLAW_PACKAGE_SPEC for deterministic restores",
    });
    throw new Error(
      `OPENCLAW_PACKAGE_SPEC must be a pinned version on Vercel deployments (e.g. "openclaw@1.2.3"), got "${packageSpec}".`,
    );
  }

  logInfo("openclaw.setup.start", { sandboxId: sandbox.sandboxId, packageSpec, onVercel });

  const installResult = await sandbox.runCommand({
    cmd: "npm",
    args: [
      "install",
      "-g",
      packageSpec,
      "--ignore-scripts",
    ],
    env: {
      NPM_CONFIG_CACHE: "/tmp/openclaw-npm-cache",
    },
  });
  await assertCommandSuccess("npm install", installResult);

  // Install Bun for faster gateway startup on snapshot restore.
  // Bun's JSC engine loads the 577MB/10K-file openclaw package ~33% faster
  // than Node.js v22 on 1 vCPU.  Best-effort — restore falls back to Node
  // if Bun is missing.
  //
  // Downloads the pinned release binary directly from GitHub, verifies its
  // SHA-256, and extracts to BUN_INSTALL_DIR.  No remote installer script
  // is executed.
  const bunInstall = await sandbox.runCommand("sh", [
    "-c",
    [
      "set -e",
      `curl -fsSL --max-time 60 --connect-timeout 10 -o /tmp/bun.zip ${JSON.stringify(BUN_DOWNLOAD_URL)}`,
      `printf '%s  /tmp/bun.zip\\n' ${JSON.stringify(BUN_DOWNLOAD_SHA256)} | sha256sum -c`,
      `mkdir -p ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
      `unzip -o -j /tmp/bun.zip -d ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
      `chmod +x ${JSON.stringify(BUN_BIN)}`,
      `rm -f /tmp/bun.zip`,
      `${JSON.stringify(BUN_BIN)} --version`,
    ].join(" && "),
  ]);
  if (bunInstall.exitCode === 0) {
    const bunVersion = (await bunInstall.output("stdout")).trim();
    logInfo("openclaw.setup.bun_installed", { sandboxId: sandbox.sandboxId, bunVersion });
  } else {
    const stderr = (await bunInstall.output("stderr")).trim();
    logWarn("openclaw.setup.bun_install_failed", {
      sandboxId: sandbox.sandboxId,
      exitCode: bunInstall.exitCode,
      stderr: stderr.slice(-500),
    });
  }

  const npmCacheCleanup = await sandbox.runCommand("bash", [
    "-lc",
    "rm -rf /home/vercel-sandbox/.npm /root/.npm /tmp/openclaw-npm-cache",
  ]);
  await assertCommandSuccess("npm cache cleanup", npmCacheCleanup);
  logInfo("openclaw.setup.npm_cache_cleared", { sandboxId: sandbox.sandboxId });

  await sandbox.writeFiles([
    {
      path: OPENCLAW_CONFIG_PATH,
      content: Buffer.from(
        buildGatewayConfig(options.apiKey, options.proxyOrigin, options.telegramBotToken, options.slackCredentials),
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
      path: OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      content: Buffer.from(buildFastRestoreScript()),
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
    {
      path: OPENCLAW_WEB_SEARCH_SKILL_PATH,
      content: Buffer.from(buildWebSearchSkill()),
    },
    {
      path: OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
      content: Buffer.from(buildWebSearchScript()),
    },
    {
      path: OPENCLAW_VISION_SKILL_PATH,
      content: Buffer.from(buildVisionSkill()),
    },
    {
      path: OPENCLAW_VISION_SCRIPT_PATH,
      content: Buffer.from(buildVisionScript()),
    },
    {
      path: OPENCLAW_TTS_SKILL_PATH,
      content: Buffer.from(buildTtsSkill()),
    },
    {
      path: OPENCLAW_TTS_SCRIPT_PATH,
      content: Buffer.from(buildTtsScript()),
    },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
      content: Buffer.from(buildStructuredExtractSkill()),
    },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
      content: Buffer.from(buildStructuredExtractScript()),
    },
    ...(options.telegramBotToken
      ? [{ path: OPENCLAW_TELEGRAM_BOT_TOKEN_PATH, content: Buffer.from(options.telegramBotToken) }]
      : []),
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

const GATEWAY_DIAG_MAX_CHARS = 7000;

/**
 * Best-effort sandbox introspection when the gateway readiness probe exhausts.
 * Emits structured fields for Vercel function logs (ring buffer + stderr).
 */
async function collectGatewayWaitFailureDiagnostics(
  sandbox: SandboxHandle,
): Promise<Record<string, string>> {
  const cap = (s: string) => s.replace(/\r/g, "").slice(0, GATEWAY_DIAG_MAX_CHARS);
  const diag: Record<string, string> = {};

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== GET http://127.0.0.1:3000/ (no -f, stderr merged) ==='",
        "curl -sS --max-time 8 -w '\\n__http_code:%{http_code}\\n' http://127.0.0.1:3000/ 2>&1 | head -c 4000",
      ].join("\n"),
    ]);
    diag.httpProbe = cap(await r.output("both"));
  } catch (e) {
    diag.httpProbe = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== openclaw log files (tail) ==='",
        "found=0",
        "for f in /tmp/openclaw/openclaw-*.log; do",
        '  [ -f "$f" ] || continue',
        "  found=1",
        '  echo "--- $f ---"',
        '  tail -n 50 "$f"',
        "done",
        '[ "$found" = 0 ] && echo "(no /tmp/openclaw/openclaw-*.log)"',
      ].join("\n"),
    ]);
    diag.openclawLogs = cap(await r.output("both"));
  } catch (e) {
    diag.openclawLogs = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== listeners :3000 ==='",
        "(command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep 3000) || true",
        "(netstat -tlnp 2>/dev/null | grep 3000) || true",
        "echo '=== node / openclaw processes ==='",
        "ps aux 2>/dev/null | grep -E '[n]ode|[o]penclaw' | head -20 || true",
      ].join("\n"),
    ]);
    diag.portsAndProcesses = cap(await r.output("both"));
  } catch (e) {
    diag.portsAndProcesses = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return diag;
}

export async function waitForGatewayReady(
  sandbox: SandboxHandle,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 60;
  const delayMs = options?.delayMs ?? 1000;

  logInfo("openclaw.gateway_wait_start", {
    sandboxId: sandbox.sandboxId,
    maxAttempts,
    delayMs,
  });

  let lastProbe: Record<string, unknown> = {};

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await sandbox.runCommand("curl", [
        "-s",
        "-f",
        "--max-time",
        "5",
        "http://localhost:3000/",
      ]);
      const body = await result.output("stdout");
      let stderr = "";
      try {
        stderr = await result.output("stderr");
      } catch {
        // Some test doubles only implement a single output stream.
      }
      lastProbe = {
        exitCode: result.exitCode,
        bodyBytes: body.length,
        bodyHead: body.slice(0, 500),
        stderrHead: stderr.slice(0, 400),
        hasOpenclawMarker: body.includes("openclaw-app"),
      };
      if (result.exitCode === 0 && body.includes("openclaw-app")) {
        logInfo("openclaw.gateway_wait_ok", {
          sandboxId: sandbox.sandboxId,
          attempts: attempt + 1,
        });
        return;
      }
    } catch (err) {
      lastProbe = {
        probeThrew: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const n = attempt + 1;
    if (n % 30 === 0) {
      logWarn("openclaw.gateway_wait_pending", {
        sandboxId: sandbox.sandboxId,
        attempt: n,
        maxAttempts,
        lastProbe,
      });
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }

  const diagnostics = await collectGatewayWaitFailureDiagnostics(sandbox);
  logError("openclaw.gateway_wait_exhausted", {
    sandboxId: sandbox.sandboxId,
    maxAttempts,
    delayMs,
    lastProbe,
    ...diagnostics,
  });

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
