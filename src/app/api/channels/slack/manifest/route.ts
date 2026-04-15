import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { buildSlackManifest } from "@/server/channels/slack/app-definition";
import { buildPublicUrl } from "@/server/public-url";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    // Include the x-vercel-protection-bypass query parameter so Slack's URL
    // verification POST can pass through Vercel Deployment Protection. Slack
    // preserves and re-sends this query param on every subsequent webhook call.
    // See: https://vercel.com/kb/guide/test-slack-bot-with-vercel-preview-deployment
    const webhookUrl = buildPublicUrl("/api/channels/slack/webhook", request);
    const manifest = buildSlackManifest(webhookUrl);
    const manifestJson = JSON.stringify(manifest);
    const createAppUrl =
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;

    return authJsonOk(
      {
        manifest,
        createAppUrl,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
