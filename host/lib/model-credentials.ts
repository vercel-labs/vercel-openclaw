import type { NetworkPolicy } from '@vercel/sandbox';

/**
 * The agent needs model access; the sandbox must never hold the credential.
 *
 * OpenClaw resolves provider keys inside its own process, so any key we hand
 * it lives in the VM's memory and config for the life of the session. Instead
 * we give OpenClaw a placeholder and let the sandbox firewall replace the
 * Authorization header on the way out: "Credentials brokering allows the
 * injection of credentials on egressing traffic, while ensuring those secrets
 * never enter the sandbox scope" (vercel.com/docs/sandbox/concepts/firewall,
 * retrieved 2026-08-14).
 *
 * AI Gateway accepts the app's own Vercel OIDC token in place of an API key
 * (vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions, retrieved
 * 2026-08-14). A deployment that cannot use AI Gateway may instead keep an
 * OpenAI key in the Vercel host and broker it only for api.openai.com. In both
 * cases the real credential remains outside the sandbox.
 *
 * Function OIDC tokens are request-scoped and short-lived, so the host refreshes
 * the firewall policy before each turn instead of persisting the token anywhere
 * in the VM.
 */

export const AI_GATEWAY_DOMAIN = 'ai-gateway.vercel.sh';
export const AI_GATEWAY_BASE_URL = `https://${AI_GATEWAY_DOMAIN}/v1`;
export const OPENAI_API_DOMAIN = 'api.openai.com';
export const OPENAI_API_BASE_URL = `https://${OPENAI_API_DOMAIN}/v1`;

/**
 * Value handed to OpenClaw as its provider "API key". It is never a valid
 * credential: the firewall overwrites the header it ends up in. It exists only
 * because OpenClaw expects a key to be configured before it will call a
 * provider at all.
 *
 * Deliberately recognizable so it is obvious in a log or a config dump that
 * nothing secret was leaked.
 */
export const PLACEHOLDER_MODEL_KEY = 'brokered-by-vercel-sandbox-firewall';

/**
 * Reads a request-scoped OIDC token already authenticated by the caller. The
 * environment variable is only a local/build fallback populated by
 * `vercel env pull`.
 */
export function readOidcToken(requestToken?: string): string {
  const token = requestToken?.trim() || process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      'No verified Vercel OIDC token was provided; locally run `vercel env pull`.',
    );
  }
  return token;
}

/**
 * Strict egress policy with the model credential brokered at the firewall.
 *
 * Three things are deliberate, and each one is load-bearing:
 *
 * 1. No `"*"` catch-all. Under a catch-all, traffic without a detectable
 *    domain (no SNI, non-TLS, SSH) passes through unmodified, so the agent
 *    could reach anything.
 * 2. No `subnets.allow`. Allowed ranges bypass domain rules entirely: the docs
 *    are explicit that code can reach any IP in an allowed range by literal
 *    address or a custom resolver, and that such traffic "bypasses SNI
 *    filtering, credentials brokering, and requests proxying".
 * 3. An `allow` domain list is present, which is also what constrains DNS. A
 *    policy with ranges but no domains leaves the resolver open, and data can
 *    leave over DNS lookups alone.
 *
 * The injection rules carry no `match`, so every request to either model host
 * gets its host-owned credential. That is intentional rather than lax: neither
 * model host has a valid unauthenticated request path for the agent.
 */
export function buildNetworkPolicy(
  oidcToken: string,
  hostBridgeApiUrl?: string,
  openAiApiKey?: string,
): NetworkPolicy {
  const allow: Record<string, unknown[]> = {
    [AI_GATEWAY_DOMAIN]: [
      {
        transform: [{ headers: { authorization: `Bearer ${oidcToken}` } }],
      },
    ],
  };
  if (openAiApiKey) {
    allow[OPENAI_API_DOMAIN] = [
      {
        transform: [{ headers: { authorization: `Bearer ${openAiApiKey}` } }],
      },
    ];
  }
  if (hostBridgeApiUrl) {
    const hostBridgeUrl = new URL(hostBridgeApiUrl);
    if (
      hostBridgeUrl.protocol !== 'https:' ||
      hostBridgeUrl.username ||
      hostBridgeUrl.password
    ) {
      throw new Error(
        'OPENCLAW_SLACK_HOST_BRIDGE_API_URL must be an HTTPS URL without userinfo',
      );
    }
    if (
      hostBridgeUrl.hostname === AI_GATEWAY_DOMAIN ||
      hostBridgeUrl.hostname === OPENAI_API_DOMAIN
    ) {
      throw new Error(
        'OPENCLAW_SLACK_HOST_BRIDGE_API_URL must not use a model API hostname',
      );
    }
    // The Slack bridge receives the sandbox's narrow assertion unchanged.
    // Model credential injection remains scoped exclusively to model hosts.
    allow[hostBridgeUrl.hostname] = [];
  }
  return { allow } as NetworkPolicy;
}

/**
 * Model ref for the official AI Gateway provider plugin. Refs take the form
 * `vercel-ai-gateway/<upstream-provider>/<model>` and the gateway routes on that
 * prefix (docs.openclaw.ai/providers/vercel-ai-gateway, retrieved 2026-08-14).
 * The upstream model here is the one already proven to resolve end to end.
 */
export const DEFAULT_MODEL_ID = 'vercel-ai-gateway/openai/gpt-5.6-sol';

export function resolveModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.OPENCLAW_MODEL?.trim() || DEFAULT_MODEL_ID;
}

/**
 * The single config key needed to route agent turns through AI Gateway.
 *
 * Only the model ref. Nothing sets an endpoint or an auth header, because the
 * `@openclaw/vercel-ai-gateway-provider` plugin owns both. An earlier version of
 * this repointed `models.providers.openai.baseUrl` by hand; installing the
 * official provider plugin replaced that, so any endpoint configuration here
 * would be redundant at best and conflicting at worst.
 *
 * Applied through `openclaw config set` rather than by writing openclaw.json
 * directly, deliberately. The image ships its own config, and a whole-file
 * write is what produces the bootstrap failure recorded as question 4 in
 * docs/suspension-spec.md ("Config write would drop agent roster entries
 * without an explicit deletion: main"). Letting OpenClaw merge its own config
 * avoids owning that problem.
 *
 * Model addressing: refs take the form `vercel-ai-gateway/<upstream>/<model>`
 * and the gateway routes on that prefix. Confirmed live 2026-08-17 under the
 * steady-state egress policy: a turn returned `"provider": "vercel-ai-gateway"`,
 * `"model": "openai/gpt-5.6-sol"`, `"status": "ok"`.
 */
export function modelConfigEntries(model = resolveModel()): Array<[string, string]> {
  return [['agents.defaults.model.primary', model]];
}

/**
 * Plugins the image does not ship, installed once at create.
 *
 * Verified against `openclaw-foundation/openclaw/openclaw:latest` on
 * 2026-08-14: a fresh sandbox has 69 stock plugins under /app/dist/extensions
 * and neither of these is among them. `openclaw plugins install` fetches each
 * from npm and links its peer dependency back to the image's own install.
 *
 * They land under `/home/node/.openclaw/npm/...`, which is on the snapshotted
 * disk, so this is a one-time cost at create rather than a per-wake one.
 *
 * `@openclaw/slack` is what lets OpenClaw own the Slack channel outright, so
 * the user's own allow/deny lists, approvals and mention policies apply
 * (Patrick Erichsen, 2026-08-14: without it "users can't configure things like
 * allow/deny lists, approvals, etc - would be pretty bricked").
 */
export const PLUGIN_SPECS = [
  '@openclaw/vercel-ai-gateway-provider',
  '@openclaw/slack',
] as const;

/** Registry hosts npm needs while installing the plugins above. */
const NPM_DOMAINS = ['registry.npmjs.org', '*.npmjs.org'];

/**
 * Egress policy for the install step only.
 *
 * Deliberately separate from the steady-state policy: npm is reachable while
 * plugins are being fetched at create, and then `buildNetworkPolicy` replaces
 * it before the gateway starts, so no agent code ever runs with the registry
 * reachable. Policies can be swapped on a running sandbox, which is what makes
 * this two-phase approach possible.
 */
export function buildInstallNetworkPolicy(
  oidcToken: string,
  hostBridgeApiUrl?: string,
  openAiApiKey?: string,
): NetworkPolicy {
  const base = buildNetworkPolicy(oidcToken, hostBridgeApiUrl, openAiApiKey) as {
    allow: Record<string, unknown[]>;
  };
  const allow = { ...base.allow };
  for (const domain of NPM_DOMAINS) allow[domain] = [];
  return { allow } as NetworkPolicy;
}
