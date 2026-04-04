/**
 * Smoke tests for POST /api/admin/ssh.
 *
 * Covers CSRF rejection, missing command validation, sandbox-not-running,
 * and happy-path execution for every suggested one-click command.
 *
 * The route runs all commands via `sh -c <command>` so that shell features
 * like glob expansion and pipes work correctly.
 *
 * Run: npm test src/app/api/admin/ssh/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getAdminSshRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import {
  FakeSandboxController,
  type CommandResponder,
} from "@/test-utils/harness";

patchNextServerAfter();

// ---------------------------------------------------------------------------
// Suggested commands — mirrors SUGGESTED_COMMANDS in ssh-panel.tsx
// ---------------------------------------------------------------------------

const SUGGESTED_COMMANDS = [
  { label: "Tail OpenClaw log", value: "tail -n 200 /tmp/openclaw/openclaw-*.log" },
  { label: "List OpenClaw logs", value: "ls -la /tmp/openclaw/" },
  { label: "Tail sandbox logs", value: "tail -n 200 /vercel/sandbox/.logs" },
  { label: "View config", value: "cat /etc/openclaw/openclaw.json" },
  { label: "Running processes", value: "ps aux" },
  { label: "Disk usage", value: "df -h" },
  { label: "Memory info", value: "free -h" },
  { label: "Network listeners", value: "ss -tlnp" },
] as const;

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  }
}

// ===========================================================================
// POST /api/admin/ssh — validation
// ===========================================================================

test("POST /api/admin/ssh: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getAdminSshRoute();
    const request = buildPostRequest("/api/admin/ssh", JSON.stringify({ command: "ls" }));
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED", `Expected UNAUTHORIZED, got: ${body.error}`);
  });
});

test("POST /api/admin/ssh: returns 409 when sandbox is not running", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "ls" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "SANDBOX_NOT_RUNNING");
  });
});

test("POST /api/admin/ssh: returns 400 for missing command", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-1";
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest("/api/admin/ssh", JSON.stringify({}));
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_COMMAND");
  });
});

test("POST /api/admin/ssh: returns 400 for invalid JSON", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-2";
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest("/api/admin/ssh", "not-json");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("POST /api/admin/ssh: returns 400 for command exceeding max length", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-3";
    });

    const route = getAdminSshRoute();
    const longCommand = "x".repeat(2001);
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: longCommand }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "COMMAND_TOO_LONG");
  });
});

// ===========================================================================
// Suggested one-click commands — happy path
//
// The route runs `sh -c <command>`, so the responder matches on `sh` and
// verifies the `-c` arg carries the full raw command string.
// ===========================================================================

for (const cmd of SUGGESTED_COMMANDS) {
  test(`POST /api/admin/ssh: suggested "${cmd.label}" succeeds`, async () => {
    await withTestEnv(async () => {
      const controller = new FakeSandboxController();
      _setSandboxControllerForTesting(controller);

      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-suggested";
      });

      const responder: CommandResponder = (c, a) => {
        if (c === "sh" && a?.[0] === "-c" && a[1] === cmd.value) {
          return {
            exitCode: 0,
            output: async (stream?: string) =>
              stream === "stderr" ? "" : `fake output for ${cmd.value}`,
          };
        }
        return undefined;
      };

      const handle = await controller.get({ sandboxId: "sbx-suggested" });
      (handle as import("@/test-utils/fake-sandbox-controller").FakeSandboxHandle)
        .responders.push(responder);

      const route = getAdminSshRoute();
      const request = buildAuthPostRequest(
        "/api/admin/ssh",
        JSON.stringify({ command: cmd.value }),
      );
      const result = await callRoute(route.POST!, request);

      assert.equal(result.status, 200, `${cmd.label} should return 200`);
      const body = result.json as {
        stdout: string;
        stderr: string;
        exitCode: number;
      };
      assert.equal(body.exitCode, 0, `${cmd.label} should exit 0`);
      assert.equal(body.stdout, `fake output for ${cmd.value}`);
      assert.equal(body.stderr, "");
    });
  });
}

// ===========================================================================
// Timeout handling
// ===========================================================================

test("POST /api/admin/ssh: returns 408 when command times out via AbortSignal", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-timeout";
    });

    const responder: CommandResponder = (c, a) => {
      if (c === "sh" && a?.[0] === "-c") {
        const error = new Error("The operation was aborted");
        error.name = "TimeoutError";
        throw error;
      }
      return undefined;
    };

    const handle = await controller.get({ sandboxId: "sbx-timeout" });
    (handle as import("@/test-utils/fake-sandbox-controller").FakeSandboxHandle)
      .responders.push(responder);

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "tail -f /some/file" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 408);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "COMMAND_TIMEOUT");
    assert.ok(body.message.includes("timed out"));
  });
});

test("POST /api/admin/ssh: returns 408 for AbortError", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-abort";
    });

    const responder: CommandResponder = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    };

    const handle = await controller.get({ sandboxId: "sbx-abort" });
    (handle as import("@/test-utils/fake-sandbox-controller").FakeSandboxHandle)
      .responders.push(responder);

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "some-slow-cmd" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 408);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "COMMAND_TIMEOUT");
  });
});

// ===========================================================================
// Shell execution verification
// ===========================================================================

test("POST /api/admin/ssh: commands are executed via sh -c", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-shell";
    });

    const handle = await controller.get({ sandboxId: "sbx-shell" });
    const fakeHandle =
      handle as import("@/test-utils/fake-sandbox-controller").FakeSandboxHandle;

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "echo hello && echo world" }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 200);

    const lastCmd = fakeHandle.commands[fakeHandle.commands.length - 1];
    assert.equal(lastCmd.cmd, "sh", "Should invoke sh");
    assert.deepEqual(lastCmd.args, ["-c", "echo hello && echo world"]);
  });
});
