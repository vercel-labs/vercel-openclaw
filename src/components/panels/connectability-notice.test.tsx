import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChannelConnectability } from "@/shared/channel-connectability";

import { ConnectabilityNotice } from "./connectability-notice";

const connectability: ChannelConnectability = {
  channel: "slack",
  mode: "webhook-proxied",
  canConnect: false,
  status: "fail",
  webhookUrl: "https://openclaw.example/api/channels/slack/webhook",
  issues: [
    {
      id: "store",
      status: "fail",
      message: "Slack cannot be connected without durable state.",
      remediation: "Set REDIS_URL or install a Redis integration from the Vercel Marketplace.",
      env: ["REDIS_URL", "KV_URL"],
    },
  ],
};

test("ConnectabilityNotice hides suppressed issues", () => {
  const html = renderToStaticMarkup(
    <ConnectabilityNotice
      connectability={connectability}
      suppressedIds={new Set(["store"])}
    />,
  );
  assert.equal(html, "");
});

test("ConnectabilityNotice shows issues when IDs do not match", () => {
  const html = renderToStaticMarkup(
    <ConnectabilityNotice
      connectability={connectability}
      suppressedIds={new Set(["configure-redis"])}
    />,
  );
  assert.match(html, /Slack cannot be connected without durable state\./);
  assert.match(html, /Set REDIS_URL or install a Redis integration from the Vercel Marketplace\./);
});

test("ConnectabilityNotice shows all issues when no suppression", () => {
  const html = renderToStaticMarkup(
    <ConnectabilityNotice connectability={connectability} />,
  );
  assert.match(html, /Slack cannot be connected without durable state\./);
});
