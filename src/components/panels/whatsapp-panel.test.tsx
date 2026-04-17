import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import {
  getWhatsAppWebhookUrl,
  WhatsAppPanel,
} from "./whatsapp-panel";

function makeConnectability(
  status: ChannelConnectability["status"] = "warn",
): ChannelConnectability {
  return {
    channel: "whatsapp",
    mode: "webhook-proxied",
    canConnect: true,
    status,
    webhookUrl: "https://openclaw.example/api/channels/whatsapp/webhook",
    issues: [],
  };
}

const RUN_ACTION: RunAction = async () => true;
const REQUEST_JSON: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });

function makeStatus(
  whatsappOverrides: Partial<StatusPayload["channels"]["whatsapp"]> = {},
): StatusPayload {
  return {
    authMode: "admin-secret",
    storeBackend: "redis",
    persistentStore: true,
    status: "running",
    sandboxId: "sbx-test",
    snapshotId: "snap-test",
    gatewayReady: true,
    gatewayStatus: "ready",
    gatewayCheckedAt: null,
    gatewayUrl: "/gateway",
    lastError: null,
    lastKeepaliveAt: null,
    sleepAfterMs: 300_000,
    heartbeatIntervalMs: 15_000,
    timeoutRemainingMs: 120_000,
    timeoutSource: "estimated",
    setupProgress: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 0,
      lastIngestedAt: null,
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
    },
    channels: {
      slack: {
        configured: false,
        webhookUrl: "",
        configuredAt: null,
        team: null,
        user: null,
        botId: null,
        hasSigningSecret: false,
        hasBotToken: false,
        lastError: null,
        connectability: {
          channel: "slack",
          mode: "webhook-proxied",
          canConnect: true,
          status: "pass",
          webhookUrl: "",
          issues: [],
        },
        installMethod: "manual",
        installUrl: null,
        appCredentialsConfigured: false,
      },
      telegram: {
        configured: false,
        webhookUrl: null,
        botUsername: null,
        configuredAt: null,
        lastError: null,
        status: "disconnected",
        commandSyncStatus: "unsynced",
        commandsRegisteredAt: null,
        commandSyncError: null,
        connectability: {
          channel: "telegram",
          mode: "webhook-proxied",
          canConnect: true,
          status: "pass",
          webhookUrl: null,
          issues: [],
        },
      },
      discord: {
        configured: false,
        webhookUrl: "",
        applicationId: null,
        publicKey: null,
        configuredAt: null,
        appName: null,
        botUsername: null,
        endpointConfigured: false,
        endpointUrl: null,
        endpointError: null,
        commandRegistered: false,
        commandId: null,
        inviteUrl: null,
        isPublicUrl: false,
        connectability: {
          channel: "discord",
          mode: "webhook-proxied",
          canConnect: true,
          status: "pass",
          webhookUrl: "",
          issues: [],
        },
      },
      whatsapp: {
        configured: false,
        mode: "webhook-proxied",
        webhookUrl: null,
        status: "unconfigured",
        configuredAt: null,
        displayName: null,
        linkedPhone: null,
        lastError: null,
        requiresRunningSandbox: false,
        loginVia: "/gateway",
        connectability: makeConnectability(),
        ...whatsappOverrides,
      },
    },
    restoreTarget: {
      ...DEFAULT_STATUS_RESTORE_TARGET,
    },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
  };
}

function renderPanel(status: StatusPayload): string {
  return renderToStaticMarkup(
    <WhatsAppPanel
      status={status}
      busy={false}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
    />,
  );
}

test("getWhatsAppWebhookUrl builds the verification endpoint from an origin", () => {
  assert.equal(
    getWhatsAppWebhookUrl("https://openclaw.example"),
    "https://openclaw.example/api/channels/whatsapp/webhook",
  );
  assert.equal(getWhatsAppWebhookUrl(null), null);
});

test("WhatsAppPanel renders the business credential setup flow", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Connect WhatsApp"));
  assert.ok(html.includes("Phone Number ID"));
  assert.ok(html.includes("Access Token"));
  assert.ok(html.includes("Verify Token"));
  assert.ok(html.includes("App Secret"));
  assert.ok(html.includes("Business Account ID"));
  assert.ok(
    html.includes(
      "Resolve the deployment blockers above before saving WhatsApp credentials.",
    ) === false,
  );
});

/* ── Type contract: failure stubs satisfy RunAction and RequestJson ── */

const RUN_ACTION_FAILURE: RunAction = async () => false;
const REQUEST_JSON_FAILURE: RequestJson = async () => ({
  ok: false,
  error: "HTTP 500",
  meta: { requestId: "test", action: "test", label: "test", status: 500, code: "http-error" as const, retryable: true },
});

test("WhatsAppPanel accepts failure-shaped RunAction and RequestJson stubs", () => {
  const html = renderToStaticMarkup(
    <WhatsAppPanel
      status={makeStatus({
        configured: true,
        webhookUrl: "https://openclaw.example/api/channels/whatsapp/webhook",
        status: "linked",
        displayName: "Support",
        connectability: {
          ...makeConnectability(),
          status: "pass",
        },
      })}
      busy={false}
      runAction={RUN_ACTION_FAILURE}
      requestJson={REQUEST_JSON_FAILURE}
    />,
  );

  assert.ok(html.includes("Connected"), "renders connected state with failure stubs");
  assert.ok(html.includes("Disconnect"), "disconnect button present with failure stubs");
});

test("WhatsAppPanel renders connected details for configured accounts", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      webhookUrl: "https://openclaw.example/api/channels/whatsapp/webhook",
      status: "linked",
      displayName: "Support Inbox",
      linkedPhone: "+1 555 010 1000",
      connectability: {
        ...makeConnectability(),
        issues: [],
        status: "pass",
      },
    }),
  );

  assert.ok(html.includes("Connected · Support Inbox · +1 555 010 1000"));
  assert.ok(html.includes("Business account"));
  assert.ok(html.includes("Webhook URL"));
  assert.ok(html.includes("linked"));
  assert.ok(html.includes("https://openclaw.example/api/channels/whatsapp/webhook"));
  assert.ok(html.includes("Update credentials"));
  assert.ok(html.includes("Disconnect"));
});
