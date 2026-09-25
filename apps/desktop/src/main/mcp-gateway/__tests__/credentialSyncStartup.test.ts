import assert from "node:assert/strict";
import test from "node:test";

import { reconcileCredentialBackupAtStartup } from "../CredentialSyncStartup.ts";

const NOT_SYNCING = {
  restore: { restored: 0, projects: [], reason: "not-syncing" as const },
  push: { pushed: false, entryCount: 0, reason: "not-syncing" as const },
};

const DISABLED = {
  restore: { restored: 0, projects: [], reason: "no-passphrase" as const },
  push: { pushed: false, entryCount: 0, reason: "disabled" as const },
};

test("startup credential sync retries after Cloud Sync becomes ready", async () => {
  const calls: string[] = [];
  let reconciles = 0;
  const result = await reconcileCredentialBackupAtStartup({
    credentials: {
      reconcile: async () => {
        calls.push("reconcile");
        reconciles += 1;
        return reconciles === 1
          ? NOT_SYNCING
          : {
              restore: { restored: 1, projects: ["project-a"] },
              push: { pushed: false, entryCount: 1, reason: "unchanged" as const },
            };
      },
    },
    cloud: {
      autoBootstrap: async () => {
        calls.push("bootstrap");
      },
    },
    gateway: {
      composeSyncIfReady: async () => {
        calls.push("compose");
        return true;
      },
      syncNow: async () => {
        calls.push("sync");
      },
    },
    logger: { info: () => undefined, error: () => undefined },
  });

  assert.ok(result.retry);
  await result.retry;
  assert.deepEqual(calls, ["reconcile", "bootstrap", "compose", "sync", "reconcile"]);
});

test("startup credential sync does not bootstrap when no retry is needed", async () => {
  let cloudCalls = 0;
  const result = await reconcileCredentialBackupAtStartup({
    credentials: { reconcile: async () => DISABLED },
    cloud: {
      autoBootstrap: async () => {
        cloudCalls += 1;
      },
    },
    gateway: {
      composeSyncIfReady: async () => true,
      syncNow: async () => undefined,
    },
    logger: { info: () => undefined, error: () => undefined },
  });

  assert.equal(result.retry, null);
  assert.equal(cloudCalls, 0);
});
