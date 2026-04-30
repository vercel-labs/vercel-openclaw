import { logError, logInfo, logWarn } from "@/server/log";
import { getOpenclawPackageSpec, isVercelDeployment } from "@/server/env";
import { isPinnedPackageSpec } from "@/server/deployment-contract";
import type { WhatsAppGatewayConfig } from "@/server/openclaw/config";
import {
  buildStartupScript,
  BUN_BIN,
  BUN_DOWNLOAD_SHA256,
  BUN_DOWNLOAD_URL,
  BUN_INSTALL_DIR,
  getOpenclawBundleUiUrl,
  getOpenclawBundleUrl,
  getOpenclawGatewayCmd,
  OPENCLAW_BIN,
  OPENCLAW_BUNDLE_PATH,
  OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
  OPENCLAW_LOG_FILE,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";
import {
  buildOpenClawInstallPatchScript,
  parseOpenClawInstallPatchOutcome,
} from "@/server/openclaw/install-patches";
import {
  buildBootstrapFiles,
  buildRestoreAssetManifest,
} from "@/server/openclaw/restore-assets";
import type { SetupProgressWriter } from "@/server/sandbox/setup-progress";

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
    telegramWebhookSecret?: string;
    whatsappConfig?: WhatsAppGatewayConfig;
    progress?: SetupProgressWriter;
  },
): Promise<{ startupScript: string; openclawVersion: string | null; runtime: BootstrapRuntime }> {
  const startupScript = buildStartupScript();
  const progress = options.progress;

  const packageSpec = getOpenclawPackageSpec();
  const onVercel = isVercelDeployment();

  if (onVercel && !isPinnedPackageSpec(packageSpec)) {
    logWarn("openclaw.setup.unpinned_package_spec", {
      sandboxId: sandbox.sandboxId,
      packageSpec,
      reason: "Vercel deployments should use a pinned OPENCLAW_PACKAGE_SPEC for deterministic restores — falling back to current spec",
    });
  }

  const bundleUrl = getOpenclawBundleUrl();

  logInfo("openclaw.setup.start", { sandboxId: sandbox.sandboxId, packageSpec, onVercel, bundleUrl: bundleUrl ?? null });

  if (bundleUrl) {
    // ---------- Bundle path: download pre-built bundle from blob storage ----------
    progress?.setPhase("downloading-bundle", `Downloading bundle`);
    const downloadResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `curl -fsSL --max-time 120 --connect-timeout 10 -o ${JSON.stringify(OPENCLAW_BUNDLE_PATH)} ${JSON.stringify(bundleUrl)}`,
          // package.json must use name "openclaw" so the package-root resolver
          // recognizes this directory, enabling channel-catalog.json discovery.
          `echo '{"name":"openclaw","private":true}' > /home/vercel-sandbox/package.json`,
          // Channel catalog — lets the config validator recognize channel IDs
          // (slack, telegram, discord, etc.) without needing installed extensions.
          `mkdir -p /home/vercel-sandbox/dist`,
          `curl -fsSL --max-time 10 --connect-timeout 5 -o /home/vercel-sandbox/dist/channel-catalog.json ${JSON.stringify(new URL("channel-catalog.json", bundleUrl).href)}`,
          // Workspace templates — agent runtime reads these at chat time
          // (AGENTS.md, IDENTITY.md, BOOT.md, etc.). Without them, every
          // chat request fails with "Missing workspace template".
          `mkdir -p /home/vercel-sandbox/docs/reference`,
          `curl -fsSL --max-time 15 --connect-timeout 5 ${JSON.stringify(new URL("workspace-templates.tar.gz", bundleUrl).href)} | tar xz -C /home/vercel-sandbox/docs/reference`,
          // auth-profiles.json — pre-seed the vercel-ai-gateway provider so
          // chat doesn't fail with "No API key found for provider". The
          // bundle doesn't include the vercel-ai-gateway extension at runtime,
          // so the env-var-to-auth-profile bootstrap doesn't run. The key is a
          // placeholder; the real OIDC token is injected by the firewall's
          // network policy header transform on the way to ai-gateway.vercel.sh.
          `mkdir -p /home/vercel-sandbox/.openclaw/agents/main/agent`,
          `printf '%s' '{"version":1,"profiles":{"vercel-ai-gateway:default":{"type":"api_key","provider":"vercel-ai-gateway","key":"sk-placeholder-injected-via-network-policy"}}}' > /home/vercel-sandbox/.openclaw/agents/main/agent/auth-profiles.json`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("bundle download", downloadResult);
    logInfo("openclaw.setup.bundle_downloaded", { sandboxId: sandbox.sandboxId, bundleUrl });

    // Channel-plugins archive: the single-file ESM bundle ships the gateway
    // core but no extensions tree, so channel handlers (slack/telegram/…)
    // never register and webhooks 404 inside the sandbox. Download the
    // sibling channels.tar.gz and extract it; the gateway env shell points
    // OPENCLAW_BUNDLED_PLUGINS_DIR at this directory so the bundle's plugin
    // discovery code finds each plugin on disk.
    const channelsUrl = new URL("channels.tar.gz", bundleUrl).href;
    progress?.setPhase("downloading-bundle", "Downloading channel plugins");
    const channelsResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `mkdir -p ${JSON.stringify(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`,
          `curl -fsSL --max-time 60 --connect-timeout 10 ${JSON.stringify(channelsUrl)} | tar xz -C ${JSON.stringify(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (channelsResult.exitCode === 0) {
      logInfo("openclaw.setup.channels_downloaded", {
        sandboxId: sandbox.sandboxId,
        channelsUrl,
        extractedTo: OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
      });
    } else {
      const stderr = (await channelsResult.output("stderr")).trim();
      logWarn("openclaw.setup.channels_download_failed", {
        sandboxId: sandbox.sandboxId,
        channelsUrl,
        exitCode: channelsResult.exitCode,
        stderr: stderr.slice(-500),
      });
      // Don't fail bootstrap — gateway can still serve non-channel routes
      // and the failure is loud (channel webhooks will 404). This makes
      // the failure mode the same as missing channels.tar.gz at the URL,
      // which we want to surface in launch-verify rather than block boot.
    }

    // Bundle runtime deps: a few packages are kept external to the ESM
    // bundle (currently `jiti`) because they self-reference internal files
    // via relative requires (`require("../dist/babel.cjs")`), which break
    // when bundled because the bundle file's directory is the resolution
    // root. Extract `bundle-deps.tar.gz` next to openclaw.bundle.mjs so
    // its createRequire(import.meta.url) finds them in node_modules/.
    const depsUrl = new URL("bundle-deps.tar.gz", bundleUrl).href;
    progress?.setPhase("downloading-bundle", "Downloading runtime deps");
    const depsResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `curl -fsSL --max-time 30 --connect-timeout 10 ${JSON.stringify(depsUrl)} | tar xz -C /home/vercel-sandbox`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (depsResult.exitCode === 0) {
      logInfo("openclaw.setup.bundle_deps_downloaded", {
        sandboxId: sandbox.sandboxId,
        depsUrl,
      });
    } else {
      const stderr = (await depsResult.output("stderr")).trim();
      logWarn("openclaw.setup.bundle_deps_download_failed", {
        sandboxId: sandbox.sandboxId,
        depsUrl,
        exitCode: depsResult.exitCode,
        stderr: stderr.slice(-500),
      });
      // Don't hard-fail: older bundles (pre bundle-deps.tar.gz) won't
      // publish this artifact. The failure mode is loud (Slack plugin
      // load fails with `Cannot find module '../dist/babel.cjs'`), which
      // is what the operator will see in /tmp/openclaw.log.
    }

    // Synthetic openclaw npm package: ships node_modules/openclaw/ with
    // package.json + plugin-sdk/<subpath>.cjs shims. The shims redirect
    // bare-specifier imports like `openclaw/plugin-sdk/channel-entry-contract`
    // to a globalThis.__OPENCLAW_BUNDLE_PLUGIN_SDK_REGISTRY__ map populated
    // by the bundle at startup. Without this, channel extensions fail to
    // load with `Cannot find module 'openclaw/plugin-sdk/...'`.
    const openclawPkgUrl = new URL("bundle-openclaw-pkg.tar.gz", bundleUrl).href;
    progress?.setPhase("downloading-bundle", "Downloading openclaw shim package");
    const openclawPkgResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `curl -fsSL --max-time 30 --connect-timeout 10 ${JSON.stringify(openclawPkgUrl)} | tar xz -C /home/vercel-sandbox`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (openclawPkgResult.exitCode === 0) {
      logInfo("openclaw.setup.bundle_openclaw_pkg_downloaded", {
        sandboxId: sandbox.sandboxId,
        openclawPkgUrl,
      });
    } else {
      const stderr = (await openclawPkgResult.output("stderr")).trim();
      logWarn("openclaw.setup.bundle_openclaw_pkg_download_failed", {
        sandboxId: sandbox.sandboxId,
        openclawPkgUrl,
        exitCode: openclawPkgResult.exitCode,
        stderr: stderr.slice(-500),
      });
      // Don't hard-fail: older bundles won't publish this artifact.
    }

    // Shared dist chunks: channel extensions and bundle SDK shims may
    // reference dist/<chunk>.js files that live alongside the bundle.
    // Extract at sandbox root so they sit next to openclaw.bundle.mjs.
    const sharedChunksUrl = new URL("channel-shared-chunks.tar.gz", bundleUrl).href;
    progress?.setPhase("downloading-bundle", "Downloading shared chunks");
    const sharedChunksResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `curl -fsSL --max-time 60 --connect-timeout 10 ${JSON.stringify(sharedChunksUrl)} | tar xz -C /home/vercel-sandbox`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (sharedChunksResult.exitCode === 0) {
      logInfo("openclaw.setup.bundle_shared_chunks_downloaded", {
        sandboxId: sandbox.sandboxId,
        sharedChunksUrl,
      });
    } else {
      const stderr = (await sharedChunksResult.output("stderr")).trim();
      logWarn("openclaw.setup.bundle_shared_chunks_download_failed", {
        sandboxId: sandbox.sandboxId,
        sharedChunksUrl,
        exitCode: sharedChunksResult.exitCode,
        stderr: stderr.slice(-500),
      });
    }

    // Download and extract Control UI assets (required for the gateway readiness probe)
    const bundleUiUrl = getOpenclawBundleUiUrl();
    if (bundleUiUrl) {
      progress?.setPhase("downloading-bundle", "Downloading Control UI assets");
      const uiDir = "/home/vercel-sandbox/dist/control-ui";
      const uiResult = await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          [
            "set -e",
            `mkdir -p /home/vercel-sandbox/dist`,
            `curl -fsSL --max-time 30 --connect-timeout 10 ${JSON.stringify(bundleUiUrl)} | tar xz -C /home/vercel-sandbox/dist`,
          ].join(" && "),
        ],
        stdout: progress?.makeWritable("stdout"),
        stderr: progress?.makeWritable("stderr"),
      });
      if (uiResult.exitCode === 0) {
        logInfo("openclaw.setup.bundle_ui_downloaded", { sandboxId: sandbox.sandboxId, bundleUiUrl });
      } else {
        logWarn("openclaw.setup.bundle_ui_download_failed", {
          sandboxId: sandbox.sandboxId,
          bundleUiUrl,
          exitCode: uiResult.exitCode,
        });
      }
    }
  } else {
    // ---------- npm install path (existing) ----------
    progress?.setPhase("installing-openclaw", `Installing ${packageSpec}`);
    const installResult = await sandbox.runCommand({
      cmd: "npm",
      args: [
        "install",
        "-g",
        packageSpec,
        "--ignore-scripts",
        "--loglevel",
        "info",
      ],
      env: {
        NPM_CONFIG_CACHE: "/tmp/openclaw-npm-cache",
        NPM_CONFIG_PROGRESS: "false",
      },
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("npm install", installResult);

    // Install missing plugin peer dependencies into the openclaw package directory.
    // OpenClaw 2026.3.31+ bundles plugins (slack, telegram, discord, bedrock) but
    // their peer deps aren't installed with --ignore-scripts.  Without these, the
    // gateway returns 500 on all routes during plugin init.
    progress?.setPhase("installing-peer-deps", "Installing missing peer dependencies");
    const peerDepResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "set -e",
          "OC_PKG=/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw",
          "mkdir -p /tmp/openclaw-peer-deps && cd /tmp/openclaw-peer-deps",
          "npm init -y > /dev/null 2>&1",
          "npm install @buape/carbon @slack/web-api grammy --no-save --ignore-scripts --loglevel warn 2>&1",
          "mkdir -p $OC_PKG/node_modules",
          "cp -r node_modules/@buape node_modules/@slack node_modules/grammy $OC_PKG/node_modules/ 2>/dev/null || true",
          // Copy scoped package internals that @slack/web-api needs
          "for dep in @slack/types @slack/logger @slack/oauth @slack/socket-mode; do [ -d node_modules/${dep%%/*} ] && cp -r node_modules/${dep%%/*} $OC_PKG/node_modules/ 2>/dev/null; done || true",
          "rm -rf /tmp/openclaw-peer-deps",
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (peerDepResult.exitCode !== 0) {
      const stderr = (await peerDepResult.output("stderr")).trim();
      logWarn("openclaw.setup.peer_deps_install_failed", {
        sandboxId: sandbox.sandboxId,
        exitCode: peerDepResult.exitCode,
        stderr: stderr.slice(-500),
      });
    } else {
      logInfo("openclaw.bootstrap.peer_deps_ready", { sandboxId: sandbox.sandboxId, package: "@buape/carbon" });
    }

    // Install Bun for faster gateway startup on snapshot restore.
    // Bun's JSC engine loads the 577MB/10K-file openclaw package ~33% faster
    // than Node.js v22 on 1 vCPU.  Best-effort — restore falls back to Node
    // if Bun is missing.
    //
    // Downloads the pinned release binary directly from GitHub, verifies its
    // SHA-256, and extracts to BUN_INSTALL_DIR.  No remote installer script
    // is executed.
    progress?.setPhase("installing-bun", "Installing Bun runtime");
    const bunInstall = await sandbox.runCommand({
      cmd: "sh",
      args: [
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
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (bunInstall.exitCode === 0) {
      const bunVersion = (await bunInstall.output("stdout")).trim();
      progress?.setPreview(`Installed Bun ${bunVersion}`);
      logInfo("openclaw.setup.bun_installed", { sandboxId: sandbox.sandboxId, bunVersion });
    } else {
      const stderr = (await bunInstall.output("stderr")).trim();
      logWarn("openclaw.setup.bun_install_failed", {
        sandboxId: sandbox.sandboxId,
        exitCode: bunInstall.exitCode,
        stderr: stderr.slice(-500),
      });
    }

    progress?.setPhase("cleaning-cache", "Cleaning npm cache");
    const npmCacheCleanup = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "rm -rf /home/vercel-sandbox/.npm || true",
          "rm -rf /root/.npm || true",
          "rm -rf /tmp/openclaw-npm-cache || true",
        ].join("\n"),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("npm cache cleanup", npmCacheCleanup);
    logInfo("openclaw.setup.npm_cache_cleared", { sandboxId: sandbox.sandboxId });
  }

  // Install WhatsApp plugin when enabled.  Idempotent — `openclaw plugins
  // install` is a no-op when the plugin is already present.
  // Skipped in bundle mode — the bundle includes all bundled plugins.
  if (options.whatsappConfig?.enabled && !bundleUrl) {
    const pluginSpec = options.whatsappConfig.pluginSpec?.trim() || "@openclaw/whatsapp";
    progress?.setPhase("installing-plugin", `Installing ${pluginSpec}`);
    logInfo("openclaw.setup.whatsapp_plugin_install", {
      sandboxId: sandbox.sandboxId,
      pluginSpec,
    });
    const pluginResult = await sandbox.runCommand({
      cmd: OPENCLAW_BIN,
      args: [
        "plugins",
        "install",
        pluginSpec,
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (pluginResult.exitCode === 0) {
      logInfo("openclaw.setup.whatsapp_plugin_installed", {
        sandboxId: sandbox.sandboxId,
        pluginSpec,
      });
    } else {
      const stderr = (await pluginResult.output("stderr")).trim();
      logWarn("openclaw.setup.whatsapp_plugin_install_failed", {
        sandboxId: sandbox.sandboxId,
        pluginSpec,
        exitCode: pluginResult.exitCode,
        stderr: stderr.slice(-500),
      });
    }
  }

  progress?.setPhase("writing-config", "Writing gateway config");
  progress?.appendLine("system", "Writing OpenClaw config and startup files");

  const bootstrapFiles = [
    ...buildBootstrapFiles({
      gatewayToken: options.gatewayToken,
      apiKey: options.apiKey,
      proxyOrigin: options.proxyOrigin,
      telegramBotToken: options.telegramBotToken,
      telegramWebhookSecret: options.telegramWebhookSecret,
      slackCredentials: options.slackCredentials,
      whatsappConfig: options.whatsappConfig,
    }),
    {
      path: OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
      content: Buffer.from(buildOpenClawInstallPatchScript()),
    },
  ];

  logInfo("openclaw.setup.bootstrap_files_prepared", {
    sandboxId: sandbox.sandboxId,
    fileCount: bootstrapFiles.length,
    restoreManifestSha256: buildRestoreAssetManifest().sha256,
  });

  await sandbox.writeFiles(bootstrapFiles);

  // Install patches only apply to the npm-installed package tree.
  if (!bundleUrl) {
    progress?.setPhase("patching-openclaw", "Applying OpenClaw install patches");
    const installPatchResult = await sandbox.runCommand({
      cmd: "node",
      args: [OPENCLAW_INSTALL_PATCH_SCRIPT_PATH],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("openclaw install patch", installPatchResult);
    const installPatchOutput = (await installPatchResult.output("stdout")).trim();
    const installPatchOutcome = parseOpenClawInstallPatchOutcome(installPatchOutput);
    if (!installPatchOutcome) {
      logWarn("openclaw.setup.install_patch_output_unparsed", {
        sandboxId: sandbox.sandboxId,
        output: installPatchOutput.slice(0, 500),
      });
    } else if (installPatchOutcome.status === "skipped") {
      logWarn("openclaw.setup.install_patch_skipped", {
        sandboxId: sandbox.sandboxId,
        ...installPatchOutcome,
      });
    } else {
      logInfo("openclaw.setup.install_patch_applied", {
        sandboxId: sandbox.sandboxId,
        ...installPatchOutcome,
      });
    }
  }

  progress?.setPhase("checking-version", "Checking installed version");
  const versionResult = await sandbox.runCommand({
    cmd: bundleUrl ? "node" : OPENCLAW_BIN,
    args: bundleUrl ? [OPENCLAW_BUNDLE_PATH, "--version"] : ["--version"],
    stdout: progress?.makeWritable("stdout"),
    stderr: progress?.makeWritable("stderr"),
  });
  await assertCommandSuccess("openclaw --version", versionResult);
  const openclawVersion = normalizeOpenClawVersion(
    await versionResult.output("stdout"),
  );
  progress?.setPreview(openclawVersion ? `Installed ${openclawVersion}` : "Version check passed");

  const drift = detectDrift(packageSpec, openclawVersion);
  const runtime: BootstrapRuntime = { packageSpec, installedVersion: openclawVersion, drift };

  logInfo("openclaw.setup.installed", {
    sandboxId: sandbox.sandboxId,
    packageSpec,
    installedVersion: openclawVersion,
    drift,
  });

  progress?.setPhase("starting-gateway", "Launching gateway");
  const startupResult = await sandbox.runCommand({
    cmd: "bash",
    args: [OPENCLAW_STARTUP_SCRIPT_PATH],
    stdout: progress?.makeWritable("stdout"),
    stderr: progress?.makeWritable("stderr"),
  });

  const startupStdout = (await startupResult.output("stdout")).trim();
  const startupStderr = (await startupResult.output("stderr")).trim();
  logInfo("openclaw.setup.startup_script_result", {
    sandboxId: sandbox.sandboxId,
    exitCode: startupResult.exitCode,
    stdoutHead: startupStdout.slice(0, 500),
    stderrHead: startupStderr.slice(0, 500),
  });
  progress?.appendLine("system", `Startup script exit=${startupResult.exitCode}`);
  await assertCommandSuccess("bash startup-script", startupResult);

  // Quick process check for debugging gateway launch issues.
  try {
    const psResult = await sandbox.runCommand("bash", ["-c", "ps aux | grep openclaw || true"]);
    const psOut = (await psResult.output("stdout")).trim();
    logInfo("openclaw.setup.process_check", { sandboxId: sandbox.sandboxId, psOutput: psOut.slice(0, 500) });
    progress?.appendLine("system", `Process check: ${psOut.split("\n").filter(l => !l.includes("grep")).join("; ").slice(0, 200)}`);
  } catch { /* best effort */ }

  // Check listening ports and gateway log immediately after launch.
  try {
    const portCheck = await sandbox.runCommand("bash", ["-c",
      "ss -tlnp 2>/dev/null | grep -E '3000|8787' || echo 'no listeners on 3000/8787'",
    ]);
    progress?.appendLine("system", `Ports: ${(await portCheck.output("stdout")).trim().slice(0, 200)}`);
  } catch { /* best effort */ }

  try {
    const logCheck = await sandbox.runCommand("bash", ["-c",
      `tail -20 ${OPENCLAW_LOG_FILE} 2>/dev/null || echo 'no log file'`,
    ]);
    const logOut = (await logCheck.output("stdout")).trim();
    if (logOut) progress?.appendLine("system", `Gateway log: ${logOut.slice(0, 300)}`);
  } catch { /* best effort */ }

  progress?.setPhase("waiting-for-gateway", "Waiting for OpenClaw to respond");
  try {
    await waitForGatewayReady(sandbox);
  } catch (waitErr) {
    // Collect diagnostics before re-throwing so they appear in setup progress.
    try {
      const diag = await collectGatewayWaitFailureDiagnostics(sandbox);
      for (const [k, v] of Object.entries(diag)) {
        progress?.appendLine("system", `[diag:${k}] ${v.slice(0, 300)}`);
      }
    } catch { /* best effort */ }
    throw waitErr;
  }

  try {
    progress?.setPhase("pairing-device", "Pairing device");
    await sandbox.runCommand({
      cmd: "node",
      args: [
        OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
        OPENCLAW_STATE_DIR,
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
  } catch {
    // Best-effort only.
    progress?.appendLine("system", "Pairing step skipped");
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
        "--max-time",
        "5",
        "-w",
        "\n__HTTP_STATUS:%{http_code}",
        "http://localhost:3000/",
      ]);
      const rawBody = await result.output("stdout");
      // Strip the status line appended by -w
      const statusMatch = rawBody.match(/__HTTP_STATUS:(\d+)/);
      const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const body = rawBody.replace(/\n?__HTTP_STATUS:\d+$/, "");
      let stderr = "";
      try {
        stderr = await result.output("stderr");
      } catch {
        // Some test doubles only implement a single output stream.
      }
      const hasMarker = body.includes("openclaw-app");
      lastProbe = {
        attempt: attempt + 1,
        exitCode: result.exitCode,
        httpStatus,
        bodyBytes: body.length,
        bodyHead: body.slice(0, 300),
        stderrHead: stderr.slice(0, 200),
        hasOpenclawMarker: hasMarker,
      };

      // Log every single probe attempt so we can trace exactly what happens.
      logInfo("openclaw.gateway_probe", {
        sandboxId: sandbox.sandboxId,
        attempt: attempt + 1,
        httpStatus,
        exitCode: result.exitCode,
        bodyBytes: body.length,
        hasMarker,
        bodyHead: body.slice(0, 200),
      });

      // Accept any HTTP response from the gateway — the openclaw-app marker
      // is preferred, but a plain HTTP response (even 500) means the gateway
      // is running.  Plugin init errors (e.g. missing @slack/web-api) cause
      // 500 without the marker but the gateway is functional.
      if (hasMarker || (httpStatus > 0 && httpStatus < 600)) {
        logInfo("openclaw.gateway_wait_ok", {
          sandboxId: sandbox.sandboxId,
          attempts: attempt + 1,
          httpStatus,
          hasMarker,
        });
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastProbe = {
        attempt: attempt + 1,
        probeThrew: true,
        error: errMsg.slice(0, 300),
      };
      logInfo("openclaw.gateway_probe", {
        sandboxId: sandbox.sandboxId,
        attempt: attempt + 1,
        threw: true,
        error: errMsg.slice(0, 200),
      });
    }

    const n = attempt + 1;
    // Snapshot ports+processes every 10 probes for deeper visibility.
    if (n % 10 === 0) {
      logWarn("openclaw.gateway_wait_pending", {
        sandboxId: sandbox.sandboxId,
        attempt: n,
        maxAttempts,
        lastProbe,
      });
      try {
        const snap = await sandbox.runCommand("bash", [
          "-c",
          'echo "PORTS:"; ss -tlnp 2>/dev/null | grep -E "3000|8787" || echo "none"; echo "PS:"; ps aux 2>/dev/null | grep -E "[o]penclaw|[n]ode" | head -5 || true',
        ]);
        const snapOut = (await snap.output("stdout")).trim();
        logInfo("openclaw.gateway_snapshot", {
          sandboxId: sandbox.sandboxId,
          attempt: n,
          snapshot: snapOut.slice(0, 500),
        });
      } catch {
        /* best effort */
      }
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
