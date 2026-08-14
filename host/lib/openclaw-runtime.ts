import { createHash } from 'node:crypto';
import {
  PLACEHOLDER_MODEL_KEY,
  modelConfigEntries,
  resolveModel,
} from './model-credentials';

const RUNTIME_CONFIG_VERSION = 6;

export type RuntimeEnvironment = Record<string, string | undefined>;

export interface ConfigOperation {
  path: string;
  value: unknown;
}

export interface OpenClawRuntime {
  gatewayEnv: Record<string, string>;
  configOperations: ConfigOperation[];
  fingerprint: string;
}

/**
 * Builds the credential-brokered OpenClaw runtime persisted in the sandbox.
 *
 * The previous direct-Slack deployment left Slack and Vercel provider plugins
 * enabled on the persistent disk. This desired state explicitly disables both
 * adapters before configuring the built-in OpenAI provider for AI Gateway.
 * Only the gateway token and a recognizable non-secret placeholder enter the
 * VM; the real model credential is injected by the sandbox firewall.
 */
export function buildOpenClawRuntime(
  env: RuntimeEnvironment,
  gatewayToken: string,
): OpenClawRuntime {
  const model = resolveModel(env);
  const configOperations: ConfigOperation[] = [
    { path: 'plugins.entries.slack.enabled', value: false },
    { path: 'plugins.entries.vercel-ai-gateway.enabled', value: false },
    ...modelConfigEntries(model).map(([path, value]) => ({ path, value })),
  ];
  const gatewayEnv = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENAI_API_KEY: PLACEHOLDER_MODEL_KEY,
  };

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: RUNTIME_CONFIG_VERSION,
        gatewayToken,
        configOperations,
      }),
    )
    .digest('hex');

  return { gatewayEnv, configOperations, fingerprint };
}
