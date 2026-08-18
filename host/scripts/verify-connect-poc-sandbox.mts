import { Sandbox } from '@vercel/sandbox';
import { PLACEHOLDER_MODEL_KEY } from '../lib/model-credentials';

const hostOpenAiApiKey = process.env.OPENAI_API_KEY?.trim();
if (!hostOpenAiApiKey) throw new Error('OPENAI_API_KEY required on the host');
if (hostOpenAiApiKey === PLACEHOLDER_MODEL_KEY) {
  throw new Error('The host OpenAI key must differ from the sandbox placeholder');
}

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

const credentialScanScript = String.raw`
set -u
node <<'NODE'
const fs = require('fs');
const path = require('path');

const EXACT_SENTINEL = __EXACT_SENTINEL__;
const credentialShape = /(?:xox[A-Za-z]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,})/;
const forbiddenNameAssignment = /(?:^|[^A-Za-z0-9_])(?:SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|SLACK_APP_TOKEN|SLACK_USER_TOKEN|OPENAI_API_KEY|AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN)=/;
const genericAgent = /(?:^|[ /])openclaw(?:\.mjs)?(?:\s+|$).*?(?:\s+)agent(?:\s+|$)/;
const forbiddenConfigKeys = new Set([
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

let bad = false;
let placeholderExactMatchCount = 0;
let genericAgentProcessCount = 0;

function fail(kind, location) {
  console.log('FAIL ' + kind + ': ' + location);
  bad = true;
}

function containsForbiddenCredential(text) {
  return credentialShape.test(text.split(EXACT_SENTINEL).join(''));
}

function inspectText(text, kind, location, options = {}) {
  placeholderExactMatchCount += text.split(EXACT_SENTINEL).length - 1;
  if (containsForbiddenCredential(text)) fail('credential-shaped ' + kind, location);
  if (forbiddenNameAssignment.test(text)) fail('credential-name ' + kind, location);
  if (options.checkGenericAgent && genericAgent.test(text.replaceAll('\0', ' '))) {
    genericAgentProcessCount += 1;
    fail('generic-agent-process', location);
  }
}

if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(EXACT_SENTINEL)) {
  fail('sentinel-contract', 'approved sentinel does not satisfy OpenAI key validation');
}
if (containsForbiddenCredential(EXACT_SENTINEL)) {
  fail('scanner-self-test', 'exact sentinel was not excluded');
}
if (!credentialShape.test('sk-this-is-not-the-approved-sentinel-123456789')) {
  fail('scanner-self-test', 'unapproved sk value was not rejected');
}

inspectText(
  Object.entries(process.env).map(([key, value]) => key + '=' + (value ?? '')).join('\n'),
  'command-environment',
  'verifier',
);

for (const pid of fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
  const processDir = '/proc/' + pid;
  try {
    inspectText(fs.readFileSync(processDir + '/environ', 'utf8'), 'process-env', 'pid=' + pid);
  } catch {}
  try {
    const comm = fs.readFileSync(processDir + '/comm', 'utf8').trim();
    if (comm !== 'bash') {
      inspectText(fs.readFileSync(processDir + '/cmdline', 'utf8'), 'process-argv', 'pid=' + pid, {
        checkGenericAgent: true,
      });
    }
  } catch {}
}

function walkFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 100 * 1024 * 1024) continue;
      inspectText(fs.readFileSync(fullPath).toString('latin1'), 'file', fullPath);
    } catch {}
  }
}
walkFiles('/home/node/.openclaw');
walkFiles('/tmp');

const configPath = '/home/node/.openclaw/openclaw.json';
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const configHits = [];
function walkConfig(value, segments = []) {
  if (typeof value === 'string') {
    const withoutSentinel = value.split(EXACT_SENTINEL).join('');
    if (credentialShape.test(withoutSentinel)) configHits.push(segments.join('.'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key];
    if (forbiddenConfigKeys.has(key) && child != null && child !== '') {
      configHits.push(next.join('.'));
    }
    if (key === 'apiKey' && child != null && child !== '' && child !== EXACT_SENTINEL) {
      configHits.push(next.join('.'));
    }
    walkConfig(child, next);
  }
}
walkConfig(cfg);
for (const hit of new Set(configHits)) fail('config-path', hit);

if (placeholderExactMatchCount === 0) {
  fail('sentinel-presence', 'state did not contain the exact approved sentinel');
}

if (bad) process.exit(1);
const slack = cfg.channels?.slack ?? {};
const ref = slack.hostBridge?.authToken;
console.log(JSON.stringify({
  placeholderExactMatchCount,
  genericAgentProcessCount,
  config: {
    configuredPolicyFieldCount: ['groupPolicy', 'requireMention', 'replyToMode']
      .filter((key) => slack[key] !== undefined).length,
    streamingDisabled: slack.streaming?.mode === 'off',
    hostBridgeApiUrlConfigured:
      typeof slack.hostBridge?.apiUrl === 'string' && slack.hostBridge.apiUrl.length > 0,
    hostBridgeAuthIsEnvSecretRef:
      ref?.source === 'env' &&
      ref?.provider === 'default' &&
      ref?.id === 'OPENCLAW_SLACK_HOST_BRIDGE_TOKEN',
  },
}));
NODE
`.replace('__EXACT_SENTINEL__', JSON.stringify(PLACEHOLDER_MODEL_KEY));

const credentialScan = await sandbox.runCommand({
  cmd: 'bash',
  args: ['-c', credentialScanScript],
});

const scanOutput = [await credentialScan.stdout(), await credentialScan.stderr()]
  .join('\n')
  .trim();
if (credentialScan.exitCode !== 0) {
  throw new Error(`Credential boundary scan failed${scanOutput ? `:\n${scanOutput}` : ''}`);
}
const boundary = JSON.parse(scanOutput) as {
  placeholderExactMatchCount: number;
  genericAgentProcessCount: number;
  config: Record<string, boolean | number>;
};

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
      modelPlaceholderIsExactSentinel: true,
      modelPlaceholderDiffersFromHostKey: true,
      modelPlaceholderExactMatchCount: boundary.placeholderExactMatchCount,
      genericAgentProcessCount: boundary.genericAgentProcessCount,
      config: boundary.config,
      slackPluginEnabled: Boolean(slackBlock),
      slackPluginPathCount: pluginPaths.length,
      slackPluginPaths: pluginPaths,
    },
    null,
    2,
  ),
);
