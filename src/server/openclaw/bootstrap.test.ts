import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import {
  OPENCLAW_BIN,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
  OPENCLAW_VISION_SKILL_PATH,
  OPENCLAW_VISION_SCRIPT_PATH,
  OPENCLAW_TTS_SKILL_PATH,
  OPENCLAW_TTS_SCRIPT_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
  OPENCLAW_EMBEDDINGS_SKILL_PATH,
  OPENCLAW_EMBEDDINGS_SCRIPT_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH,
  OPENCLAW_TRANSCRIPTION_SKILL_PATH,
  OPENCLAW_TRANSCRIPTION_SCRIPT_PATH,
  OPENCLAW_REASONING_SKILL_PATH,
  OPENCLAW_REASONING_SCRIPT_PATH,
  OPENCLAW_COMPARE_SKILL_PATH,
  OPENCLAW_COMPARE_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_WORKSPACE_TEMPLATES_DIR,
} from "@/server/openclaw/config";
import { setupOpenClaw, waitForGatewayReady, detectDrift, CommandFailedError } from "@/server/openclaw/bootstrap";
import { getOpenclawPackageSpec } from "@/server/env";
import {
  createScenarioHarness,
  type CommandResponder,
} from "@/test-utils/harness";
import { OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE } from "@/server/openclaw/bundle-compatibility";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  mock.restoreAll();
});

/** Create a sandbox handle seeded in the fake controller. */
async function createHandle(h: ReturnType<typeof createScenarioHarness>) {
  await h.controller.create({ ports: [3000] });
  return h.controller.lastCreated()!;
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// setupOpenClaw — command sequence
// ---------------------------------------------------------------------------

test("setupOpenClaw installs @buape/carbon peer dep during bootstrap", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-peer",
      proxyOrigin: "https://proxy.test",
    });

    const peerDepCmd = handle.commands.find(
      (c) =>
        c.cmd === "bash"
        && c.args?.[1]?.includes("@buape/carbon"),
    );
    assert.ok(peerDepCmd, "peer-deps install command should include @buape/carbon");
    assert.ok(
      peerDepCmd.args?.[1]?.includes("npm install @buape/carbon"),
      "peer-deps command should run npm install @buape/carbon",
    );
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw logs openclaw.bootstrap.peer_deps_ready on success", async () => {
  const { _resetLogBuffer, getServerLogs } = await import("@/server/log");
  const h = createScenarioHarness();
  try {
    _resetLogBuffer();
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-log",
      proxyOrigin: "https://proxy.test",
    });

    const peerReady = getServerLogs().filter(
      (e) => e.message === "openclaw.bootstrap.peer_deps_ready",
    );
    assert.equal(peerReady.length, 1, "expected single peer_deps_ready log");
    const data = peerReady[0]!.data as Record<string, unknown>;
    assert.equal(data.package, "@buape/carbon", "log should include package name");
    assert.equal(data.sandboxId, handle.sandboxId, "log should include sandboxId");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw executes commands in correct order", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-test",
      proxyOrigin: "https://example.com",
    });

    const cmds = handle.commands.map((c) => c.cmd);

    // npm install → bash (peer-deps) → sh (bun) → bash (cache) → node (install patch)
    // → openclaw --version → bash (startup) → bash (ps) → bash (ports)
    // → bash (log) → curl (probe) → node (pair)
    assert.equal(cmds[0], "npm", "first command should be npm install");
    assert.equal(cmds[1], "bash", "second command should be peer-deps install");
    assert.equal(cmds[2], "sh", "third command should be bun install");
    assert.equal(cmds[3], "bash", "fourth command should be npm cache cleanup");
    assert.equal(cmds[4], "node", "fifth command should be install patch");
    assert.equal(cmds[5], OPENCLAW_BIN, "sixth command should be version check");
    assert.equal(cmds[6], "bash", "seventh command should be startup script");
    // cmds 7-9 are diagnostic checks (ps, ports, log)
    const probeIdx = cmds.indexOf("curl");
    assert.ok(probeIdx > 6, "gateway probe should come after startup");
    const pairIdx = cmds.indexOf("node", probeIdx);
    assert.ok(pairIdx > probeIdx, "force-pair should come after gateway probe");

    const defaultSpec = getOpenclawPackageSpec();
    // Verify npm install uses the resolved package spec
    assert.deepEqual(handle.commands[0].args, [
      "install", "-g", defaultSpec, "--ignore-scripts", "--loglevel", "info",
    ]);

    // Verify npm cache cleanup args (now at index 3)
    assert.deepEqual(handle.commands[3].args, [
      "-lc",
      [
        "rm -rf /home/vercel-sandbox/.npm || true",
        "rm -rf /root/.npm || true",
        "rm -rf /tmp/openclaw-npm-cache || true",
      ].join("\n"),
    ]);

    // Verify install patch args (now at index 4)
    assert.deepEqual(handle.commands[4].args, [OPENCLAW_INSTALL_PATCH_SCRIPT_PATH]);

    // Verify version check args (now at index 5)
    assert.deepEqual(handle.commands[5].args, ["--version"]);

    // Verify startup script invocation (now at index 6)
    assert.deepEqual(handle.commands[6].args, [OPENCLAW_STARTUP_SCRIPT_PATH]);

    // Verify force-pair invocation
    assert.deepEqual(handle.commands[pairIdx].args, [
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STATE_DIR,
    ]);
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw extracts bundle workspace templates into runtime working tree", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () => new Response("not found", { status: 404 }));
      const handle = await createHandle(h);

      await setupOpenClaw(handle, {
        gatewayToken: "tok-bundle",
        proxyOrigin: "https://example.com",
      });

      const bundleDownload = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[1]?.includes("workspace-templates.tar.gz"),
      );
      assert.ok(bundleDownload, "bundle download command should fetch workspace templates");
      assert.ok(
        bundleDownload.args?.[1]?.includes(`mkdir -p ${JSON.stringify(OPENCLAW_WORKSPACE_TEMPLATES_DIR)}`),
        "workspace template directory should match the bundle runtime working tree",
      );
      assert.ok(
        bundleDownload.args?.[1]?.includes(`tar xz -C ${JSON.stringify(OPENCLAW_WORKSPACE_TEMPLATES_DIR)}`),
        "workspace templates should extract into the bundle runtime working tree",
      );
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw warns and continues when bundle asset manifest is absent", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const { _resetLogBuffer, getServerLogs } = await import("@/server/log");
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () => new Response("not found", { status: 404 }));
      _resetLogBuffer();
      const handle = await createHandle(h);

      await setupOpenClaw(handle, {
        gatewayToken: "tok-bundle-manifest-missing",
        proxyOrigin: "https://example.com",
      });

      assert.ok(
        getServerLogs().some((entry) => entry.message === "openclaw.setup.bundle_manifest_missing"),
        "missing asset-manifest.json should be warning-only for legacy bundles",
      );
      assert.ok(
        handle.commands.some((c) => c.cmd === "bash" && c.args?.[1]?.includes("openclaw.bundle.mjs")),
        "legacy bundle bootstrap should continue after manifest warning",
      );
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw fails before downloads when present bundle manifest is incompatible", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () =>
        Response.json({ schemaVersion: 2, name: "openclaw-sandbox-bundle", profile: "sandbox" }),
      );
      const handle = await createHandle(h);

      await assert.rejects(
        setupOpenClaw(handle, {
          gatewayToken: "tok-bundle-manifest-bad",
          proxyOrigin: "https://example.com",
        }),
        new RegExp(OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE),
      );

      assert.equal(handle.commands.length, 0, "bootstrap should fail before sandbox downloads");
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw fails before downloads when present bundle manifest is malformed JSON", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const handle = await createHandle(h);

      await assert.rejects(
        setupOpenClaw(handle, {
          gatewayToken: "tok-bundle-manifest-malformed",
          proxyOrigin: "https://example.com",
        }),
        new RegExp(OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE),
      );

      assert.equal(handle.commands.length, 0, "bootstrap should fail before sandbox downloads");
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw extracts bundled channel plugins into OpenClaw trusted dist extensions", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () => new Response("not found", { status: 404 }));
      const handle = await createHandle(h);

      await setupOpenClaw(handle, {
        gatewayToken: "tok-bundle-channels",
        proxyOrigin: "https://example.com",
      });

      const channelsDownload = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[1]?.includes("channels.tar.gz"),
      );
      assert.ok(channelsDownload, "bundle command should fetch channel plugins");
      const script = channelsDownload.args?.[1] ?? "";
      assert.ok(
        script.includes(`mkdir -p ${JSON.stringify(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`),
        "channel plugin directory should use the trusted bundled plugin path",
      );
      assert.ok(
        script.includes(`tar xz -C ${JSON.stringify(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`),
        "channel plugins should extract into the trusted bundled plugin path",
      );
      assert.equal(
        OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
        "/home/vercel-sandbox/dist/extensions",
        "OpenClaw bundle discovery only trusts dist/extensions under the bundle package root",
      );
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw preserves bundle package root identity after shim package extraction", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () => new Response("not found", { status: 404 }));
      const handle = await createHandle(h);

      await setupOpenClaw(handle, {
        gatewayToken: "tok-bundle-package-root",
        proxyOrigin: "https://example.com",
      });

      const openclawPkg = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[1]?.includes("bundle-openclaw-pkg.tar.gz"),
      );
      assert.ok(openclawPkg, "bundle command should fetch the openclaw shim package");
      const script = openclawPkg.args?.[1] ?? "";
      assert.ok(
        script.includes(`tar xz -C /home/vercel-sandbox`),
        "shim package should extract at the bundle package root",
      );
      assert.ok(
        script.includes(
          "cp /home/vercel-sandbox/node_modules/openclaw/dist/plugins/runtime/index.js /home/vercel-sandbox/dist/plugins/runtime/index.js",
        ),
        "shim package extraction should stage the plugin runtime at the bundle package root",
      );
      assert.ok(
        script.includes(`echo '{"name":"openclaw","private":true,"version":"0.0.0","type":"module"}' > /home/vercel-sandbox/package.json`),
        "shim package extraction must not leave the package root named as the sandbox runtime helper",
      );
    } finally {
      h.teardown();
    }
  });
});

test("setupOpenClaw creates bundle compatibility shims after shared chunks extraction", async () => {
  await withEnv({ OPENCLAW_BUNDLE_URL: "https://example.test/openclaw.bundle.mjs" }, async () => {
    const h = createScenarioHarness();
    try {
      h.fakeFetch.onGet("asset-manifest.json", () => new Response("not found", { status: 404 }));
      const handle = await createHandle(h);

      await setupOpenClaw(handle, {
        gatewayToken: "tok-bundle-shims",
        proxyOrigin: "https://example.com",
      });

      const sharedChunks = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[1]?.includes("channel-shared-chunks.tar.gz"),
      );
      assert.ok(sharedChunks, "bundle command should fetch shared chunks");
      const script = sharedChunks.args?.[1] ?? "";
      assert.ok(
        script.includes("agents/model-catalog.runtime.js"),
        "shared chunks setup should create model-catalog compatibility shim",
      );
      assert.ok(
        script.includes("$ROOT/dist/agents/model-catalog.runtime.js"),
        "shared chunks setup should create dist model-catalog shim for dist/* imports",
      );
      assert.ok(
        script.includes("config/config.js"),
        "shared chunks setup should create config compatibility shim",
      );
      assert.ok(
        script.includes("$ROOT/dist/config/config.js"),
        "shared chunks setup should create dist config shim for dist/* imports",
      );
      assert.ok(
        script.includes("find \"$ROOT\" -maxdepth 1 -type f \\( -name '*.js' -o -name '*.cjs' \\) -exec cp -f {} \"$ROOT/dist/\" \\;"),
        "shared chunks setup should mirror root chunks into dist for channel relative imports",
      );
      assert.ok(
        script.includes("run-model-catalog.runtime.js"),
        "model-catalog shim should point to extracted root runtime",
      );
      assert.ok(
        script.includes("agents/auth-profiles.runtime.js"),
        "shared chunks setup should create auth-profiles compatibility shim",
      );
      assert.ok(
        script.includes("ensureAuthProfileStore"),
        "auth-profiles shim should select the auth chunk by export signature",
      );
      assert.ok(
        script.includes("agents/pi-model-discovery-runtime.js"),
        "shared chunks setup should create pi model discovery compatibility shim",
      );
      assert.ok(
        script.includes("discoverModels"),
        "pi model discovery shim should select the chunk by export signature",
      );
      assert.ok(
        script.includes("export const discoverModels") && script.includes("export const ModelRegistry") && script.includes("export const AuthStorage"),
        "pi model discovery shim should expose the non-minified discovery export name",
      );
      assert.ok(
        script.includes("agents/models-config.runtime.js"),
        "shared chunks setup should create models config runtime compatibility shim",
      );
      assert.ok(
        script.includes("n as ensureOpenClawModelsJson"),
        "models config shim should expose the non-minified ensure export name",
      );
      assert.ok(
        script.includes("agents/pi-bundle-mcp-runtime.js"),
        "shared chunks setup should create pi bundle MCP runtime compatibility shim",
      );
      assert.ok(
        script.includes("r as createSessionMcpRuntime"),
        "pi bundle MCP shim should expose the non-minified runtime factory export name",
      );
      assert.ok(
        script.includes("plugins/provider-discovery.runtime.js"),
        "shared chunks setup should create provider-discovery compatibility shim",
      );
      assert.ok(
        script.includes("$ROOT/dist/plugins/provider-discovery.runtime.js"),
        "shared chunks setup should create dist provider-discovery shim for dist/* imports",
      );
      assert.ok(
        script.includes("export * from '../provider-discovery.runtime.js';"),
        "provider-discovery shim should point to extracted root runtime",
      );
      assert.ok(
        script.includes("export { t as resolvePluginDiscoveryProvidersRuntime } from '../provider-discovery.runtime.js';"),
        "provider-discovery shim should expose the non-minified runtime export name",
      );
      assert.ok(
        script.includes("getRuntimeConfig as i"),
        "config shim should select the config IO chunk by export signature",
      );
      assert.ok(
        script.includes("replaceConfigFile as r"),
        "config shim should select the mutation chunk by export signature",
      );
      assert.ok(
        script.includes("CONFIG_PATH as t"),
        "config shim should select the gateway path chunk by export signature",
      );
    } finally {
      h.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// setupOpenClaw — written files
// ---------------------------------------------------------------------------

test("setupOpenClaw writes all required config files", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-files",
      proxyOrigin: "https://proxy.test",
    });

    const writtenPaths = handle.writtenFiles.map((f) => f.path);

    const expectedPaths = [
      OPENCLAW_CONFIG_PATH,
      OPENCLAW_GATEWAY_TOKEN_PATH,
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
      OPENCLAW_STARTUP_SCRIPT_PATH,
      OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      OPENCLAW_IMAGE_GEN_SKILL_PATH,
      OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
      OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
      OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
      OPENCLAW_WEB_SEARCH_SKILL_PATH,
      OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
      OPENCLAW_VISION_SKILL_PATH,
      OPENCLAW_VISION_SCRIPT_PATH,
      OPENCLAW_TTS_SKILL_PATH,
      OPENCLAW_TTS_SCRIPT_PATH,
      OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
      OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
      OPENCLAW_EMBEDDINGS_SKILL_PATH,
      OPENCLAW_EMBEDDINGS_SCRIPT_PATH,
      OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH,
      OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH,
      OPENCLAW_TRANSCRIPTION_SKILL_PATH,
      OPENCLAW_TRANSCRIPTION_SCRIPT_PATH,
      OPENCLAW_REASONING_SKILL_PATH,
      OPENCLAW_REASONING_SCRIPT_PATH,
      OPENCLAW_COMPARE_SKILL_PATH,
      OPENCLAW_COMPARE_SCRIPT_PATH,
      OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
      OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
    ];

    for (const p of expectedPaths) {
      assert.ok(writtenPaths.includes(p), `missing file: ${p}`);
    }
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes and runs the install patch script before version check", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-install-patch",
      proxyOrigin: "https://proxy.test",
    });

    const patchFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
    );
    assert.ok(patchFile, "install patch script should be written");
    assert.match(
      patchFile.content.toString("utf8"),
      /vercel-openclaw:qmd-warmup-delay/,
      "install patch script should include the qmd warmup delay marker",
    );

    const patchCmdIdx = handle.commands.findIndex(
      (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
    );
    const versionCmdIdx = handle.commands.findIndex(
      (c) => c.cmd === OPENCLAW_BIN && c.args?.[0] === "--version",
    );
    assert.ok(patchCmdIdx >= 0, "install patch command should run");
    assert.ok(versionCmdIdx > patchCmdIdx, "install patch should run before version check");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes gateway token content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "my-secret-token",
      proxyOrigin: "https://proxy.test",
    });

    const tokenFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH,
    );
    assert.ok(tokenFile, "gateway token file not written");
    assert.equal(tokenFile.content.toString(), "my-secret-token");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes placeholder AI gateway key (real credential via network policy)", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      apiKey: "test-key",
      proxyOrigin: "https://proxy.test",
    });

    const keyFile = handle.writtenFiles.find(
      (f) => f.path.endsWith(".ai-gateway-api-key"),
    );
    assert.ok(keyFile, "AI gateway key file should be written");
    assert.ok(
      keyFile!.content.toString().includes("placeholder"),
      "Should write placeholder, not real key",
    );
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes valid openclaw.json config", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://my-app.vercel.app",
    });

    const configFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_CONFIG_PATH,
    );
    assert.ok(configFile, "openclaw.json not written");

    const config = JSON.parse(configFile.content.toString());
    assert.equal(config.gateway.mode, "local");
    assert.equal(config.gateway.auth.mode, "token");
    assert.ok(
      config.gateway.controlUi.allowedOrigins.includes("https://my-app.vercel.app"),
      "proxyOrigin not in allowedOrigins",
    );
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw includes agents config in gateway config", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const configFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_CONFIG_PATH,
    );
    const config = JSON.parse(configFile!.content.toString());
    assert.ok(config.agents, "agents config should be present");
    assert.ok(config.models, "models config should be present");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw includes agents config without explicit API key", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const configFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_CONFIG_PATH,
    );
    const config = JSON.parse(configFile!.content.toString());
    assert.ok(config.agents, "agents config should always be present");
    assert.ok(config.models, "models config should always be present");
    assert.ok(config.tools, "tools config should always be present");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — returns startupScript
// ---------------------------------------------------------------------------

test("setupOpenClaw returns startupScript that bootstraps the gateway in shell", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    assert.ok(result.startupScript, "startupScript should be non-empty");
    assert.ok(
      result.startupScript.includes("openclaw") && result.startupScript.includes("gateway"),
      "startup script should launch the gateway via setsid",
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// waitForGatewayReady — retry and success
// ---------------------------------------------------------------------------

test("waitForGatewayReady retries until gateway responds with openclaw-app", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    let curlCallCount = 0;
    const responder: CommandResponder = (cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        curlCallCount += 1;
        if (curlCallCount < 3) {
          return { exitCode: 0, output: async () => "<html>loading...</html>" };
        }
        return {
          exitCode: 0,
          output: async () => '<div id="openclaw-app">ready</div>',
        };
      }
      return undefined;
    };
    handle.responders.push(responder);

    await waitForGatewayReady(handle, { delayMs: 0 });

    assert.equal(curlCallCount, 3, "should have probed 3 times before succeeding");
  } finally {
    h.teardown();
  }
});

test("waitForGatewayReady retries on curl exit code failure", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    let curlCallCount = 0;
    handle.responders.push((cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        curlCallCount += 1;
        if (curlCallCount < 2) {
          return { exitCode: 7, output: async () => "" };
        }
        return {
          exitCode: 0,
          output: async () => '<div id="openclaw-app">ready</div>',
        };
      }
      return undefined;
    });

    await waitForGatewayReady(handle, { delayMs: 0 });

    assert.equal(curlCallCount, 2, "should have retried after curl failure");
  } finally {
    h.teardown();
  }
});

test("waitForGatewayReady retries on thrown errors", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    let curlCallCount = 0;
    const origRunCommand = handle.runCommand.bind(handle);
    handle.runCommand = async (cmd: string, args?: string[]) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        curlCallCount += 1;
        if (curlCallCount === 1) {
          throw new Error("connection refused");
        }
      }
      return origRunCommand(cmd, args);
    };

    await waitForGatewayReady(handle, { delayMs: 0 });

    assert.ok(curlCallCount >= 2, "should have retried after thrown error");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// waitForGatewayReady — failure
// ---------------------------------------------------------------------------

test("waitForGatewayReady throws when gateway never becomes ready", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    // Always return "not ready"
    handle.responders.push((cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        return { exitCode: 0, output: async () => "<html>loading...</html>" };
      }
      return undefined;
    });

    await assert.rejects(
      () => waitForGatewayReady(handle, { maxAttempts: 5, delayMs: 0 }),
      { message: /Gateway never became ready/ },
    );

    const curlCalls = handle.commands.filter(
      (c) => c.cmd === "curl" && c.args?.some((a) => a.includes("localhost:3000")),
    );
    assert.equal(curlCalls.length, 5, "should have exhausted all 5 attempts");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — force-pair failure is non-fatal
// ---------------------------------------------------------------------------

test("setupOpenClaw succeeds even when force-pair throws", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd, args) => {
      if (cmd === "node" && args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH) {
        throw new Error("force-pair failed");
      }
      return undefined;
    });

    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    assert.ok(result.startupScript, "should still return startupScript");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — idempotency on re-run
// ---------------------------------------------------------------------------

test("setupOpenClaw can be called twice without error (idempotent)", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    const opts = {
      gatewayToken: "tok-idem",
      proxyOrigin: "https://proxy.test",
    };

    // First run
    const r1 = await setupOpenClaw(handle, opts);
    assert.ok(r1.startupScript);

    // Second run should succeed (overwrite files, re-run commands)
    const r2 = await setupOpenClaw(handle, opts);
    assert.ok(r2.startupScript);

    // Both runs should have written files
    const tokenFiles = handle.writtenFiles.filter(
      (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH,
    );
    assert.ok(tokenFiles.length >= 2, "Token file should be written on each run");

    // All written token files should have the same content
    for (const tf of tokenFiles) {
      assert.equal(tf.content.toString(), "tok-idem");
    }
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw re-run with different token updates the file", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-first",
      proxyOrigin: "https://proxy.test",
    });

    await setupOpenClaw(handle, {
      gatewayToken: "tok-second",
      proxyOrigin: "https://proxy.test",
    });

    // Last written token should be the second value
    const tokenFiles = handle.writtenFiles.filter(
      (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH,
    );
    const lastToken = tokenFiles[tokenFiles.length - 1];
    assert.equal(lastToken.content.toString(), "tok-second");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — actionable error messages on each failure point
// ---------------------------------------------------------------------------

test("setupOpenClaw throws when npm install fails", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd) => {
      if (cmd === "npm") {
        throw new Error("npm install failed: ECONNREFUSED");
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("npm") || err.message.includes("ECONNREFUSED"),
          `Error should reference npm failure, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw throws when version check fails", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd) => {
      if (cmd === OPENCLAW_BIN) {
        throw new Error("openclaw binary not found");
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("openclaw") || err.message.includes("not found"),
          `Error should reference openclaw failure, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw throws when startup script fails", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd, args) => {
      if (cmd === "bash" && args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH) {
        throw new Error("startup script failed: permission denied");
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("startup") || err.message.includes("permission"),
          `Error should reference startup failure, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

test("waitForGatewayReady throws actionable error when gateway never becomes ready (via setupOpenClaw path)", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    // Gateway probe always returns "not ready"
    handle.responders.push((cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        return { exitCode: 0, output: async () => "<html>loading...</html>" };
      }
      return undefined;
    });

    // Test directly with small maxAttempts to avoid 60s timeout
    await assert.rejects(
      () => waitForGatewayReady(handle, { maxAttempts: 3, delayMs: 0 }),
      (err: Error) => {
        assert.ok(
          err.message.includes("Gateway never became ready"),
          `Error should say gateway not ready, got: ${err.message}`,
        );
        assert.ok(
          err.message.includes("3"),
          `Error should include attempt count, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: gateway health check timeout with connection refused
// ---------------------------------------------------------------------------

test("waitForGatewayReady issues exactly maxAttempts curl commands on connection refused", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    let curlCallCount = 0;
    handle.responders.push((cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        curlCallCount += 1;
        return { exitCode: 7, output: async () => "" };
      }
      return undefined;
    });

    await assert.rejects(
      () => waitForGatewayReady(handle, { maxAttempts: 3, delayMs: 0 }),
      (err: Error) => {
        assert.equal(
          err.message,
          "Gateway never became ready within 3 attempts.",
          "error message should include exact attempt count",
        );
        return true;
      },
    );

    assert.equal(curlCallCount, 3, "should have issued exactly 3 curl commands");
  } finally {
    h.teardown();
  }
});

test("waitForGatewayReady logs openclaw.gateway_wait_exhausted with diagnostic fields", async () => {
  const { _resetLogBuffer, getServerLogs } = await import("@/server/log");
  const h = createScenarioHarness();
  try {
    _resetLogBuffer();
    const handle = await createHandle(h);

    handle.responders.push((cmd, args) => {
      if (cmd === "curl" && args?.some((a) => a.includes("localhost:3000"))) {
        return { exitCode: 7, output: async () => "" };
      }
      return undefined;
    });

    await assert.rejects(
      () => waitForGatewayReady(handle, { maxAttempts: 2, delayMs: 0 }),
      /Gateway never became ready/,
    );

    const exhausted = getServerLogs().filter(
      (e) => e.message === "openclaw.gateway_wait_exhausted",
    );
    assert.equal(exhausted.length, 1, "expected single exhaustion error log");
    const data = exhausted[0]!.data as Record<string, unknown>;
    assert.equal(data.sandboxId, handle.sandboxId);
    assert.equal(data.maxAttempts, 2);
    assert.ok(typeof data.httpProbe === "string");
    assert.ok(typeof data.openclawLogs === "string");
    assert.ok(typeof data.portsAndProcesses === "string");
    assert.ok(data.lastProbe && typeof data.lastProbe === "object");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: writeFiles failure then retry recovery
// ---------------------------------------------------------------------------

test("setupOpenClaw can be re-run after writeFiles failure", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    let writeCallCount = 0;
    const origWriteFiles = handle.writeFiles.bind(handle);
    handle.writeFiles = async (files: { path: string; content: Buffer }[]) => {
      writeCallCount += 1;
      if (writeCallCount === 1) {
        throw new Error("disk full");
      }
      return origWriteFiles(files);
    };

    // First call should throw due to writeFiles failure
    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok-retry",
          proxyOrigin: "https://proxy.test",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("disk full"),
          `Expected disk full error, got: ${err.message}`,
        );
        return true;
      },
    );

    // Second call should succeed — writeFiles works now
    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok-retry",
      proxyOrigin: "https://proxy.test",
    });

    assert.ok(result.startupScript, "should return startupScript on retry");

    // Verify files were written on the second call
    const tokenFiles = handle.writtenFiles.filter(
      (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH,
    );
    assert.ok(tokenFiles.length >= 1, "token file should be written on second call");
    assert.equal(tokenFiles[tokenFiles.length - 1].content.toString(), "tok-retry");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: npm install non-zero exit code throws CommandFailedError
// ---------------------------------------------------------------------------

test("setupOpenClaw throws CommandFailedError on npm install non-zero exit code", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd) => {
      if (cmd === "npm") {
        return {
          exitCode: 1,
          output: async () => "EACCES: permission denied",
        };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandFailedError, `Expected CommandFailedError, got ${(err as Error).name}`);
        assert.equal(err.command, "npm install");
        assert.equal(err.exitCode, 1);
        assert.ok(err.trimmedOutput.includes("EACCES"));
        // Verify toJSON produces structured data
        const json = err.toJSON();
        assert.equal(json.command, "npm install");
        assert.equal(json.exitCode, 1);
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: install patch non-zero exit code throws CommandFailedError
// ---------------------------------------------------------------------------

test("setupOpenClaw throws CommandFailedError when install patching fails", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd, args) => {
      if (cmd === "node" && args?.[0] === OPENCLAW_INSTALL_PATCH_SCRIPT_PATH) {
        return {
          exitCode: 1,
          output: async () => "target-not-found",
        };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandFailedError, `Expected CommandFailedError, got ${(err as Error).name}`);
        assert.equal(err.command, "openclaw install patch");
        assert.equal(err.exitCode, 1);
        assert.ok(err.trimmedOutput.includes("target-not-found"));
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: startup script non-zero exit code throws CommandFailedError
// ---------------------------------------------------------------------------

test("setupOpenClaw throws CommandFailedError on startup script non-zero exit code", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd, args) => {
      if (cmd === "bash" && args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH) {
        return {
          exitCode: 127,
          output: async () => "bash: openclaw: command not found",
        };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandFailedError, `Expected CommandFailedError, got ${(err as Error).name}`);
        assert.equal(err.command, "bash startup-script");
        assert.equal(err.exitCode, 127);
        assert.ok(err.trimmedOutput.includes("command not found"));
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Failure-path: version check non-zero exit code throws CommandFailedError
// ---------------------------------------------------------------------------

test("setupOpenClaw throws CommandFailedError on openclaw --version non-zero exit code", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    handle.responders.push((cmd) => {
      if (cmd === OPENCLAW_BIN) {
        return {
          exitCode: 1,
          output: async () => "openclaw: error loading binary",
        };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        setupOpenClaw(handle, {
          gatewayToken: "tok",
          proxyOrigin: "https://proxy.test",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandFailedError, `Expected CommandFailedError, got ${(err as Error).name}`);
        assert.equal(err.command, "openclaw --version");
        assert.equal(err.exitCode, 1);
        assert.ok(err.trimmedOutput.includes("error loading binary"));
        return true;
      },
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — runtime info in return value
// ---------------------------------------------------------------------------

test("setupOpenClaw returns runtime with packageSpec and installedVersion", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    assert.ok(result.runtime, "runtime should be present");
    const defaultSpec = getOpenclawPackageSpec();
    assert.equal(result.runtime.packageSpec, defaultSpec);
    // Default harness returns "openclaw 0.0.0-test" for --version
    // When the default spec is pinned, drift is detected because installed != pinned version
    assert.equal(typeof result.runtime.drift, "boolean");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw uses OPENCLAW_PACKAGE_SPEC when set", async () => {
  const h = createScenarioHarness();
  const original = process.env.OPENCLAW_PACKAGE_SPEC;
  try {
    process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@2.0.0";
    const handle = await createHandle(h);

    handle.responders.push((cmd) => {
      if (cmd === OPENCLAW_BIN) {
        return { exitCode: 0, output: async () => "2.0.0" };
      }
      return undefined;
    });

    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    // npm install should use the pinned spec
    assert.deepEqual(handle.commands[0].args, [
      "install", "-g", "openclaw@2.0.0", "--ignore-scripts", "--loglevel", "info",
    ]);

    assert.equal(result.runtime.packageSpec, "openclaw@2.0.0");
    assert.equal(result.runtime.installedVersion, "2.0.0");
    assert.equal(result.runtime.drift, false, "pinned version should not drift");
  } finally {
    if (original === undefined) {
      delete process.env.OPENCLAW_PACKAGE_SPEC;
    } else {
      process.env.OPENCLAW_PACKAGE_SPEC = original;
    }
    h.teardown();
  }
});

test("setupOpenClaw warns but proceeds with unpinned OPENCLAW_PACKAGE_SPEC on Vercel", async () => {
  const h = createScenarioHarness();
  const origSpec = process.env.OPENCLAW_PACKAGE_SPEC;
  const origVercel = process.env.VERCEL;
  try {
    delete process.env.OPENCLAW_PACKAGE_SPEC;
    process.env.VERCEL = "1";
    const handle = await createHandle(h);

    // Unpinned specs now warn instead of rejecting
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    // Install should still run with the fallback spec
    const installCmd = handle.commands.find(
      (c) => c.cmd === "npm" && c.args?.includes("install"),
    );
    assert.ok(installCmd, "npm install should still run with fallback spec");
  } finally {
    if (origSpec === undefined) {
      delete process.env.OPENCLAW_PACKAGE_SPEC;
    } else {
      process.env.OPENCLAW_PACKAGE_SPEC = origSpec;
    }
    if (origVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = origVercel;
    }
    h.teardown();
  }
});

test("setupOpenClaw accepts openclaw@latest on Vercel", async () => {
  const h = createScenarioHarness();
  const origSpec = process.env.OPENCLAW_PACKAGE_SPEC;
  const origVercel = process.env.VERCEL;
  try {
    process.env.OPENCLAW_PACKAGE_SPEC = "openclaw@latest";
    process.env.VERCEL = "1";
    const handle = await createHandle(h);

    // openclaw@latest is allowed — it should not reject
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    // Verify the install command used the spec
    const installCmd = handle.commands.find(
      (c) => c.cmd === "npm" && c.args?.some((a) => a === "openclaw@latest"),
    );
    assert.ok(installCmd, "Expected npm install command with openclaw@latest");
  } finally {
    if (origSpec === undefined) {
      delete process.env.OPENCLAW_PACKAGE_SPEC;
    } else {
      process.env.OPENCLAW_PACKAGE_SPEC = origSpec;
    }
    if (origVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = origVercel;
    }
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// detectDrift — unit tests
// ---------------------------------------------------------------------------

test("detectDrift returns false for exact pinned match", () => {
  assert.equal(detectDrift("openclaw@1.2.3", "1.2.3"), false);
});

test("detectDrift returns true for version mismatch", () => {
  assert.equal(detectDrift("openclaw@1.2.3", "1.2.4"), true);
});

test("detectDrift returns true for latest tag", () => {
  assert.equal(detectDrift("openclaw@latest", "1.2.3"), true);
});

test("detectDrift returns true for range spec", () => {
  assert.equal(detectDrift("openclaw@^1.0.0", "1.2.3"), true);
  assert.equal(detectDrift("openclaw@~1.0.0", "1.0.5"), true);
  assert.equal(detectDrift("openclaw@>=1.0.0", "1.2.3"), true);
});

test("detectDrift returns true when installedVersion is null", () => {
  assert.equal(detectDrift("openclaw@1.2.3", null), true);
});

// ---------------------------------------------------------------------------
// setupOpenClaw — npm cache cleanup
// ---------------------------------------------------------------------------

test("setupOpenClaw runs npm cache cleanup for all known cache directories", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const npmCacheCleanupCmd = handle.commands.find(
      (c) =>
        c.cmd === "bash"
        && c.args?.[0] === "-lc"
        && c.args?.[1]?.includes("/tmp/openclaw-npm-cache"),
    );

    assert.ok(npmCacheCleanupCmd, "npm cache cleanup command not run");
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("/home/vercel-sandbox/.npm"),
      "cleanup command should remove /home/vercel-sandbox/.npm",
    );
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("/root/.npm"),
      "cleanup command should remove /root/.npm",
    );
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("/tmp/openclaw-npm-cache"),
      "cleanup command should remove /tmp/openclaw-npm-cache",
    );
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("rm -rf /home/vercel-sandbox/.npm || true"),
      "cleanup command should ignore /home/vercel-sandbox/.npm removal failures",
    );
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("rm -rf /root/.npm || true"),
      "cleanup command should ignore /root/.npm removal failures",
    );
    assert.ok(
      npmCacheCleanupCmd.args?.[1]?.includes("rm -rf /tmp/openclaw-npm-cache || true"),
      "cleanup command should ignore /tmp/openclaw-npm-cache removal failures",
    );
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — new skill file contents
// ---------------------------------------------------------------------------

test("setupOpenClaw writes web-search skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_WEB_SEARCH_SKILL_PATH);
    assert.ok(skill, "web-search skill file not written");
    assert.ok(skill.content.toString().includes("name: web-search"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_WEB_SEARCH_SCRIPT_PATH);
    assert.ok(script, "web-search script file not written");
    assert.ok(script.content.toString().includes("web_search"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes vision skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_VISION_SKILL_PATH);
    assert.ok(skill, "vision skill file not written");
    assert.ok(skill.content.toString().includes("name: vision"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_VISION_SCRIPT_PATH);
    assert.ok(script, "vision script file not written");
    assert.ok(script.content.toString().includes("Describe this image in detail."));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes tts skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_TTS_SKILL_PATH);
    assert.ok(skill, "tts skill file not written");
    assert.ok(skill.content.toString().includes("name: tts"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_TTS_SCRIPT_PATH);
    assert.ok(script, "tts script file not written");
    assert.ok(script.content.toString().includes("MEDIA:"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes structured-extract skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH);
    assert.ok(skill, "structured-extract skill file not written");
    assert.ok(skill.content.toString().includes("name: structured-extract"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH);
    assert.ok(script, "structured-extract script file not written");
    assert.ok(script.content.toString().includes("json_schema"));
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — WhatsApp plugin install
// ---------------------------------------------------------------------------

test("setupOpenClaw installs whatsapp plugin when enabled", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-wa",
      proxyOrigin: "https://proxy.test",
      whatsappConfig: { enabled: true, dmPolicy: "pairing" },
    });

    const pluginCmd = handle.commands.find(
      (c) => c.cmd === OPENCLAW_BIN && c.args?.[0] === "plugins" && c.args?.[1] === "install",
    );
    assert.ok(pluginCmd, "expected openclaw plugins install command");
    assert.equal(pluginCmd.args?.[2], "@openclaw/whatsapp");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw uses configured whatsapp plugin spec when provided", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-wa-custom",
      proxyOrigin: "https://proxy.test",
      whatsappConfig: {
        enabled: true,
        pluginSpec: "/workspace/plugins/whatsapp",
        dmPolicy: "pairing",
      },
    });

    const pluginCmd = handle.commands.find(
      (c) => c.cmd === OPENCLAW_BIN && c.args?.[0] === "plugins" && c.args?.[1] === "install",
    );
    assert.ok(pluginCmd, "expected openclaw plugins install command");
    assert.equal(pluginCmd.args?.[2], "/workspace/plugins/whatsapp");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw skips whatsapp plugin install when not enabled", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-no-wa",
      proxyOrigin: "https://proxy.test",
    });

    const pluginCmd = handle.commands.find(
      (c) => c.cmd === OPENCLAW_BIN && c.args?.[0] === "plugins",
    );
    assert.equal(pluginCmd, undefined, "should not install plugins when whatsapp not enabled");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw includes whatsapp config in openclaw.json when enabled", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-wa-cfg",
      proxyOrigin: "https://proxy.test",
      whatsappConfig: { enabled: true, dmPolicy: "open", allowFrom: ["*"] },
    });

    const configFile = handle.writtenFiles.find((f) => f.path === OPENCLAW_CONFIG_PATH);
    assert.ok(configFile, "openclaw config should be written");

    const config = JSON.parse(configFile.content.toString("utf8")) as {
      channels?: { whatsapp?: { enabled?: boolean; dmPolicy?: string } };
    };
    assert.equal(config.channels?.whatsapp?.enabled, true);
    assert.equal(config.channels?.whatsapp?.dmPolicy, "open");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw plugin install is idempotent — does not fail on repeat", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    const whatsappConfig = { enabled: true as const, dmPolicy: "pairing" as const };

    // First call
    await setupOpenClaw(handle, {
      gatewayToken: "tok-idem",
      proxyOrigin: "https://proxy.test",
      whatsappConfig,
    });

    // Reset command history to simulate a second invocation
    const handle2 = await createHandle(h);

    await setupOpenClaw(handle2, {
      gatewayToken: "tok-idem",
      proxyOrigin: "https://proxy.test",
      whatsappConfig,
    });

    const pluginCmds = handle2.commands.filter(
      (c) => c.cmd === OPENCLAW_BIN && c.args?.[0] === "plugins",
    );
    assert.equal(pluginCmds.length, 1, "plugin install should run exactly once per setup call");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes embeddings skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_EMBEDDINGS_SKILL_PATH);
    assert.ok(skill, "embeddings skill file not written");
    assert.ok(skill.content.toString().includes("name: embeddings"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_EMBEDDINGS_SCRIPT_PATH);
    assert.ok(script, "embeddings script file not written");
    assert.ok(script.content.toString().includes("/v1/embeddings"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes semantic-search skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH);
    assert.ok(skill, "semantic-search skill file not written");
    assert.ok(skill.content.toString().includes("name: semantic-search"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH);
    assert.ok(script, "semantic-search script file not written");
    assert.ok(script.content.toString().includes("cosineSimilarity"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes transcription skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_TRANSCRIPTION_SKILL_PATH);
    assert.ok(skill, "transcription skill file not written");
    assert.ok(skill.content.toString().includes("name: transcription"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_TRANSCRIPTION_SCRIPT_PATH);
    assert.ok(script, "transcription script file not written");
    assert.ok(script.content.toString().includes("/v1/audio/transcriptions"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes reasoning skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_REASONING_SKILL_PATH);
    assert.ok(skill, "reasoning skill file not written");
    assert.ok(skill.content.toString().includes("name: reasoning"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_REASONING_SCRIPT_PATH);
    assert.ok(script, "reasoning script file not written");
    assert.ok(script.content.toString().includes("/v1/chat/completions"));
    assert.ok(script.content.toString().includes("reasoning"));
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes compare-models skill and script with expected content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);
    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const skill = handle.writtenFiles.find((f) => f.path === OPENCLAW_COMPARE_SKILL_PATH);
    assert.ok(skill, "compare skill file not written");
    assert.ok(skill.content.toString().includes("name: compare-models"));

    const script = handle.writtenFiles.find((f) => f.path === OPENCLAW_COMPARE_SCRIPT_PATH);
    assert.ok(script, "compare script file not written");
    assert.ok(script.content.toString().includes("/v1/chat/completions"));
    assert.ok(script.content.toString().includes("Promise.all"));
  } finally {
    h.teardown();
  }
});
