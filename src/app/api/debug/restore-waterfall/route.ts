import { createHash } from "node:crypto";

import { jsonOk } from "@/shared/http";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { requireDebugEnabled } from "@/server/auth/debug-guard";
import {
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import {
  resolveAiGatewayCredentialOptional,
  isVercelDeployment,
} from "@/server/env";
import {
  buildGatewayConfig,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
} from "@/server/openclaw/config";
import {
  buildRestoreAssetManifest,
  buildDynamicRestoreFiles,
} from "@/server/openclaw/restore-assets";
import { toNetworkPolicy } from "@/server/firewall/policy";
import { getSandboxVcpus } from "@/server/sandbox/resources";
import { getSandboxSleepAfterMs } from "@/server/sandbox/timeout";
import { getPublicOrigin } from "@/server/public-url";
import { stopSandbox } from "@/server/sandbox/lifecycle";
import { getSandboxController } from "@/server/sandbox/controller";

type WaterfallEntry = {
  step: string;
  startMs: number;
  endMs: number;
  deltaMs: number;
};

export async function POST(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const waterfall: WaterfallEntry[] = [];
  const t0 = Date.now();

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now() - t0;
    const result = await fn();
    const end = Date.now() - t0;
    waterfall.push({ step: name, startMs: start, endMs: end, deltaMs: end - start });
    return result;
  };

  const stepSync = <T>(name: string, fn: () => T): T => {
    const start = Date.now() - t0;
    const result = fn();
    const end = Date.now() - t0;
    waterfall.push({ step: name, startMs: start, endMs: end, deltaMs: end - start });
    return result;
  };

  try {
    // Phase 0: Stop the sandbox so we can restore from snapshot
    await step("stopSandbox", async () => {
      try {
        await stopSandbox();
      } catch (err) {
        // Already stopped or not running — that's fine
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("not running") && !msg.includes("SANDBOX_NOT_RUNNING")) {
          throw err;
        }
      }
    });

    // Phase 1: Read metadata
    const meta = await step("getInitializedMeta_1", () => getInitializedMeta());

    if (!meta.snapshotId) {
      return jsonOk({ error: "no snapshot to restore from", waterfall, totalMs: Date.now() - t0 });
    }

    // Phase 2: Resolve AI Gateway credential
    const credential = await step("resolveCredential", () => resolveAiGatewayCredentialOptional());

    if (isVercelDeployment() && !credential) {
      return jsonOk({
        error: "no AI Gateway credential available on Vercel",
        waterfall,
        totalMs: Date.now() - t0,
      });
    }

    // Phase 3: Set status to restoring
    await step("mutateMeta_restoring", () =>
      mutateMeta((m) => {
        m.status = "restoring";
        m.lastError = null;
      }),
    );

    // Phase 4: Read latest metadata
    const latest = await step("getInitializedMeta_2", () => getInitializedMeta());

    // Phase 5: Build config payloads (sync)
    const origin = getPublicOrigin(request);
    const freshApiKey = credential?.token;
    const slackConfig = latest.channels.slack;

    const configJson = stepSync("buildGatewayConfig", () =>
      buildGatewayConfig(
        freshApiKey,
        origin,
        latest.channels.telegram?.botToken,
        slackConfig
          ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
          : undefined,
      ),
    );
    const configJsonB64 = Buffer.from(configJson).toString("base64");

    stepSync("buildRestoreAssetManifest", () => buildRestoreAssetManifest());

    const firewallPolicy = stepSync("toNetworkPolicy", () =>
      toNetworkPolicy(latest.firewall.mode, latest.firewall.allowlist),
    );

    const vcpus = getSandboxVcpus();
    const sleepAfterMs = getSandboxSleepAfterMs();

    // Phase 6: Build restore env
    const restoreEnv: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: latest.gatewayToken,
      OPENCLAW_CONFIG_JSON_B64: configJsonB64,
    };
    if (freshApiKey) {
      restoreEnv.AI_GATEWAY_API_KEY = freshApiKey;
      restoreEnv.OPENAI_API_KEY = freshApiKey;
      restoreEnv.OPENAI_BASE_URL = "https://ai-gateway.vercel.sh/v1";
    }

    // Phase 7: Create sandbox from snapshot
    const sandbox = await step("Sandbox.create", async () => {
      const controller = getSandboxController();
      return controller.create({
        ports: [3000],
        timeout: sleepAfterMs,
        resources: { vcpus },
        source: { type: "snapshot", snapshotId: meta.snapshotId! },
        env: restoreEnv,
        networkPolicy: firewallPolicy,
      });
    });

    // Phase 8: Update metadata with new sandbox ID
    await step("mutateMeta_sandboxId", () =>
      mutateMeta((m) => {
        m.sandboxId = sandbox.sandboxId;
      }),
    );

    // Phase 9: Config write check — skip if hash matches
    const currentConfigHash = stepSync("computeConfigHash", () => {
      const hashSlackConfig = latest.channels.slack;
      const hashConfigJson = buildGatewayConfig(
        undefined,
        "https://__config_hash_placeholder__",
        latest.channels.telegram?.botToken,
        hashSlackConfig
          ? { botToken: hashSlackConfig.botToken, signingSecret: hashSlackConfig.signingSecret }
          : undefined,
      );
      return createHash("sha256").update(hashConfigJson).digest("hex");
    });
    const skippedConfigWrite = latest.snapshotConfigHash === currentConfigHash;

    if (!skippedConfigWrite) {
      await step("writeFiles_dynamicConfig", async () => {
        await sandbox.writeFiles(
          buildDynamicRestoreFiles({
            proxyOrigin: origin,
            apiKey: freshApiKey,
            telegramBotToken: latest.channels.telegram?.botToken,
            slackCredentials: slackConfig
              ? { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret }
              : undefined,
          }),
        );
      });
    } else {
      waterfall.push({
        step: "writeFiles_dynamicConfig_SKIPPED",
        startMs: Date.now() - t0,
        endMs: Date.now() - t0,
        deltaMs: 0,
      });
    }

    // Phase 10: Set status to booting
    await step("mutateMeta_booting", () =>
      mutateMeta((m) => {
        m.status = "booting";
        m.sandboxId = sandbox.sandboxId;
        m.lastAccessedAt = Date.now();
        m.lastError = null;
      }),
    );

    // Phase 11: THE KEY MEASUREMENT — runCommand fast restore
    const READINESS_TIMEOUT_SECONDS = 30;
    const restoreResult = await step("runCommand_fastRestore", () =>
      sandbox.runCommand("bash", [
        OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
        String(READINESS_TIMEOUT_SECONDS),
      ]),
    );

    // Phase 12: Parse output
    let scriptOutput = "";
    let parsedReadyMs: number | null = null;
    await step("parseOutput", async () => {
      scriptOutput = await restoreResult.output("stdout");
      try {
        const parsed = JSON.parse(scriptOutput.trim());
        parsedReadyMs = typeof parsed.readyMs === "number" ? parsed.readyMs : null;
      } catch {
        // Script exited 0 but no JSON — that's ok
      }
    });

    const exitCode = restoreResult.exitCode;

    // Phase 13: Mark running
    await step("mutateMeta_running", () =>
      mutateMeta((m) => {
        m.status = "running";
        m.lastError = null;
        if (credential) {
          m.lastTokenRefreshAt = Date.now();
          m.lastTokenSource = credential.source;
          m.lastTokenExpiresAt = credential.expiresAt ?? null;
        }
      }),
    );

    // Phase 14: Snapshot for cleanup (re-snapshot so we can restore again)
    await step("snapshot_cleanup", () => sandbox.snapshot());

    const totalMs = Date.now() - t0;

    return jsonOk({
      waterfall,
      totalMs,
      summary: {
        stopMs: waterfall.find((w) => w.step === "stopSandbox")?.deltaMs ?? null,
        credentialMs: waterfall.find((w) => w.step === "resolveCredential")?.deltaMs ?? null,
        createMs: waterfall.find((w) => w.step === "Sandbox.create")?.deltaMs ?? null,
        runCommandMs: waterfall.find((w) => w.step === "runCommand_fastRestore")?.deltaMs ?? null,
        snapshotMs: waterfall.find((w) => w.step === "snapshot_cleanup")?.deltaMs ?? null,
        scriptReadyMs: parsedReadyMs,
        configWriteSkipped: skippedConfigWrite,
      },
      scriptOutput: scriptOutput.trim(),
      scriptExitCode: exitCode,
      vcpus,
      snapshotId: meta.snapshotId,
      sandboxId: sandbox.sandboxId,
    });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        waterfall,
        totalMs: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
