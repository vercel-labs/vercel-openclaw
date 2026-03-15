import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";

test("telegram PUT returns 409 on localhost origin", () => {
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = buildChannelConnectability("telegram", request);
  assert.equal(connectability.canConnect, false);
  assert.equal(connectability.channel, "telegram");
  assert.ok(connectability.issues.some((i) => i.status === "fail"));

  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  assert.equal(response.status, 409);
});

test("telegram 409 response body matches expected shape", async () => {
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = buildChannelConnectability("telegram", request);
  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  const payload = (await response.json()) as {
    error: { code: string; message: string };
    connectability: { channel: string; canConnect: boolean; issues: { id: string }[] };
  };

  assert.equal(payload.error.code, "CHANNEL_CONNECT_BLOCKED");
  assert.equal(payload.connectability.channel, "telegram");
  assert.equal(payload.connectability.canConnect, false);
  assert.ok(payload.connectability.issues.length > 0);
});
