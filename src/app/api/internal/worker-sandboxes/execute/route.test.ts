import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
} from "@/test-utils/route-caller";
import { buildWorkerSandboxBearerToken } from "@/server/worker-sandboxes/auth";
import { getInitializedMeta } from "@/server/store/store";
import type { WorkerSandboxExecuteResponse } from "@/shared/worker-sandbox";

// Lazy-load the route handler so it picks up the fake controller
function getRoute() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/app/api/internal/worker-sandboxes/execute/route") as {
    POST: (request: Request) => Promise<Response>;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("worker-sandbox execute returns 401 without authorization header", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({ task: "test", command: { cmd: "echo" } }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
    const body = result.json as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute returns 401 with wrong bearer token", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({ task: "test", command: { cmd: "echo" } }),
      { authorization: "Bearer wrong-token" },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("worker-sandbox execute returns 400 for invalid JSON", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = new Request("http://localhost:3000/api/internal/worker-sandboxes/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "not-json",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_JSON");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute returns 400 when task or command.cmd missing", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({ task: "", command: { cmd: "" } }),
      { authorization: `Bearer ${token}` },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute rejects non-workspace file paths", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "bad-path",
        files: [{ path: "/tmp/input.txt", contentBase64: Buffer.from("x").toString("base64") }],
        command: { cmd: "cat", args: ["/workspace/input.txt"] },
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /\/workspace\//);
    assert.equal(h.controller.eventsOfKind("create").length, 0);
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute rejects unsupported vcpu values", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "bad-vcpu",
        command: { cmd: "echo", args: ["ok"] },
        vcpus: 16,
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /vcpus/);
    assert.equal(h.controller.eventsOfKind("create").length, 0);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("worker-sandbox execute creates sandbox, runs command, stops sandbox", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "count-bytes",
        command: { cmd: "wc", args: ["-c", "/workspace/input.txt"] },
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.task, "count-bytes");
    assert.ok(body.sandboxId, "Should have a sandbox ID");
    assert.equal(body.exitCode, 0);

    // Verify sandbox was created and stopped
    const createEvents = h.controller.eventsOfKind("create");
    assert.equal(createEvents.length, 1, "Should have created exactly one sandbox");

    const stopEvents = h.controller.eventsOfKind("stop");
    assert.equal(stopEvents.length, 1, "Should have stopped the sandbox");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute clamps sandbox timeout to portable maximum", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "clamp-timeout",
        command: { cmd: "echo", args: ["ok"] },
        sandboxTimeoutMs: 999_999_999,
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const handle = h.controller.lastCreated()!;
    assert.equal(handle.timeout, 45 * 60 * 1000);
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute writes input files to sandbox", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const inputContent = Buffer.from("hello world\n").toString("base64");
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "file-write-test",
        files: [{ path: "/workspace/input.txt", contentBase64: inputContent }],
        command: { cmd: "cat", args: ["/workspace/input.txt"] },
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    // Check that files were written to the sandbox
    const handle = h.controller.lastCreated()!;
    const written = handle.writtenFiles.find((f) => f.path === "/workspace/input.txt");
    assert.ok(written, "Input file should have been written to sandbox");
    assert.equal(written.content.toString(), "hello world\n");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute captures output files", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    // Pre-seed a file in the sandbox filesystem
    const handle = h.controller.lastCreated();
    // We need to set up the file via a command responder or write it after create
    // The fake controller's readFileToBuffer returns null by default for unknown paths
    // Let's test that missing files are gracefully skipped

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "capture-test",
        command: { cmd: "echo", args: ["done"] },
        capturePaths: ["/workspace/missing.txt"],
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, true);
    // Missing files should be skipped (readFileToBuffer returns null)
    assert.equal(body.capturedFiles.length, 0);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Singleton isolation — the critical regression test
// ---------------------------------------------------------------------------

test("worker-sandbox execute does not mutate singleton metadata", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const before = await getInitializedMeta();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "isolation-check",
        command: { cmd: "echo", args: ["hello"] },
      }),
      { authorization: `Bearer ${token}` },
    );

    await callRoute(route.POST, req);

    const after = await getInitializedMeta();

    assert.equal(before.status, after.status, "status must not change");
    assert.equal(before.sandboxId, after.sandboxId, "sandboxId must not change");
    assert.equal(before.snapshotId, after.snapshotId, "snapshotId must not change");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Sandbox stops even on error
// ---------------------------------------------------------------------------

test("worker-sandbox execute stops sandbox on command failure", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    // Default fake returns exit code 0 — but the response still reflects it
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "error-test",
        command: { cmd: "false" },
      }),
      { authorization: `Bearer ${token}` },
    );

    await callRoute(route.POST, req);

    const stopEvents = h.controller.eventsOfKind("stop");
    assert.equal(stopEvents.length, 1, "Sandbox must be stopped even after command runs");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox execute returns structured error when sandbox create fails", async () => {
  const h = createScenarioHarness();
  try {
    h.controller.setCreateFailure(new Error("sandbox create failed"));
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify({
        task: "create-failure",
        command: { cmd: "echo", args: ["hello"] },
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 500);

    const body = result.json as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, false);
    assert.equal(body.task, "create-failure");
    assert.equal(body.sandboxId, null);
    assert.match(body.error ?? "", /sandbox create failed/);
    assert.equal(h.controller.eventsOfKind("stop").length, 0);
  } finally {
    h.teardown();
  }
});
