import { createHash } from "node:crypto";

import type { WhatsAppGatewayConfig } from "@/server/openclaw/config";
import {
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  buildDiagScript,
  buildFastRestoreScript,
  buildForcePairScript,
  buildGatewayConfig,
  buildGatewayRestartScript,
  buildImageGenScript,
  buildImageGenSkill,
  buildStartupScript,
  buildStructuredExtractScript,
  buildStructuredExtractSkill,
  buildEmbeddingsScript,
  buildEmbeddingsSkill,
  buildSemanticSearchScript,
  buildSemanticSearchSkill,
  buildTranscriptionScript,
  buildTranscriptionSkill,
  buildReasoningScript,
  buildReasoningSkill,
  buildCompareScript,
  buildCompareSkill,
  buildWorkerSandboxScript,
  buildWorkerSandboxSkill,
  buildWorkerSandboxBatchScript,
  buildWorkerSandboxBatchSkill,
  buildTtsScript,
  buildTtsSkill,
  buildVisionScript,
  buildVisionSkill,
  buildWebSearchScript,
  buildWebSearchSkill,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_DIAG_SCRIPT_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_BOT_TOKEN_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
  OPENCLAW_EMBEDDINGS_SCRIPT_PATH,
  OPENCLAW_EMBEDDINGS_SKILL_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH,
  OPENCLAW_TRANSCRIPTION_SCRIPT_PATH,
  OPENCLAW_TRANSCRIPTION_SKILL_PATH,
  OPENCLAW_REASONING_SCRIPT_PATH,
  OPENCLAW_REASONING_SKILL_PATH,
  OPENCLAW_COMPARE_SCRIPT_PATH,
  OPENCLAW_COMPARE_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH,
  OPENCLAW_TTS_SCRIPT_PATH,
  OPENCLAW_TTS_SKILL_PATH,
  OPENCLAW_VISION_SCRIPT_PATH,
  OPENCLAW_VISION_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
  OPENCLAW_WEB_SEARCH_SKILL_PATH,
} from "@/server/openclaw/config";

export const OPENCLAW_RESTORE_ASSET_MANIFEST_PATH =
  `${OPENCLAW_STATE_DIR}/.restore-assets-manifest.json`;

// OpenClaw agent auth-profiles file for OAuth providers (ChatGPT/Codex).
// The agent id "main" is hardcoded — follow-up needed if operators customize
// the agent id in openclaw.json.
export const OPENCLAW_CODEX_AUTH_PROFILES_PATH =
  `${OPENCLAW_STATE_DIR}/agents/main/agent/auth-profiles.json`;

// Inlined here while Unit 1 (src/server/codex/credentials.ts) is unmerged.
// When that lands, re-import from the canonical module.
export type CodexCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  updatedAt: number;
};

export function buildAuthProfilesJson(creds: CodexCredentials): string {
  const entry: Record<string, unknown> = {
    type: "oauth",
    provider: "openai-codex",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
  };
  if (creds.accountId !== undefined) {
    entry.accountId = creds.accountId;
  }
  return JSON.stringify({ "openai-codex:default": entry });
}

export type RestoreAssetManifest = {
  version: 1;
  sha256: string;
  staticPaths: string[];
};

export function buildWorkerSandboxRestoreFiles(): { path: string; content: Buffer }[] {
  return [
    { path: OPENCLAW_WORKER_SANDBOX_SKILL_PATH, content: Buffer.from(buildWorkerSandboxSkill()) },
    { path: OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH, content: Buffer.from(buildWorkerSandboxScript()) },
    { path: OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH, content: Buffer.from(buildWorkerSandboxBatchSkill()) },
    { path: OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH, content: Buffer.from(buildWorkerSandboxBatchScript()) },
  ];
}

export function buildStaticRestoreFiles(): { path: string; content: Buffer }[] {
  return [
    { path: OPENCLAW_FORCE_PAIR_SCRIPT_PATH, content: Buffer.from(buildForcePairScript()) },
    { path: OPENCLAW_STARTUP_SCRIPT_PATH, content: Buffer.from(buildStartupScript()) },
    { path: OPENCLAW_FAST_RESTORE_SCRIPT_PATH, content: Buffer.from(buildFastRestoreScript()) },
    { path: OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH, content: Buffer.from(buildGatewayRestartScript()) },
    { path: OPENCLAW_DIAG_SCRIPT_PATH, content: Buffer.from(buildDiagScript()) },
    { path: OPENCLAW_IMAGE_GEN_SKILL_PATH, content: Buffer.from(buildImageGenSkill()) },
    { path: OPENCLAW_IMAGE_GEN_SCRIPT_PATH, content: Buffer.from(buildImageGenScript()) },
    { path: OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH, content: Buffer.from(buildImageGenSkill()) },
    { path: OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH, content: Buffer.from(buildImageGenScript()) },
    { path: OPENCLAW_WEB_SEARCH_SKILL_PATH, content: Buffer.from(buildWebSearchSkill()) },
    { path: OPENCLAW_WEB_SEARCH_SCRIPT_PATH, content: Buffer.from(buildWebSearchScript()) },
    { path: OPENCLAW_VISION_SKILL_PATH, content: Buffer.from(buildVisionSkill()) },
    { path: OPENCLAW_VISION_SCRIPT_PATH, content: Buffer.from(buildVisionScript()) },
    { path: OPENCLAW_TTS_SKILL_PATH, content: Buffer.from(buildTtsSkill()) },
    { path: OPENCLAW_TTS_SCRIPT_PATH, content: Buffer.from(buildTtsScript()) },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
      content: Buffer.from(buildStructuredExtractSkill()),
    },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
      content: Buffer.from(buildStructuredExtractScript()),
    },
    { path: OPENCLAW_EMBEDDINGS_SKILL_PATH, content: Buffer.from(buildEmbeddingsSkill()) },
    { path: OPENCLAW_EMBEDDINGS_SCRIPT_PATH, content: Buffer.from(buildEmbeddingsScript()) },
    {
      path: OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH,
      content: Buffer.from(buildSemanticSearchSkill()),
    },
    {
      path: OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH,
      content: Buffer.from(buildSemanticSearchScript()),
    },
    { path: OPENCLAW_TRANSCRIPTION_SKILL_PATH, content: Buffer.from(buildTranscriptionSkill()) },
    {
      path: OPENCLAW_TRANSCRIPTION_SCRIPT_PATH,
      content: Buffer.from(buildTranscriptionScript()),
    },
    { path: OPENCLAW_REASONING_SKILL_PATH, content: Buffer.from(buildReasoningSkill()) },
    { path: OPENCLAW_REASONING_SCRIPT_PATH, content: Buffer.from(buildReasoningScript()) },
    { path: OPENCLAW_COMPARE_SKILL_PATH, content: Buffer.from(buildCompareSkill()) },
    { path: OPENCLAW_COMPARE_SCRIPT_PATH, content: Buffer.from(buildCompareScript()) },
    ...buildWorkerSandboxRestoreFiles(),
  ];
}

export function buildDynamicRestoreFiles(options: {
  proxyOrigin: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackCredentials?: { botToken: string; signingSecret: string };
  whatsappConfig?: WhatsAppGatewayConfig;
  codexCredentials?: CodexCredentials | null;
}): { path: string; content: Buffer }[] {
  // TODO(codex): when Unit 3 lands, pass `codexProfile: options.codexCredentials != null`
  // to buildGatewayConfig so openclaw.json declares the openai-codex provider.
  const files: { path: string; content: Buffer }[] = [
    {
      path: OPENCLAW_CONFIG_PATH,
      content: Buffer.from(
        buildGatewayConfig(
          undefined, // apiKey — injected via network policy transform
          options.proxyOrigin,
          options.telegramBotToken,
          options.slackCredentials,
          options.telegramWebhookSecret,
          options.whatsappConfig,
        ),
      ),
    },
  ];

  if (options.telegramBotToken) {
    files.push({
      path: OPENCLAW_TELEGRAM_BOT_TOKEN_PATH,
      content: Buffer.from(options.telegramBotToken),
    });
  }

  if (options.codexCredentials) {
    files.push({
      path: OPENCLAW_CODEX_AUTH_PROFILES_PATH,
      content: Buffer.from(buildAuthProfilesJson(options.codexCredentials)),
    });
  }

  return files;
}

export type RestoreRuntimeEnvOptions = {
  gatewayToken: string;
  apiKey?: string;
};

export function buildRestoreRuntimeEnv(
  options: RestoreRuntimeEnvOptions,
): Record<string, string> {
  // Config JSON is NOT passed via env — the Sandbox API enforces a 4096 byte
  // env payload limit and the base64-encoded config exceeds it.  The config
  // is delivered via writeFiles() (buildDynamicRestoreFiles) when the hash
  // changes, or already baked into the snapshot when it matches.
  //
  // The real AI Gateway credential is injected via network policy header
  // transform at the firewall layer — it never enters the sandbox VM.
  // OpenClaw needs a non-empty AI_GATEWAY_API_KEY to bootstrap its
  // auth-profiles provider, so we pass a placeholder.
  return {
    OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
    OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    AI_GATEWAY_API_KEY: "sk-placeholder-injected-via-network-policy",
    OPENAI_API_KEY: "sk-placeholder-injected-via-network-policy",
  };
}

export function buildRestoreAssetManifest(): RestoreAssetManifest {
  const staticFiles = buildStaticRestoreFiles();
  const hash = createHash("sha256");

  for (const file of staticFiles) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }

  return {
    version: 1,
    sha256: hash.digest("hex"),
    staticPaths: staticFiles.map((file) => file.path),
  };
}

export type BootstrapFilesOptions = {
  gatewayToken: string;
  apiKey?: string;
  proxyOrigin: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackCredentials?: { botToken: string; signingSecret: string };
  whatsappConfig?: WhatsAppGatewayConfig;
  codexCredentials?: CodexCredentials | null;
};

/**
 * Build the complete list of files written during bootstrap.
 *
 * This is the single source of truth for both initial bootstrap and
 * restore-skip hash comparison.  Bootstrap calls this instead of
 * maintaining its own hand-written file list.
 *
 * The AI Gateway API key is written to disk AND injected via network
 * policy header transform.  The disk file is needed because OpenClaw's
 * agent subprocesses read it for auth-profiles resolution.  The transform
 * provides defense-in-depth at the firewall layer.
 */
export function buildBootstrapFiles(
  options: BootstrapFilesOptions,
): { path: string; content: Buffer }[] {
  const manifest = buildRestoreAssetManifest();
  return [
    ...buildDynamicRestoreFiles({
      proxyOrigin: options.proxyOrigin,
      telegramBotToken: options.telegramBotToken,
      telegramWebhookSecret: options.telegramWebhookSecret,
      slackCredentials: options.slackCredentials,
      whatsappConfig: options.whatsappConfig,
      codexCredentials: options.codexCredentials,
    }),
    {
      path: OPENCLAW_GATEWAY_TOKEN_PATH,
      content: Buffer.from(options.gatewayToken),
    },
    {
      path: OPENCLAW_AI_GATEWAY_API_KEY_PATH,
      content: Buffer.from("sk-placeholder-injected-via-network-policy"),
    },
    ...buildStaticRestoreFiles(),
    {
      path: OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
      content: Buffer.from(JSON.stringify(manifest) + "\n"),
    },
  ];
}
