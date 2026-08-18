import { Sandbox } from '@vercel/sandbox';

const sandboxName = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-connect-poc-main';
const image = process.env.OPENCLAW_IMAGE;
if (!image) throw new Error('OPENCLAW_IMAGE required');

const sandbox = await Sandbox.getOrCreate({
  name: sandboxName,
  image,
  persistent: true,
  timeout: 45 * 60 * 1000,
  ports: [18789],
});

const credentialScan = await sandbox.runCommand({
  cmd: 'bash',
  args: [
    '-c',
    String.raw`
set -u
bad=0
secret_names='SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|SLACK_APP_TOKEN|SLACK_USER_TOKEN|OPENAI_API_KEY|AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN'
secret_shapes='xox[A-Za-z]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,}'
if env | grep -qE "^($secret_names)=|=($secret_shapes)"; then
  echo 'FAIL command environment'
  bad=1
fi
for d in /proc/[0-9]*; do
  [ -r "$d/environ" ] || continue
  if tr '\0' '\n' < "$d/environ" | grep -qE "^($secret_names)=|=($secret_shapes)"; then
    echo "FAIL process-env pid=\${d##*/}"
    bad=1
  fi
  comm=$(cat "$d/comm" 2>/dev/null || true)
  case "$comm" in
    bash) ;;
    *)
      if tr '\0' '\n' < "$d/cmdline" | grep -qE "($secret_shapes)|($secret_names)="; then
        echo "FAIL process-argv pid=\${d##*/}"
        bad=1
      fi
      argv=$(tr '\0' ' ' < "$d/cmdline")
      if printf '%s' "$argv" | grep -qE '(^|[ /])openclaw(\.mjs)?([[:space:]]+|$).*([[:space:]]+)agent([[:space:]]+|$)'; then
        echo "FAIL generic-agent-process pid=\${d##*/}"
        bad=1
      fi
    ;;
  esac
done
while IFS= read -r -d '' f; do
  if grep -aqE "($secret_shapes)|(^|[^A-Za-z0-9_])($secret_names)=" "$f"; then
    echo "FAIL credential-shaped file: $f"
    bad=1
  fi
done < <(find /home/node/.openclaw /tmp -xdev -type f -size -100M -print0 2>/dev/null)
node <<'NODE' || bad=1
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const hits = [];
const placeholder = 'brokered-by-vercel-sandbox-firewall';
const token = /(?:xox[A-Za-z]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,})/;
const forbiddenKeys = new Set([
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_USER_TOKEN',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'botToken',
  'appToken',
  'signingSecret',
  'userToken',
]);
function walk(value, path = []) {
  if (typeof value === 'string') {
    if (token.test(value)) hits.push(path.join('.'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    if (forbiddenKeys.has(key) && child != null && child !== '') {
      hits.push(next.join('.'));
    }
    if (key === 'apiKey' && child != null && child !== '' && child !== placeholder) {
      hits.push(next.join('.'));
    }
    walk(child, next);
  }
}
walk(cfg);
if (hits.length) {
  for (const hit of new Set(hits)) console.log('FAIL config path: ' + hit);
  process.exit(1);
}
NODE
exit "$bad"
`,
  ],
});

const scanOutput = [await credentialScan.stdout(), await credentialScan.stderr()]
  .join('\n')
  .trim();
if (credentialScan.exitCode !== 0) {
  throw new Error(`Credential boundary scan failed${scanOutput ? `:\n${scanOutput}` : ''}`);
}

const configProbe = await sandbox.runCommand({
  cmd: 'node',
  args: [
    '-e',
    String.raw`
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const slack = cfg.channels?.slack ?? {};
const ref = slack.hostBridge?.authToken;
console.log(JSON.stringify({
  configuredPolicyFieldCount: ['groupPolicy', 'requireMention', 'replyToMode']
    .filter((key) => slack[key] !== undefined).length,
  streamingDisabled: slack.streaming?.mode === 'off',
  hostBridgeApiUrlConfigured:
    typeof slack.hostBridge?.apiUrl === 'string' && slack.hostBridge.apiUrl.length > 0,
  hostBridgeAuthIsEnvSecretRef:
    ref?.source === 'env' &&
    ref?.provider === 'default' &&
    ref?.id === 'OPENCLAW_SLACK_HOST_BRIDGE_TOKEN',
}));
`,
  ],
});
if (configProbe.exitCode !== 0) {
  throw new Error(`Safe config probe failed (${configProbe.exitCode})`);
}

const pluginProbe = await sandbox.runCommand({
  cmd: 'openclaw',
  args: ['plugins', 'list', '--enabled', '--verbose'],
});
if (pluginProbe.exitCode !== 0) {
  throw new Error(`Plugin provenance probe failed (${pluginProbe.exitCode})`);
}
const slackBlock = (await pluginProbe.stdout()).match(
  /Slack \(slack\) enabled\n(?: {2}.*\n)+/,
)?.[0];
const pluginPaths = slackBlock
  ?.split('\n')
  .map((line) => line.match(/\/(?:home|app)\/[^\s]+/)?.[0])
  .filter((value): value is string => Boolean(value)) ?? [];

console.log(
  JSON.stringify(
    {
      slackCredentialsAbsent: true,
      modelCredentialsAbsent: true,
      genericAgentProcessCount: 0,
      config: JSON.parse((await configProbe.stdout()).trim()),
      slackPluginEnabled: Boolean(slackBlock),
      slackPluginPathCount: pluginPaths.length,
      slackPluginPaths: pluginPaths,
    },
    null,
    2,
  ),
);
