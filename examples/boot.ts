import { Sandbox } from '@vercel/sandbox';

// Boots OpenClaw's official image from Vercel Container Registry and proves
// it runs. Auth: `vercel link` + `vercel env pull` in this directory so the
// SDK can read an OIDC token (see README quickstart).
const image = process.env.OPENCLAW_IMAGE ?? 'vercel/openclaw/openclaw:latest';

async function main() {
  console.log(`booting sandbox from ${image} ...`);
  const sandbox = await Sandbox.create({ image });

  try {
    const result = await sandbox.runCommand('openclaw', ['--version']);
    if (result.exitCode !== 0) {
      throw new Error(`openclaw --version exited ${result.exitCode}: ${await result.stderr()}`);
    }
    console.log(`openclaw --version -> ${(await result.stdout()).trim()}`);

    // Sandbox does not run the image's ENTRYPOINT/CMD. To start the gateway
    // instead, run it explicitly:
    //   await sandbox.runCommand({
    //     cmd: 'openclaw',
    //     args: ['gateway', '--port', '3000', '--bind', 'loopback'],
    //     detached: true,
    //   });
  } finally {
    await sandbox.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
