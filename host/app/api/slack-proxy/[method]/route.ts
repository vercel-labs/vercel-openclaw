import { getToken } from '@vercel/connect';
import { createSlackApiProxy } from '@/lib/slack-api-proxy';

type RouteContext = { params: Promise<{ method: string }> };

function connector(): string {
  const value = process.env.SLACK_CONNECTOR;
  if (!value) throw new Error('SLACK_CONNECTOR not set');
  return value;
}

const proxy = createSlackApiProxy({
  bridgeToken: () => process.env.OPENCLAW_SLACK_HOST_BRIDGE_TOKEN,
  slackToken: async () =>
    await getToken(connector(), {
      subject: { type: 'app' },
    }),
});

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { method } = await context.params;
  return await proxy(request, method);
}

export const GET = handle;
export const POST = handle;
