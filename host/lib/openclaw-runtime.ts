import { createHash } from 'node:crypto';

export const VERCEL_AI_GATEWAY_PLUGIN =
  '@openclaw/vercel-ai-gateway-provider@2026.7.2-beta.7';
export const OPENCLAW_SLACK_PLUGIN = '@openclaw/slack@2026.7.2-beta.7';
export const DEFAULT_AGENT_MODEL = 'vercel-ai-gateway/openai/gpt-5.4';

const RUNTIME_CONFIG_VERSION = 5;

export type RuntimeEnvironment = Record<string, string | undefined>;

export interface ConfigOperation {
  path: string;
  value: unknown;
}

export interface OpenClawRuntime {
  gatewayEnv: Record<string, string>;
  configOperations: ConfigOperation[];
  fingerprint: string;
  needsAiGatewayPlugin: boolean;
  needsSlackPlugin: boolean;
}

const envSecret = (id: string) => ({
  source: 'env',
  provider: 'default',
  id,
});

/**
 * Builds the environment and persistent OpenClaw config needed by a gateway
 * process. Config files contain env references only; credentials remain in
 * the sandbox process environment.
 */
export function buildOpenClawRuntime(
  env: RuntimeEnvironment,
  gatewayToken: string,
  overrides: { aiGatewayCredential?: string } = {},
): OpenClawRuntime {
  const botToken = env.SLACK_BOT_TOKEN;
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (Boolean(botToken) !== Boolean(signingSecret)) {
    throw new Error(
      'SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be set together',
    );
  }

  const explicitAiGatewayKey = env.AI_GATEWAY_API_KEY;
  const aiGatewayCredential =
    explicitAiGatewayKey ??
    overrides.aiGatewayCredential ??
    env.VERCEL_OIDC_TOKEN;
  const gatewayEnv: Record<string, string> = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };
  const configOperations: ConfigOperation[] = [];

  if (botToken && signingSecret) {
    gatewayEnv.SLACK_BOT_TOKEN = botToken;
    gatewayEnv.SLACK_SIGNING_SECRET = signingSecret;
    configOperations.push(
      { path: 'plugins.entries.slack.enabled', value: true },
      { path: 'channels.slack.enabled', value: true },
      { path: 'channels.slack.mode', value: 'http' },
      { path: 'channels.slack.botToken', value: envSecret('SLACK_BOT_TOKEN') },
      {
        path: 'channels.slack.signingSecret',
        value: envSecret('SLACK_SIGNING_SECRET'),
      },
      { path: 'channels.slack.dmPolicy', value: 'open' },
      { path: 'channels.slack.groupPolicy', value: 'open' },
      { path: 'channels.slack.allowFrom', value: ['*'] },
      { path: 'channels.slack.webhookPath', value: '/slack/events' },
      {
        path: 'channels.slack.replyToModeByChatType.channel',
        value: 'all',
      },
      { path: 'channels.slack.slashCommand.enabled', value: true },
      { path: 'channels.slack.slashCommand.name', value: 'openclaw' },
    );
  }

  if (aiGatewayCredential) {
    gatewayEnv.AI_GATEWAY_API_KEY = aiGatewayCredential;
    configOperations.push(
      { path: 'plugins.entries.vercel-ai-gateway.enabled', value: true },
      {
        path: 'agents.defaults.model.primary',
        value: DEFAULT_AGENT_MODEL,
      },
    );
  }

  // Vercel caches a request-scoped OIDC token for up to 45 minutes. Include
  // the active credential in the digest so the sandbox gateway restarts with
  // the replacement before an old token expires; only the digest is persisted.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: RUNTIME_CONFIG_VERSION,
        gatewayToken,
        botToken: botToken ?? null,
        signingSecret: signingSecret ?? null,
        aiGatewayCredential: aiGatewayCredential ?? null,
        model: aiGatewayCredential ? DEFAULT_AGENT_MODEL : null,
      }),
    )
    .digest('hex');

  return {
    gatewayEnv,
    configOperations,
    fingerprint,
    needsAiGatewayPlugin: Boolean(aiGatewayCredential),
    needsSlackPlugin: Boolean(botToken && signingSecret),
  };
}
