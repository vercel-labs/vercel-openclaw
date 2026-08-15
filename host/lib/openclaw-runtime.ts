import { createHash } from 'node:crypto';
import {
  PLACEHOLDER_MODEL_KEY,
  modelConfigEntries,
  resolveModel,
} from './model-credentials';

const RUNTIME_CONFIG_VERSION = 7;

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
    // Both plugins are installed at create (see PLUGIN_SPECS) because the
    // official image ships neither. Enabling them is what makes OpenClaw own
    // the Slack channel and reach the model through the sanctioned provider
    // rather than a repointed `openai` baseUrl.
    { path: 'plugins.entries.slack.enabled', value: true },
    { path: 'plugins.entries.vercel-ai-gateway.enabled', value: true },
    // Explicitly trust exactly these two. Without it the gateway warns that
    // "plugins.allow is empty; discovered non-bundled plugins may auto-load"
    // (observed 2026-08-14), which means anything that lands under the plugin
    // directory would load unreviewed.
    { path: 'plugins.allow', value: ['vercel-ai-gateway', 'slack'] },
    ...modelConfigEntries(model).map(([path, value]) => ({ path, value })),
  ];
  const gatewayEnv = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    // The provider plugin reads AI_GATEWAY_API_KEY and sends it as a Bearer to
    // ai-gateway.vercel.sh. This value is a placeholder: the sandbox firewall
    // replaces that header on egress with the app's real OIDC token, so the
    // credential never enters the VM. See lib/model-credentials.ts.
    AI_GATEWAY_API_KEY: PLACEHOLDER_MODEL_KEY,
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
