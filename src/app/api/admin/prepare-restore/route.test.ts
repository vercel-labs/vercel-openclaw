/**
 * Focused route-level tests for GET /api/admin/prepare-restore.
 *
 * Validates that the authoritative restore-readiness contract returns
 * an executable destructive prepare action when the restore target is dirty.
 *
 * Run: node --import tsx --test src/app/api/admin/prepare-restore/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildRestoreAssetManifest, OPENCLAW_RESTORE_ASSET_MANIFEST_PATH } from "@/server/openclaw/restore-assets";
import { computeGatewayConfigHash } from "@/server/openclaw/config";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildGetRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import type { NetworkPolicy } from "@vercel/sandbox";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const routeModule = require("@/app/api/admin/prepare-restore/route") as {
  GET: (request: Request) => Promise<Response>;
};

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
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
  process.env.ADMIN_SECRET = "test-admin-secret";
  process.env.SESSION_SECRET = "test-session-secret";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    resetAfterCallbacks();
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

function authGet(path: string): Request {
  return buildGetRequest(path, {
    authorization: "Bearer test-admin-secret",
    origin: "http://localhost:3000",
    host: "localhost:3000",
    "x-requested-with": "XMLHttpRequest",
  });
}

function installFakeController(): void {
  const restoreAssetManifest = Buffer.from(
    `${JSON.stringify(buildRestoreAssetManifest())}\n`,
  );

  const fake: SandboxController = {
    async create() {
      return makeFakeHandle("sbx-test", restoreAssetManifest);
    },
    async get(opts: { sandboxId: string }) {
      return makeFakeHandle(opts.sandboxId, restoreAssetManifest);
    },
  };

  _setSandboxControllerForTesting(fake);
}

function makeFakeHandle(sandboxId: string, restoreAssetManifest: Buffer): SandboxHandle {
  return {
    sandboxId,
    get timeout() { return 1800000; },
    get status() { return "running" as const; },
    async runCommand() {
      return { exitCode: 0, output: async () => "" };
    },
    async writeFiles() {},
    domain() {
      return `https://${sandboxId}-3000.fake.vercel.run`;
    },
    async snapshot() {
      return { snapshotId: `snap-${sandboxId}` };
    },
    async extendTimeout() {},
    async updateNetworkPolicy(policy: NetworkPolicy) {
      return policy;
    },
    async readFileToBuffer(file) {
      if (file.path === OPENCLAW_RESTORE_ASSET_MANIFEST_PATH) {
        return restoreAssetManifest;
      }
      return null;
    },
    async stop() {},
  } satisfies SandboxHandle;
}

// ===========================================================================
// GET /api/admin/prepare-restore — dirty target returns executable plan
// ===========================================================================

test("GET /api/admin/prepare-restore: dirty target returns executable destructive prepare action", async () => {
  await withTestEnv(async () => {
    installFakeController();
    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-dirty-target";
      m.sandboxId = null;
      m.restorePreparedStatus = "dirty";
      m.restorePreparedReason = "dynamic-config-changed";
    });

    const result = await callRoute(routeModule.GET, authGet("/api/admin/prepare-restore"));

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      attestation: {
        reusable: boolean;
        needsPrepare: boolean;
        reasons: string[];
      };
      preview: { ok: boolean };
      plan: {
        schemaVersion: number;
        status: string;
        blocking: boolean;
        actions: Array<{
          id: string;
          priority: string;
          request: { method: string; path: string; body: unknown };
        }>;
      };
      decision: {
        schemaVersion: number;
        reusable: boolean;
        reasons: string[];
        requiredActions: string[];
        nextAction: string | null;
      };
    };

    // Dirty target is not ok
    assert.equal(body.ok, false);
    assert.equal(body.attestation.reusable, false);
    assert.equal(body.attestation.needsPrepare, true);

    // Plan includes executable destructive prepare action
    assert.equal(body.plan.status, "needs-prepare");
    assert.equal(body.plan.blocking, true);

    const prepareAction = body.plan.actions.find((a) => a.id === "prepare-destructive");
    assert.ok(prepareAction, "Plan must include prepare-destructive action");
    assert.equal(prepareAction.priority, "required");
    assert.equal(prepareAction.request.method, "POST");
    assert.equal(prepareAction.request.path, "/api/admin/prepare-restore");
    assert.deepEqual(prepareAction.request.body, { destructive: true });

    // Decision kernel invariants
    assert.equal(body.ok, body.attestation.reusable);
    assert.equal(body.preview.ok, body.attestation.reusable);
    assert.equal(body.decision.reusable, body.attestation.reusable);
  });
});

// ===========================================================================
// GET /api/admin/prepare-restore — reusable target returns ready plan
// ===========================================================================

test("GET /api/admin/prepare-restore: reusable target returns ready plan with no actions", async () => {
  await withTestEnv(async () => {
    installFakeController();

    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await mutateMeta((m) => {
      m.status = "stopped";
      m.snapshotId = "snap-sealed";
      m.sandboxId = null;
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
      m.restorePreparedAt = Date.now();
      m.snapshotDynamicConfigHash = desiredConfigHash;
      m.runtimeDynamicConfigHash = desiredConfigHash;
      m.snapshotAssetSha256 = desiredAssetSha256;
      m.runtimeAssetSha256 = desiredAssetSha256;
    });

    const result = await callRoute(routeModule.GET, authGet("/api/admin/prepare-restore"));

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      attestation: { reusable: boolean; reasons: string[] };
      plan: { status: string; actions: unknown[] };
      decision: { reusable: boolean; reasons: string[]; requiredActions: string[] };
    };

    assert.equal(body.ok, true);
    assert.equal(body.attestation.reusable, true);
    assert.deepEqual(body.attestation.reasons, []);
    assert.equal(body.plan.status, "ready");
    assert.equal(body.plan.actions.length, 0);

    // Decision kernel invariants
    assert.equal(body.decision.reusable, body.attestation.reusable);
    assert.deepEqual(body.decision.requiredActions, []);
  });
});
