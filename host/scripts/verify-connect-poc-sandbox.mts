import { Sandbox } from '@vercel/sandbox';

const sandboxName = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw-connect-poc-main';
const image = process.env.OPENCLAW_IMAGE;
if (!image) throw new Error('OPENCLAW_IMAGE required');

const sandbox = await Sandbox.getOrCreate({
  name: sandboxName,
  image,
  persistent: true,
  timeout: 45 * 60 * 1000,
  ports: [3000],
});

const credentialScan = await sandbox.runCommand({
  cmd: 'bash',
  args: [
    '-c',
    String.raw`
set -u
bad=0
if env | grep -qE '^(SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|SLACK_APP_TOKEN|SLACK_USER_TOKEN)=|=xox[a-z]-[[:alnum:]-]{20,}'; then
  echo 'FAIL command environment'
  bad=1
fi
for d in /proc/[0-9]*; do
  [ -r "$d/environ" ] || continue
  comm=$(cat "$d/comm" 2>/dev/null || true)
  case "$comm" in
    node|openclaw|sh)
      if tr '\0' '\n' < "$d/environ" | grep -qE '^(SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|SLACK_APP_TOKEN|SLACK_USER_TOKEN)=|=xox[a-z]-[[:alnum:]-]{20,}'; then
        echo "FAIL process-env pid=\${d##*/}"
        bad=1
      fi
      if tr '\0' '\n' < "$d/cmdline" | grep -qE 'xox[a-z]-[[:alnum:]-]{20,}|SLACK_(BOT_TOKEN|SIGNING_SECRET|APP_TOKEN|USER_TOKEN)='; then
        echo "FAIL process-argv pid=\${d##*/}"
        bad=1
      fi
    ;;
  esac
done
while IFS= read -r -d '' f; do
  if grep -aqE 'xox[a-z]-[[:alnum:]-]{20,}' "$f"; then
    echo "FAIL token-shaped file: $f"
    bad=1
  fi
done < <(find /home/node/.openclaw /tmp -xdev -type f -size -20M -print0 2>/dev/null)
node <<'NODE' || bad=1
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const hits = [];
const token = /xox[a-z]-[A-Za-z0-9-]{20,}/;
function walk(value, path = []) {
  if (typeof value === 'string') {
    if (token.test(value)) hits.push(path.join('.'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    if (['botToken', 'appToken', 'signingSecret', 'userToken'].includes(key) && child != null && child !== '') {
      hits.push(next.join('.'));
    }
    walk(child, next);
  }
}
walk(cfg.channels?.slack, ['channels', 'slack']);
if (hits.length) {
  for (const hit of hits) console.log('FAIL config path: ' + hit);
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
  throw new Error(`Slack credential scan failed${scanOutput ? `:\n${scanOutput}` : ''}`);
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
  groupPolicy: slack.groupPolicy ?? null,
  requireMention: slack.requireMention ?? null,
  replyToMode: slack.replyToMode ?? null,
  streamingMode: slack.streaming?.mode ?? null,
  hostBridgeApiUrl: slack.hostBridge?.apiUrl ?? null,
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

console.log(
  JSON.stringify(
    {
      sandboxName,
      slackCredentialsAbsent: true,
      config: JSON.parse((await configProbe.stdout()).trim()),
      slackPlugin: slackBlock?.trim().split('\n') ?? [],
    },
    null,
    2,
  ),
);
