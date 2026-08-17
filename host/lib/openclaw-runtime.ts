import { createHash } from 'node:crypto';
import { modelConfigEntries, resolveModel } from './model-credentials';

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
  // Deliberately only the gateway token. `AI_GATEWAY_API_KEY` is NOT set here.
  //
  // Removal is safe structurally, not because of any upstream behaviour claim.
  // `seedProviderPlaceholder` writes the provider's SQLite profile, and it runs
  // on exactly the same condition as the config write, so any sandbox whose
  // fingerprint does not match this runtime re-seeds on its next wake. Sandboxes
  // provisioned by the previous runtime version cannot match (the fingerprint
  // hashes RUNTIME_CONFIG_VERSION and the config shape), and ones provisioned by
  // this version already have the profile on their snapshotted disk. Either way
  // the value was a recognizable placeholder with no power, so nothing that could
  // read it lost anything.
  //
  // Setting it also actively hurt: it makes OpenClaw treat `vercel-ai-gateway` as
  // a *configured* plugin, so if the plugin is ever missing the startup doctor
  // tries to resolve it from npm. Under the steady-state egress policy npm is
  // unreachable, and that resolution runs before the logger initializes, so the
  // gateway hangs with an empty log.
  //
  // Measured 2026-08-17: env set + plugin missing + npm blocked never bound
  // (40.8s on 2026.7.1, 54.6s on beta.7, alive on `npm view`); env unset in the
  // same conditions bound in 7.42s. Removal verified over 3 production-config
  // runs: port bound, health ok, agent turn returned through vercel-ai-gateway.
  //
  // Caution for anyone editing this object: `gatewayEnv` is NOT an input to the
  // fingerprint below, so a change here does not by itself trigger re-seeding or
  // re-provisioning. The re-seed argument above only holds because this change
  // shipped alongside a RUNTIME_CONFIG_VERSION bump. An env-only change with no
  // version bump is safe only where the profile already exists on disk; if a
  // future value needs the sandbox reconfigured, bump the version too.
  const gatewayEnv = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
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
