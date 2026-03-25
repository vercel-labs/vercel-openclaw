import assert from "node:assert/strict";
import test from "node:test";

import { getConfiguredAdminSecret, _resetAdminSecretCacheForTesting } from "@/server/auth/admin-secret";
import { _setInstanceIdOverrideForTesting } from "@/server/env";
import { _resetStoreForTesting } from "@/server/store/store";

test("getConfiguredAdminSecret scopes generated cache by admin secret key when instance id changes", async () => {
  const originalAdminSecret = process.env.ADMIN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInstanceId = process.env.OPENCLAW_INSTANCE_ID;

  delete process.env.ADMIN_SECRET;
  process.env.NODE_ENV = "test";
  delete process.env.OPENCLAW_INSTANCE_ID;
  _setInstanceIdOverrideForTesting(null);
  _resetStoreForTesting();
  _resetAdminSecretCacheForTesting();

  try {
    _setInstanceIdOverrideForTesting("fork-a");
    const forkASecret = await getConfiguredAdminSecret();
    assert.deepEqual(forkASecret?.source, "generated");
    assert.ok(forkASecret?.secret);

    _setInstanceIdOverrideForTesting("fork-b");
    const forkBSecret = await getConfiguredAdminSecret();
    assert.deepEqual(forkBSecret?.source, "generated");
    assert.ok(forkBSecret?.secret);
    assert.notEqual(
      forkBSecret?.secret,
      forkASecret?.secret,
      "instance-specific keys must not reuse a cached secret from another instance",
    );

    _setInstanceIdOverrideForTesting("fork-a");
    const forkASecretReloaded = await getConfiguredAdminSecret();
    assert.deepEqual(forkASecretReloaded?.source, "generated");
    assert.equal(
      forkASecretReloaded?.secret,
      forkASecret?.secret,
      "reloading the original instance should return the secret stored under that key",
    );
  } finally {
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET;
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalInstanceId === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = originalInstanceId;
    }

    _setInstanceIdOverrideForTesting(null);
    _resetStoreForTesting();
    _resetAdminSecretCacheForTesting();
  }
});
