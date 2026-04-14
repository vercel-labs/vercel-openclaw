import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadAdminFaq } from "@/server/admin/faq";

function mockFetch(
  response: Response | Error,
): (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> {
  return async () => {
    if (response instanceof Error) {
      throw response;
    }

    return response;
  };
}

describe("loadAdminFaq", () => {
  test("returns remote FAQ when GitHub succeeds", async () => {
    const faq = await loadAdminFaq({
      fetchFn: mockFetch(
        new Response("## OpenClaw is currently pinned to {{OPENCLAW_VERSION}}. Why?", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
      ),
      readLocalFaq: async () => "# Local FAQ",
    });

    assert.deepEqual(faq, {
      markdown: "## OpenClaw is currently pinned to 2026.4.12. Why?",
      source: "remote",
      warning: null,
    });
  });

  test("falls back to local FAQ when GitHub fails", async () => {
    const faq = await loadAdminFaq({
      fetchFn: mockFetch(new Error("fetch failed")),
      readLocalFaq: async () => "# Local FAQ",
    });

    assert.deepEqual(faq, {
      markdown: "# Local FAQ",
      source: "local",
      warning: "Live FAQ unavailable. Showing the bundled fallback copy.",
    });
  });

  test("reports missing FAQ when both remote and local are unavailable", async () => {
    const faq = await loadAdminFaq({
      fetchFn: mockFetch(
        new Response("not found", {
          status: 404,
        }),
      ),
      readLocalFaq: async () => null,
    });

    assert.deepEqual(faq, {
      markdown: null,
      source: "missing",
      warning: "FAQ unavailable.",
    });
  });
});
