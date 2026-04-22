import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson } from "@/components/admin-types";
import type { ReadJsonDeps } from "@/components/admin-request-core";

import { CodexPanel } from "./codex-panel";

const READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
};

const REQUEST_JSON: RequestJson = async () => ({
  ok: true,
  data: null,
  meta: {
    requestId: "test",
    action: "test",
    label: "test",
    status: 200,
    refreshed: false,
  },
});

function render(active = true, busy = false): string {
  return renderToStaticMarkup(
    <CodexPanel
      active={active}
      busy={busy}
      requestJson={REQUEST_JSON}
      readDeps={READ_DEPS}
    />,
  );
}

test("CodexPanel renders header with provider name and disconnected pill on initial render", () => {
  const html = render();
  assert.ok(html.includes("OpenAI Codex"), "panel header should name the provider");
  assert.match(
    html,
    /channel-pill\s+idle[^"]*"[^>]*>Disconnected/,
    "disconnected pill should be idle variant before fetch completes",
  );
});

test("CodexPanel shows placeholder copy on initial render", () => {
  const html = render();
  assert.ok(
    html.includes("ChatGPT/Codex subscription"),
    "disconnected summary copy should mention ChatGPT/Codex",
  );
});

test("CodexPanel shows a loading placeholder while the first fetch is in flight", () => {
  // SSR snapshot happens before the fetch completes, so operators should see
  // a neutral loading state rather than a submittable form.
  const html = render();
  assert.ok(html.includes("Loading"));
  assert.ok(
    !/<button[^>]*type="submit"/.test(html),
    "submit button should be absent during initial loading",
  );
});

test("CodexPanel does not render the connect form while inactive", () => {
  const html = render(false);
  assert.ok(
    !html.includes("Connect with pasted credentials"),
    "no connect button when panel is inactive",
  );
  assert.ok(html.includes("OpenAI Codex"));
});

test("CodexPanel does not expose token fields that could be scraped from the DOM", () => {
  const html = render();
  // The panel takes pasted JSON, not a bearer/OAuth input — sanity check that
  // nothing leaks a token-like field name into the DOM at rest.
  assert.ok(!/name="token"/.test(html));
  assert.ok(!/name="refresh_token"/.test(html));
  assert.ok(!/name="access_token"/.test(html));
});
