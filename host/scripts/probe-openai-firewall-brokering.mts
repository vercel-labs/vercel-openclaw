import { Sandbox } from '@vercel/sandbox';
import {
  OPENAI_API_BASE_URL,
  PLACEHOLDER_MODEL_KEY,
  buildNetworkPolicy,
  readOidcToken,
} from '../lib/model-credentials.ts';

const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
if (!openAiApiKey) throw new Error('OPENAI_API_KEY required on the host');
if (openAiApiKey === PLACEHOLDER_MODEL_KEY) {
  throw new Error('The host OpenAI key must differ from the sandbox placeholder');
}

const sandbox = await Sandbox.create({
  image: process.env.OPENCLAW_IMAGE,
  timeout: 5 * 60 * 1000,
  networkPolicy: buildNetworkPolicy(readOidcToken(), undefined, openAiApiKey),
});

try {
  const request = await sandbox.runCommand({
    cmd: 'node',
    args: [
      '-e',
      `fetch(${JSON.stringify(`${OPENAI_API_BASE_URL}/models`)}, {
        headers: { authorization: ${JSON.stringify(`Bearer ${PLACEHOLDER_MODEL_KEY}`)} },
      }).then(async (response) => {
        console.log('status=' + response.status);
        if (!response.ok) console.log((await response.text()).slice(0, 500));
        process.exit(response.ok ? 0 : 1);
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
      });`,
    ],
  });
  const requestOutput = [await request.stdout(), await request.stderr()].join('\n').trim();
  if (request.exitCode !== 0) throw new Error(`OpenAI firewall probe failed:\n${requestOutput}`);

  const credentialScan = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      String.raw`
set -u
secret_names='OPENAI_API_KEY|AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN'
secret_shapes='sk-[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,}'
if env | grep -qE "^($secret_names)=|=($secret_shapes)"; then exit 1; fi
for process_dir in /proc/[0-9]*; do
  [ -r "$process_dir/environ" ] || continue
  if tr '\0' '\n' < "$process_dir/environ" | grep -qE "^($secret_names)=|=($secret_shapes)"; then
    exit 1
  fi
done
`,
    ],
  });
  if (credentialScan.exitCode !== 0) {
    throw new Error('A model credential was visible in the sandbox process environment');
  }

  console.log(
    JSON.stringify(
      {
        modelRequestStatus: 200,
        sandboxModelCredentialsAbsent: true,
        sandboxCredentialIsExactSentinel: true,
        sandboxCredentialDiffersFromHostKey: true,
      },
      null,
      2,
    ),
  );
} finally {
  await sandbox.stop();
}
