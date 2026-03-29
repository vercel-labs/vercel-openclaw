import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH,
  buildWorkerSandboxScript,
  buildWorkerSandboxBatchScript,
} from "@/server/openclaw/config";
import {
  buildRestoreAssetManifest,
  buildRestoreRuntimeEnv,
} from "@/server/openclaw/restore-assets";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";
import { buildWorkerSandboxBearerToken } from "@/server/worker-sandboxes/auth";
import type { WorkerSandboxExecuteResponse } from "@/shared/worker-sandbox";
import { createScenarioHarness } from "@/test-utils/harness";
import { buildPostRequest, callRoute } from "@/test-utils/route-caller";

function getWorkerSandboxRoute() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/app/api/internal/worker-sandboxes/execute/route") as {
    POST: (request: Request) => Promise<Response>;
  };
}

async function runWorkerSandboxScriptForTest(options: {
  scriptContent: string;
  gatewayToken: string;
  configJson: string;
  requestJson: string;
  fetchImpl: typeof fetch;
}): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "worker-sandbox-script-"));
  const tokenPath = join(dir, "gateway-token.txt");
  const configPath = join(dir, "openclaw.json");
  const requestPath = join(dir, "request.json");
  const scriptPath = join(dir, "execute.mjs");

  const patchedScript = options.scriptContent
    .replaceAll(OPENCLAW_GATEWAY_TOKEN_PATH, tokenPath)
    .replaceAll(OPENCLAW_CONFIG_PATH, configPath);

  await writeFile(tokenPath, options.gatewayToken, "utf8");
  await writeFile(configPath, options.configJson, "utf8");
  await writeFile(requestPath, options.requestJson, "utf8");
  await writeFile(scriptPath, patchedScript, "utf8");

  const stdout: string[] = [];
  const stderr: string[] = [];

  const previousArgv = process.argv.slice();
  const mutableGlobal = globalThis as typeof globalThis & {
    fetch: typeof fetch;
  };
  const previousFetch = mutableGlobal.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;

  let exitCode = 0;
  try {
    mutableGlobal.fetch = options.fetchImpl;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((value) => String(value)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      stderr.push(args.map((value) => String(value)).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`__worker_sandbox_exit__:${code ?? 0}`);
    }) as typeof process.exit;

    process.argv = ["node", scriptPath, requestPath];

    try {
      await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (!message.startsWith("__worker_sandbox_exit__:")) {
        throw error;
      }
      exitCode = Number.parseInt(
        message.replace("__worker_sandbox_exit__:", ""),
        10,
      );
    }
  } finally {
    process.argv = previousArgv;
    mutableGlobal.fetch = previousFetch;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    await rm(dir, { recursive: true, force: true });
  }

  return { exitCode, stdout, stderr };
}

test("restore preloads worker-sandbox assets before boot for pre-feature snapshots", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-pre-worker-sandbox";
      meta.snapshotAssetSha256 = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    // Allow the gateway readiness probe to succeed
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-preload-worker-sandbox",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const handle = h.controller.lastCreated()!;
    const writtenPaths = handle.writtenFiles.map((file) => file.path);

    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH));
    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH));

    const writeIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "write_files") return false;
      const detail = event.detail as { paths?: unknown } | undefined;
      return (
        Array.isArray(detail?.paths) &&
        (detail.paths as string[]).includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH)
      );
    });

    const bootIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "command") return false;
      const detail = event.detail as { command?: unknown; args?: unknown } | undefined;
      return (
        detail?.command === "bash" &&
        Array.isArray(detail.args) &&
        detail.args[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      );
    });

    assert.ok(writeIndex >= 0, "worker-sandbox files should be written during restore");
    assert.ok(bootIndex >= 0, "fast restore script should run");
    assert.ok(
      writeIndex < bootIndex,
      "worker-sandbox files must exist before gateway boot",
    );
  } finally {
    h.teardown();
  }
});

test("restore still preloads worker-sandbox assets for legacy snapshots even when lastRestoreMetrics.assetSha256 matches current manifest", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-legacy-worker-sandbox";
      meta.snapshotAssetSha256 = null;
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 1,
        tokenWriteMs: 0,
        assetSyncMs: 1,
        startupScriptMs: 1,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 1,
        publicReadyMs: 1,
        totalMs: 1,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: false,
        dynamicConfigHash: null,
        dynamicConfigReason: "no-snapshot-hash",
        assetSha256: buildRestoreAssetManifest().sha256,
        vcpus: 1,
        recordedAt: Date.now(),
        bootOverlapMs: 1,
        skippedPublicReady: false,
        cronRestoreOutcome: "no-store-jobs",
      };
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-legacy-worker-sandbox",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const handle = h.controller.lastCreated()!;
    const writtenPaths = handle.writtenFiles.map((file) => file.path);

    assert.ok(
      writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH),
      "worker-sandbox skill should still be preloaded for legacy snapshots",
    );
    assert.ok(
      writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH),
      "worker-sandbox script should still be preloaded for legacy snapshots",
    );

    const writeIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "write_files") return false;
      const detail = event.detail as { paths?: unknown } | undefined;
      return (
        Array.isArray(detail?.paths) &&
        (detail.paths as string[]).includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH)
      );
    });

    const bootIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "command") return false;
      const detail = event.detail as
        | { command?: unknown; args?: unknown }
        | undefined;
      return (
        detail?.command === "bash" &&
        Array.isArray(detail.args) &&
        detail.args[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      );
    });

    assert.ok(writeIndex >= 0, "worker-sandbox preload write should happen");
    assert.ok(bootIndex >= 0, "fast restore boot should happen");
    assert.ok(
      writeIndex < bootIndex,
      "worker-sandbox files must still be written before gateway boot",
    );
  } finally {
    h.teardown();
  }
});

test("legacy snapshot restore can still execute a worker sandbox request without mutating singleton state", async () => {
  const h = createScenarioHarness();
  try {
    const currentManifestHash = buildRestoreAssetManifest().sha256;

    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-legacy-worker-sandbox-e2e";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotAssetSha256 = null;
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: false,
        dynamicConfigHash: "legacy-dynamic-config-hash",
        dynamicConfigReason: "no-snapshot-hash",
        assetSha256: currentManifestHash,
        vcpus: 1,
        recordedAt: Date.now(),
        bootOverlapMs: 0,
        skippedPublicReady: true,
        cronRestoreOutcome: "no-store-jobs",
      } as NonNullable<typeof meta.lastRestoreMetrics>;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    // Allow gateway readiness probe to succeed
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    // --- Restore the sandbox ---
    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-legacy-worker-sandbox-e2e",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    // Capture singleton state before the child-sandbox request
    const before = await getInitializedMeta();
    const createCountBefore = h.controller.eventsOfKind("create").length;

    // --- Call the worker-sandbox execute route ---
    const route = getWorkerSandboxRoute();
    const token = await buildWorkerSandboxBearerToken();

    const requestBody = {
      task: "process-image",
      files: [
        {
          path: "/workspace/input.txt",
          contentBase64: Buffer.from(
            "hello from restored sandbox\n",
            "utf8",
          ).toString("base64"),
        },
      ],
      command: { cmd: "cat", args: ["/workspace/input.txt"] },
      capturePaths: ["/workspace/input.txt"],
      vcpus: 1,
      sandboxTimeoutMs: 300_000,
    };

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute",
      JSON.stringify(requestBody),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200, `expected 200 but got ${result.status}: ${result.text}`);

    const body = result.json as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.task, "process-image");
    assert.equal(body.exitCode, 0);
    assert.equal(body.capturedFiles.length, 1);
    assert.equal(body.capturedFiles[0]!.path, "/workspace/input.txt");
    assert.equal(
      Buffer.from(body.capturedFiles[0]!.contentBase64, "base64").toString(
        "utf8",
      ),
      "hello from restored sandbox\n",
    );

    // --- Verify singleton metadata was not mutated ---
    const after = await getInitializedMeta();
    assert.equal(after.status, before.status, "status must not change");
    assert.equal(
      after.sandboxId,
      before.sandboxId,
      "sandboxId must not change",
    );
    assert.equal(
      after.snapshotId,
      before.snapshotId,
      "snapshotId must not change",
    );

    // --- Verify exactly one additional create event for the child sandbox ---
    assert.equal(
      h.controller.eventsOfKind("create").length,
      createCountBefore + 1,
      "restored OpenClaw should spawn exactly one child sandbox",
    );
  } finally {
    h.teardown();
  }
});

test("legacy snapshot restore leaves a runnable worker-sandbox launcher in the restored sandbox", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-legacy-worker-sandbox-script";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotAssetSha256 = null;
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotConfigHash = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-legacy-worker-sandbox-script",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const restoredHandle = h.controller.lastCreated()!;
    const scriptFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
    );
    const configFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_CONFIG_PATH,
    );

    assert.ok(
      scriptFile,
      "restore should rewrite worker-sandbox script for legacy snapshots",
    );
    assert.equal(
      scriptFile.content.toString("utf8"),
      buildWorkerSandboxScript(),
      "restored launcher should match the current generated script",
    );
    assert.ok(
      configFile,
      "restore should rewrite openclaw.json for legacy snapshots",
    );

    const before = await getInitializedMeta();
    const createCountBefore = h.controller.eventsOfKind("create").length;

    const route = getWorkerSandboxRoute();

    let seenUrl: string | null = null;
    let seenAuth: string | null = null;
    let seenBody: string | null = null;

    const requestBody = {
      task: "process-image",
      files: [
        {
          path: "/workspace/input.txt",
          contentBase64: Buffer.from(
            "hello from restored sandbox\n",
            "utf8",
          ).toString("base64"),
        },
      ],
      command: { cmd: "cat", args: ["/workspace/input.txt"] },
      capturePaths: ["/workspace/input.txt"],
      vcpus: 1,
      sandboxTimeoutMs: 300_000,
    };

    const scriptRun = await runWorkerSandboxScriptForTest({
      scriptContent: scriptFile.content.toString("utf8"),
      gatewayToken: before.gatewayToken,
      configJson: configFile.content.toString("utf8"),
      requestJson: JSON.stringify(requestBody),
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        seenUrl = url;
        const headers = new Headers(init?.headers);
        seenAuth = headers.get("authorization");
        seenBody =
          typeof init?.body === "string" ? init.body : null;
        return route.POST(
          new Request(url, {
            method: init?.method ?? "GET",
            headers,
            body: init?.body,
          }),
        );
      },
    });

    assert.equal(scriptRun.exitCode, 0);
    assert.equal(scriptRun.stderr.length, 0);
    assert.equal(
      seenUrl,
      "https://test.example.com/api/internal/worker-sandboxes/execute",
    );

    const expectedToken = await buildWorkerSandboxBearerToken();
    assert.equal(seenAuth, `Bearer ${expectedToken}`);
    assert.equal(
      seenBody,
      JSON.stringify(requestBody),
      "launcher should post the unchanged request JSON",
    );

    const body = JSON.parse(
      scriptRun.stdout.join("\n"),
    ) as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.task, "process-image");
    assert.equal(body.exitCode, 0);
    assert.equal(body.capturedFiles.length, 1);
    assert.equal(body.capturedFiles[0]!.path, "/workspace/input.txt");
    assert.equal(
      Buffer.from(body.capturedFiles[0]!.contentBase64, "base64").toString(
        "utf8",
      ),
      "hello from restored sandbox\n",
    );

    const after = await getInitializedMeta();
    assert.equal(after.status, before.status, "status must not change");
    assert.equal(
      after.sandboxId,
      before.sandboxId,
      "sandboxId must not change",
    );
    assert.equal(
      after.snapshotId,
      before.snapshotId,
      "snapshotId must not change",
    );
    assert.equal(
      h.controller.eventsOfKind("create").length,
      createCountBefore + 1,
      "restored OpenClaw should spawn exactly one child sandbox",
    );
  } finally {
    h.teardown();
  }
});

test("restored launcher round-trips binary image payload unchanged through the worker-sandbox route", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-legacy-binary-compat";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotAssetSha256 = null;
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotConfigHash = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-binary-compat",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const restoredHandle = h.controller.lastCreated()!;
    const scriptFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
    );
    const configFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_CONFIG_PATH,
    );

    assert.ok(scriptFile, "restore should rewrite worker-sandbox script");
    assert.ok(configFile, "restore should rewrite openclaw.json");

    const before = await getInitializedMeta();
    const createCountBefore = h.controller.eventsOfKind("create").length;

    const route = getWorkerSandboxRoute();

    // PNG magic bytes + a small arbitrary payload
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);

    const requestBody = {
      task: "process-image",
      files: [
        {
          path: "/workspace/input.png",
          contentBase64: imageBytes.toString("base64"),
        },
      ],
      command: {
        cmd: "bash",
        args: ["-lc", "cp /workspace/input.png /workspace/output.png"],
      },
      capturePaths: ["/workspace/output.png"],
      vcpus: 1,
      sandboxTimeoutMs: 300_000,
    };

    // Simulate the cp command: copy input.png bytes to output.png in writtenFiles
    h.controller.defaultResponders.unshift((cmd) => {
      if (cmd !== "bash") return undefined;
      const handle = h.controller.lastCreated();
      if (!handle) return undefined;
      const inputFile = handle.writtenFiles.find(
        (f) => f.path === "/workspace/input.png",
      );
      if (!inputFile) return undefined;
      handle.writtenFiles.push({
        path: "/workspace/output.png",
        content: inputFile.content,
      });
      return {
        exitCode: 0,
        output: async () => "",
      };
    });

    let seenBody: string | null = null;

    const scriptRun = await runWorkerSandboxScriptForTest({
      scriptContent: scriptFile.content.toString("utf8"),
      gatewayToken: before.gatewayToken,
      configJson: configFile.content.toString("utf8"),
      requestJson: JSON.stringify(requestBody),
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const headers = new Headers(init?.headers);
        seenBody =
          typeof init?.body === "string" ? init.body : null;
        return route.POST(
          new Request(url, {
            method: init?.method ?? "GET",
            headers,
            body: init?.body,
          }),
        );
      },
    });

    assert.equal(scriptRun.exitCode, 0);
    assert.equal(scriptRun.stderr.length, 0);

    // The launcher must forward JSON.stringify(requestBody) unchanged
    assert.equal(
      seenBody,
      JSON.stringify(requestBody),
      "launcher should post the unchanged binary request JSON",
    );

    const body = JSON.parse(
      scriptRun.stdout.join("\n"),
    ) as WorkerSandboxExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.task, "process-image");
    assert.equal(body.exitCode, 0);
    assert.equal(body.capturedFiles.length, 1);
    assert.equal(body.capturedFiles[0]!.path, "/workspace/output.png");

    // The captured output bytes must exactly match the original input bytes
    const capturedBytes = Buffer.from(
      body.capturedFiles[0]!.contentBase64,
      "base64",
    );
    assert.deepEqual(
      capturedBytes,
      imageBytes,
      "captured /workspace/output.png bytes must exactly match input image bytes",
    );

    // Singleton metadata must not change
    const after = await getInitializedMeta();
    assert.equal(after.status, before.status, "status must not change");
    assert.equal(
      after.sandboxId,
      before.sandboxId,
      "sandboxId must not change",
    );
    assert.equal(
      after.snapshotId,
      before.snapshotId,
      "snapshotId must not change",
    );

    // Exactly one additional child sandbox create event
    assert.equal(
      h.controller.eventsOfKind("create").length,
      createCountBefore + 1,
      "restored OpenClaw should spawn exactly one child sandbox",
    );
  } finally {
    h.teardown();
  }
});

test("worker-sandbox launcher exits clearly when restored config has no allowed origin", async () => {
  let fetchCalled = false;
  const result = await runWorkerSandboxScriptForTest({
    scriptContent: buildWorkerSandboxScript(),
    gatewayToken: "gw-token",
    configJson: JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: [],
        },
      },
    }),
    requestJson: JSON.stringify({
      task: "no-origin",
      command: { cmd: "echo", args: ["ok"] },
    }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error(
        "fetch should not be called when allowed origin is missing",
      );
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stdout, []);
  assert.ok(
    result.stderr.some((line) =>
      line.includes("Could not resolve host origin from openclaw.json"),
    ),
    `expected stderr to mention missing origin, got: ${result.stderr.join("\n")}`,
  );
});

test("restore runtime env gives the worker-sandbox script the current deployment origin", async () => {
  const restoreEnv = buildRestoreRuntimeEnv({
    gatewayToken: "restore-gateway-token",
    proxyOrigin: "https://current.example.com",
  });

  const encodedConfig = restoreEnv.OPENCLAW_CONFIG_JSON_B64;
  assert.ok(encodedConfig);

  const configJson = Buffer.from(encodedConfig, "base64").toString("utf8");

  let requestedUrl: string | null = null;
  let authorizationHeader: string | null = null;

  const result = await runWorkerSandboxScriptForTest({
    scriptContent: buildWorkerSandboxScript(),
    gatewayToken: "restore-gateway-token",
    configJson,
    requestJson: JSON.stringify({
      task: "process-images",
      command: { cmd: "bash", args: ["-lc", "echo ok"] },
    }),
    fetchImpl: async (input, init) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const headers = new Headers(
        init?.headers ??
          (typeof input === "string" || input instanceof URL
            ? undefined
            : input.headers),
      );
      authorizationHeader = headers.get("authorization");

      const body: WorkerSandboxExecuteResponse = {
        ok: true,
        task: "process-images",
        sandboxId: "sbx-child-1",
        exitCode: 0,
        stdout: "done\n",
        stderr: "",
        capturedFiles: [],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    requestedUrl,
    "https://current.example.com/api/internal/worker-sandboxes/execute",
  );
  assert.ok(authorizationHeader);
  assert.match(authorizationHeader, /^Bearer [0-9a-f]{64}$/);
});

test("restore preloads batch launcher files alongside single-execute launcher", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-pre-batch-launcher";
      meta.snapshotAssetSha256 = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-preload-batch-launcher",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const handle = h.controller.lastCreated()!;
    const writtenPaths = handle.writtenFiles.map((file) => file.path);

    // Single launcher files
    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH));
    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH));

    // Batch launcher files
    assert.ok(
      writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH),
      "batch skill should be preloaded during restore",
    );
    assert.ok(
      writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH),
      "batch script should be preloaded during restore",
    );

    // Both must be written before boot
    const batchWriteIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "write_files") return false;
      const detail = event.detail as { paths?: unknown } | undefined;
      return (
        Array.isArray(detail?.paths) &&
        (detail.paths as string[]).includes(OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH)
      );
    });

    const bootIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "command") return false;
      const detail = event.detail as { command?: unknown; args?: unknown } | undefined;
      return (
        detail?.command === "bash" &&
        Array.isArray(detail.args) &&
        detail.args[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      );
    });

    assert.ok(batchWriteIndex >= 0, "batch launcher files should be written during restore");
    assert.ok(bootIndex >= 0, "fast restore script should run");
    assert.ok(
      batchWriteIndex < bootIndex,
      "batch launcher files must exist before gateway boot",
    );
  } finally {
    h.teardown();
  }
});

test("restored batch launcher script resolves correct endpoint and auth", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-batch-launcher-script";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotAssetSha256 = null;
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotConfigHash = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-batch-launcher-script",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const restoredHandle = h.controller.lastCreated()!;
    const scriptFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH,
    );

    assert.ok(
      scriptFile,
      "restore should write batch launcher script",
    );
    assert.equal(
      scriptFile.content.toString("utf8"),
      buildWorkerSandboxBatchScript(),
      "restored batch launcher should match the current generated script",
    );

    const before = await getInitializedMeta();

    let seenUrl: string | null = null;
    let seenAuth: string | null = null;

    const batchRequest = {
      task: "batch-test",
      jobs: [
        {
          id: "job-1",
          request: {
            task: "sub-1",
            command: { cmd: "echo", args: ["ok"] },
          },
        },
      ],
    };

    const configFile = restoredHandle.writtenFiles.find(
      (file) => file.path === OPENCLAW_CONFIG_PATH,
    );
    assert.ok(configFile, "restore should rewrite openclaw.json");

    const scriptRun = await runWorkerSandboxScriptForTest({
      scriptContent: scriptFile.content.toString("utf8"),
      gatewayToken: before.gatewayToken,
      configJson: configFile.content.toString("utf8"),
      requestJson: JSON.stringify(batchRequest),
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        seenUrl = url;
        const headers = new Headers(init?.headers);
        seenAuth = headers.get("authorization");

        // Return a mock batch response
        return new Response(
          JSON.stringify({
            ok: true,
            task: "batch-test",
            totalJobs: 1,
            succeeded: 1,
            failed: 0,
            results: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    assert.equal(scriptRun.exitCode, 0);
    assert.equal(
      seenUrl,
      "https://test.example.com/api/internal/worker-sandboxes/execute-batch",
    );

    const expectedToken = await buildWorkerSandboxBearerToken();
    assert.equal(seenAuth, `Bearer ${expectedToken}`);

    // Singleton metadata must not change
    const after = await getInitializedMeta();
    assert.equal(after.status, before.status, "status must not change");
    assert.equal(after.sandboxId, before.sandboxId, "sandboxId must not change");
  } finally {
    h.teardown();
  }
});

test("worker-sandbox launcher prints non-ok host responses to stderr and exits non-zero", async () => {
  const errorText = JSON.stringify({
    error: {
      code: "INVALID_REQUEST",
      message: "bad child sandbox request",
    },
  });

  const result = await runWorkerSandboxScriptForTest({
    scriptContent: buildWorkerSandboxScript(),
    gatewayToken: "test-gw-token",
    configJson: JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: ["https://test.example.com"],
        },
      },
    }),
    requestJson: JSON.stringify({
      task: "host-error",
      command: { cmd: "echo", args: ["ok"] },
    }),
    fetchImpl: async () =>
      new Response(errorText, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stdout, []);
  assert.deepEqual(result.stderr, [errorText]);
});
