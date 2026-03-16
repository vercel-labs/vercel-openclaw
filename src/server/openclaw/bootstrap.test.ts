import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCLAW_AI_GATEWAY_API_KEY_PATH,
  OPENCLAW_BIN,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";
import { setupOpenClaw, waitForGatewayReady, detectDrift, CommandFailedError } from "@/server/openclaw/bootstrap";
import {
  createScenarioHarness,
  type CommandResponder,
} from "@/test-utils/harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a sandbox handle seeded in the fake controller. */
async function createHandle(h: ReturnType<typeof createScenarioHarness>) {
  await h.controller.create({ ports: [3000] });
  return h.controller.lastCreated()!;
}

// ---------------------------------------------------------------------------
// setupOpenClaw — command sequence
// ---------------------------------------------------------------------------

test("setupOpenClaw executes commands in correct order", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok-test",
      apiKey: "ak-test",
      proxyOrigin: "https://example.com",
    });

    const cmds = handle.commands.map((c) => c.cmd);

    // npm install → (writeFiles) → openclaw --version → bash startup →
    // curl (gateway probe) → node (force-pair)
    assert.equal(cmds[0], "npm", "first command should be npm install");
    assert.equal(cmds[1], OPENCLAW_BIN, "second command should be version check");
    assert.equal(cmds[2], "bash", "third command should be startup script");
    assert.equal(cmds[3], "curl", "fourth command should be gateway probe");
    assert.equal(cmds[4], "node", "fifth command should be force-pair");

    // Verify npm install uses the resolved package spec (openclaw@latest in non-Vercel env)
    assert.deepEqual(handle.commands[0].args, [
      "install", "-g", "openclaw@latest", "--ignore-scripts",
    ]);

    // Verify version check args
    assert.deepEqual(handle.commands[1].args, ["--version"]);

    // Verify startup script invocation
    assert.deepEqual(handle.commands[2].args, [OPENCLAW_STARTUP_SCRIPT_PATH]);

    // Verify force-pair invocation
    assert.deepEqual(handle.commands[4].args, [
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STATE_DIR,
    ]);
  } finally {
    h.teardown();
  }
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
      apiKey: "ak-files",
      proxyOrigin: "https://proxy.test",
    });

    const writtenPaths = handle.writtenFiles.map((f) => f.path);

    const expectedPaths = [
      OPENCLAW_CONFIG_PATH,
      OPENCLAW_GATEWAY_TOKEN_PATH,
      OPENCLAW_AI_GATEWAY_API_KEY_PATH,
      OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      OPENCLAW_STARTUP_SCRIPT_PATH,
      OPENCLAW_IMAGE_GEN_SKILL_PATH,
      OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
      OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
      OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
    ];

    for (const p of expectedPaths) {
      assert.ok(writtenPaths.includes(p), `missing file: ${p}`);
    }
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

test("setupOpenClaw writes AI gateway key content", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      apiKey: "my-ai-key",
      proxyOrigin: "https://proxy.test",
    });

    const keyFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_AI_GATEWAY_API_KEY_PATH,
    );
    assert.ok(keyFile, "AI gateway key file not written");
    assert.equal(keyFile.content.toString(), "my-ai-key");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw writes empty AI gateway key when apiKey is omitted", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    const keyFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_AI_GATEWAY_API_KEY_PATH,
    );
    assert.ok(keyFile, "AI gateway key file not written");
    assert.equal(keyFile.content.toString(), "");
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
      apiKey: "ak",
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

test("setupOpenClaw includes agents config when apiKey is provided", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    await setupOpenClaw(handle, {
      gatewayToken: "tok",
      apiKey: "ak",
      proxyOrigin: "https://proxy.test",
    });

    const configFile = handle.writtenFiles.find(
      (f) => f.path === OPENCLAW_CONFIG_PATH,
    );
    const config = JSON.parse(configFile!.content.toString());
    assert.ok(config.agents, "agents config should be present when apiKey is set");
    assert.ok(config.models, "models config should be present when apiKey is set");
  } finally {
    h.teardown();
  }
});

test("setupOpenClaw omits agents config when apiKey is not provided", async () => {
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
    assert.equal(config.agents, undefined, "agents config should be absent without apiKey");
    assert.equal(config.models, undefined, "models config should be absent without apiKey");
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// setupOpenClaw — returns startupScript
// ---------------------------------------------------------------------------

test("setupOpenClaw returns startupScript", async () => {
  const h = createScenarioHarness();
  try {
    const handle = await createHandle(h);

    const result = await setupOpenClaw(handle, {
      gatewayToken: "tok",
      proxyOrigin: "https://proxy.test",
    });

    assert.ok(result.startupScript, "startupScript should be non-empty");
    assert.ok(
      result.startupScript.includes("openclaw gateway"),
      "startup script should launch the gateway",
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
      apiKey: "ak-idem",
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
    assert.equal(result.runtime.packageSpec, "openclaw@latest");
    // Default harness returns empty string for --version, normalized to null
    assert.equal(result.runtime.installedVersion, null);
    // "latest" is always drifty
    assert.equal(result.runtime.drift, true);
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
      "install", "-g", "openclaw@2.0.0", "--ignore-scripts",
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

test("setupOpenClaw throws when OPENCLAW_PACKAGE_SPEC is missing on Vercel", async () => {
  const h = createScenarioHarness();
  const origSpec = process.env.OPENCLAW_PACKAGE_SPEC;
  const origVercel = process.env.VERCEL;
  try {
    delete process.env.OPENCLAW_PACKAGE_SPEC;
    process.env.VERCEL = "1";
    const handle = await createHandle(h);

    await assert.rejects(
      () => setupOpenClaw(handle, {
        gatewayToken: "tok",
        proxyOrigin: "https://proxy.test",
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("OPENCLAW_PACKAGE_SPEC"),
          `Error should reference OPENCLAW_PACKAGE_SPEC, got: ${err.message}`,
        );
        return true;
      },
    );
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
