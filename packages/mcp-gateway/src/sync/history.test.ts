import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";

import { InMemoryVault, type SigningKey } from "../vault.js";
import {
  signArchiveStamp,
  signTrustRegistry,
  verifyArchiveStamp,
  VerificationError,
  type TrustEntry,
  type TrustRegistry,
} from "../trust.js";
import { CONFIG_VERSION, parseProjectConfig, type ProjectConfig } from "../projectConfig.js";
import { generateSaltHex } from "./crypto.js";
import { parseProjectRevisionKey, projectRevisionKey, projectRevisionsPrefix } from "./keys.js";
import {
  DEFAULT_HISTORY_LIMIT,
  ProjectSyncCoordinator,
  selectRevisionAt,
  type HistoryEntry,
} from "./syncCoordinator.js";
import type { SyncObjectStore } from "./objectStore.js";

/**
 * Point-in-time history: what was this project on Tuesday, and can I go back.
 *
 * The archive was already being written; what these tests pin is that it can be
 * READ back safely — that a timestamp is only believed when it is signed, that a
 * deletion is part of the timeline, and that retention actually deletes.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

function config(id: string, label: string): ProjectConfig {
  return parseProjectConfig({
    configVersion: CONFIG_VERSION,
    id,
    label,
    enabled: true,
    servers: [
      { transport: "stdio", id: "s", command: "node", args: ["x.js"], env: {} },
    ],
  });
}

async function key(): Promise<SigningKey> {
  return new InMemoryVault().getOrCreateSigningKey();
}

async function registryFor(admin: SigningKey, ...others: SigningKey[]): Promise<TrustRegistry> {
  const entries: TrustEntry[] = [admin, ...others].map((k) => ({
    deviceId: k.deviceId,
    publicKeyHex: k.publicKeyHex,
    role: "trusted" as const,
  }));
  return signTrustRegistry(admin, 1, entries);
}

function coordinator(
  store: InMemoryConditionalObjectStore,
  signingKey: SigningKey,
  over: { historyLimit?: number } = {},
): ProjectSyncCoordinator {
  return new ProjectSyncCoordinator({
    store: store as unknown as SyncObjectStore,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: generateSaltHex(),
    signingKey,
    ...over,
  });
}

// ── keys ────────────────────────────────────────────────────────────────────

test("a revision key round-trips, and only a canonical integer parses", () => {
  assert.equal(projectRevisionKey(PREFIX, "proj", 7), `${PREFIX}/mcp/projects/proj/rev/7.json`);
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", projectRevisionKey(PREFIX, "proj", 7)), 7);

  const prefix = projectRevisionsPrefix(PREFIX, "proj");
  // A leading zero would let a second object claim revision 1 and shadow the real
  // one, so only the canonical spelling counts.
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${prefix}01.json`), null);
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${prefix}0.json`), null);
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${prefix}-1.json`), null);
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${prefix}1.2.json`), null);
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${prefix}nested/1.json`), null);
  // Another project's archive is not this project's.
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${PREFIX}/mcp/projects/other/rev/1.json`), null);
  // Neither is the head.
  assert.equal(parseProjectRevisionKey(PREFIX, "proj", `${PREFIX}/mcp/projects/proj/state.json`), null);
});

// ── the signed stamp ────────────────────────────────────────────────────────

test("an archive stamp verifies only for the exact slot and content it names", async () => {
  const k = await key();
  const registry = await registryFor(k);
  const stamp = await signArchiveStamp(k, "proj" as never, 3, "a".repeat(64), "2024-05-01T10:00:00.000Z");

  assert.equal(
    verifyArchiveStamp(stamp, registry, {
      project: "proj",
      revision: 3,
      recordHash: "a".repeat(64),
    }).archivedAt,
    "2024-05-01T10:00:00.000Z",
  );

  // Moving a genuine stamp onto another revision, another project, or different
  // content must all fail — otherwise a valid timestamp could describe anything.
  for (const expected of [
    { project: "proj", revision: 4, recordHash: "a".repeat(64) },
    { project: "other", revision: 3, recordHash: "a".repeat(64) },
    { project: "proj", revision: 3, recordHash: "b".repeat(64) },
  ]) {
    assert.throws(
      () => verifyArchiveStamp(stamp, registry, expected),
      (e: unknown) => e instanceof VerificationError,
      `should refuse ${JSON.stringify(expected)}`,
    );
  }
});

test("a stamp from an untrusted device is refused", async () => {
  const admin = await key();
  const stranger = await key();
  const registry = await registryFor(admin);
  const stamp = await signArchiveStamp(stranger, "proj" as never, 1, "c".repeat(64));
  assert.throws(
    () => verifyArchiveStamp(stamp, registry, { project: "proj", revision: 1, recordHash: "c".repeat(64) }),
    (e: unknown) => e instanceof VerificationError && e.code === "unknown-signer",
  );
});

test("a tampered stamp timestamp fails the signature", async () => {
  const k = await key();
  const registry = await registryFor(k);
  const stamp = await signArchiveStamp(k, "proj" as never, 1, "d".repeat(64), "2024-01-01T00:00:00.000Z");
  const moved = { ...stamp, archivedAt: "2025-01-01T00:00:00.000Z" };
  assert.throws(
    () => verifyArchiveStamp(moved, registry, { project: "proj", revision: 1, recordHash: "d".repeat(64) }),
    (e: unknown) => e instanceof VerificationError && e.code === "bad-signature",
  );
});

// ── history listing ─────────────────────────────────────────────────────────

test("every published revision appears in history with a signed timestamp", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);

  await c.publish(config("proj", "first"), 1);
  await c.publish(config("proj", "second"), 2);
  await c.publish(config("proj", "third"), 3);

  const entries = await c.history("proj", registry);
  assert.deepEqual(entries.map((e) => e.revision), [1, 2, 3]);
  assert.ok(entries.every((e) => e.kind === "config"));
  assert.ok(entries.every((e) => e.signer === k.deviceId));
  // Timestamps are real, verified, and in order.
  for (const e of entries) {
    assert.ok(e.archivedAt !== null, `revision ${e.revision} should carry a timestamp`);
    assert.ok(Number.isFinite(Date.parse(e.archivedAt as string)));
  }
});

test("an archived revision can be read back and is exactly what was published", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);

  await c.publish(config("proj", "the original label"), 1);
  await c.publish(config("proj", "renamed later"), 2);

  const old = await c.readRevision("proj", 1, registry);
  assert.ok(old, "revision 1 should be readable");
  assert.equal(old.config.label, "the original label");
  assert.equal(old.revision, 1);
  assert.equal(old.signer, k.deviceId);
  assert.ok(old.archivedAt !== null);

  // Reading an old revision must NOT be treated as a rollback: that is the whole
  // point of this method, and applying rollback protection would reject it.
  const current = await c.readRevision("proj", 2, registry);
  assert.equal(current?.config.label, "renamed later");
});

test("a missing or foreign revision reads as absent rather than throwing", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);
  await c.publish(config("proj", "only"), 1);

  assert.equal(await c.readRevision("proj", 99, registry), null);
  assert.equal(await c.readRevision("nosuchproject", 1, registry), null);
});

test("history from an untrusted signer is not offered for restore", async () => {
  const store = new InMemoryConditionalObjectStore();
  const stranger = await key();
  const admin = await key();
  // The stranger publishes; the registry trusts only the admin.
  await coordinator(store, stranger).publish(config("proj", "from a stranger"), 1);
  const registry = await registryFor(admin);
  const c = coordinator(store, admin);

  assert.deepEqual(await c.history("proj", registry), []);
  assert.equal(await c.readRevision("proj", 1, registry), null);
});

test("a deletion appears in the timeline so history is not silently wrong", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);

  await c.publish(config("proj", "alive"), 1);
  await c.publishTombstone("proj", 2);

  const entries = await c.history("proj", registry);
  assert.deepEqual(
    entries.map((e) => ({ revision: e.revision, kind: e.kind })),
    [
      { revision: 1, kind: "config" },
      { revision: 2, kind: "tombstone" },
    ],
  );
  assert.ok(entries[1]?.archivedAt !== null, "a deletion carries its own signed time");
});

test("a corrupt archive object is skipped without hiding its neighbours", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);
  await c.publish(config("proj", "one"), 1);
  await c.publish(config("proj", "two"), 2);

  // Overwrite revision 1's archive with rubbish.
  const key1 = projectRevisionKey(PREFIX, "proj", 1);
  const s = store as unknown as SyncObjectStore & { delete(k: string): Promise<void> };
  await s.delete(key1);
  await s.putImmutable(key1, new TextEncoder().encode("{not json"));

  const entries = await c.history("proj", registry);
  assert.deepEqual(entries.map((e) => e.revision), [2]);
  assert.equal(await c.readRevision("proj", 1, registry), null);
});

test("an unverifiable stamp costs the timestamp, not the revision", async () => {
  // A config signed by a trusted device is still a real config. Dropping it
  // because its clock reading cannot be trusted would lose real history; the
  // honest answer is to list it with no date.
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);
  await c.publish(config("proj", "one"), 1);

  const key1 = projectRevisionKey(PREFIX, "proj", 1);
  const s = store as unknown as SyncObjectStore & { delete(k: string): Promise<void> };
  const raw = JSON.parse(new TextDecoder().decode((await s.get(key1)).bytes)) as {
    stamp: { signature: string };
  };
  raw.stamp.signature = "00".repeat(64);
  await s.delete(key1);
  await s.putImmutable(key1, new TextEncoder().encode(JSON.stringify(raw)));

  const entries = await c.history("proj", registry);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.revision, 1);
  assert.equal(entries[0]?.archivedAt, null);
  // And it is still restorable — the config's own signature is intact.
  assert.equal((await c.readRevision("proj", 1, registry))?.config.label, "one");
});

// ── selecting a point in time ───────────────────────────────────────────────

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    projectId: "proj",
    revision: 1,
    archivedAt: "2024-05-01T10:00:00.000Z",
    signer: "device_a",
    kind: "config",
    ...over,
  };
}

test("selecting a moment picks the newest revision at or before it", () => {
  const entries = [
    entry({ revision: 1, archivedAt: "2024-05-01T10:00:00.000Z" }),
    entry({ revision: 2, archivedAt: "2024-05-03T10:00:00.000Z" }),
    entry({ revision: 3, archivedAt: "2024-05-07T10:00:00.000Z" }),
  ];
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-05T00:00:00Z"))?.revision, 2);
  // Exactly on the boundary counts as at that revision.
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-03T10:00:00Z"))?.revision, 2);
  assert.equal(selectRevisionAt(entries, Date.parse("2024-06-01T00:00:00Z"))?.revision, 3);
  // Before anything existed there is nothing to restore.
  assert.equal(selectRevisionAt(entries, Date.parse("2024-04-01T00:00:00Z")), null);
});

test("a project deleted before the chosen moment has nothing to restore", () => {
  // Answering with the pre-deletion config would silently resurrect a project the
  // operator deleted on purpose.
  const entries = [
    entry({ revision: 1, archivedAt: "2024-05-01T10:00:00.000Z" }),
    entry({ revision: 2, archivedAt: "2024-05-02T10:00:00.000Z", kind: "tombstone" }),
  ];
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-05T00:00:00Z")), null);
  // But before the deletion it was alive.
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-01T12:00:00Z"))?.revision, 1);
});

test("a project recreated after a deletion is restorable again", () => {
  const entries = [
    entry({ revision: 1, archivedAt: "2024-05-01T10:00:00.000Z" }),
    entry({ revision: 2, archivedAt: "2024-05-02T10:00:00.000Z", kind: "tombstone" }),
    entry({ revision: 3, archivedAt: "2024-05-03T10:00:00.000Z" }),
  ];
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-04T00:00:00Z"))?.revision, 3);
});

test("undated revisions are ignored rather than guessed at", () => {
  const entries = [
    entry({ revision: 1, archivedAt: null }),
    entry({ revision: 2, archivedAt: "2024-05-03T10:00:00.000Z" }),
  ];
  assert.equal(selectRevisionAt(entries, Date.parse("2024-05-05T00:00:00Z"))?.revision, 2);
  // With only undated entries there is no defensible answer.
  assert.equal(selectRevisionAt([entry({ archivedAt: null })], Date.now()), null);
});

test("identical timestamps are ordered by revision, not by list order", () => {
  // Two devices can stamp the same instant; revisions are the authoritative order.
  const at = "2024-05-03T10:00:00.000Z";
  const entries = [
    entry({ revision: 5, archivedAt: at }),
    entry({ revision: 4, archivedAt: at }),
  ];
  assert.equal(selectRevisionAt(entries, Date.parse(at))?.revision, 5);
});

test("history plus selection recovers an old config end to end", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k);
  const registry = await registryFor(k);

  await c.publish(config("proj", "monday"), 1);
  await new Promise((r) => setTimeout(r, 5));
  await c.publish(config("proj", "friday"), 2);

  const entries = await c.history("proj", registry);
  const first = entries[0];
  assert.ok(first?.archivedAt);
  // Choose a moment before the second edit landed.
  const chosen = selectRevisionAt(entries, Date.parse(first.archivedAt));
  assert.equal(chosen?.revision, 1);
  const recovered = await c.readRevision("proj", chosen?.revision ?? 0, registry);
  assert.equal(recovered?.config.label, "monday");
});

// ── retention ───────────────────────────────────────────────────────────────

test("publishing prunes the archive to the configured limit", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k, { historyLimit: 3 });
  const registry = await registryFor(k);

  for (let rev = 1; rev <= 6; rev += 1) {
    await c.publish(config("proj", `v${rev}`), rev);
  }
  const entries = await c.history("proj", registry);
  // The newest three survive; the oldest three are gone.
  assert.deepEqual(entries.map((e) => e.revision), [4, 5, 6]);
  assert.equal(await c.readRevision("proj", 1, registry), null);
  assert.equal((await c.readRevision("proj", 6, registry))?.config.label, "v6");
});

test("the head survives pruning — retention never touches current state", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k, { historyLimit: 1 });
  const registry = await registryFor(k);
  for (let rev = 1; rev <= 4; rev += 1) {
    await c.publish(config("proj", `v${rev}`), rev);
  }
  const restored = await c.restoreAll(registry);
  assert.equal(restored.applied.length, 1);
  assert.equal(restored.applied[0]?.config.label, "v4");
  assert.equal(restored.applied[0]?.revision, 4);
});

test("pruning reports what it did and refuses a nonsense limit", async () => {
  const store = new InMemoryConditionalObjectStore();
  const k = await key();
  const c = coordinator(store, k, { historyLimit: 100 });
  for (let rev = 1; rev <= 5; rev += 1) {
    await c.publish(config("proj", `v${rev}`), rev);
  }
  const result = await c.pruneHistory("proj", 2);
  assert.equal(result.supported, true);
  assert.equal(result.deleted, 3);
  assert.equal(result.retained, 2);
  // Idempotent: a second prune has nothing left to do.
  assert.deepEqual(await c.pruneHistory("proj", 2), {
    deleted: 0,
    retained: 2,
    supported: true,
  });
  await assert.rejects(() => c.pruneHistory("proj", 0));
});

test("a store that cannot delete keeps full history and says so", async () => {
  // Retention is a policy, not a guarantee. Silently doing nothing would be
  // indistinguishable from a policy that worked.
  const inner = new InMemoryConditionalObjectStore();
  const noDelete = new Proxy(inner as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "deleteStrict") return undefined;
      return Reflect.get(target, prop);
    },
  }) as unknown as SyncObjectStore;
  const k = await key();
  const c = new ProjectSyncCoordinator({
    store: noDelete,
    controlPrefix: PREFIX,
    password: PASSWORD,
    saltHex: generateSaltHex(),
    signingKey: k,
    historyLimit: 1,
  });
  const registry = await registryFor(k);
  for (let rev = 1; rev <= 3; rev += 1) {
    await c.publish(config("proj", `v${rev}`), rev);
  }
  const result = await c.pruneHistory("proj", 1);
  assert.equal(result.supported, false);
  assert.equal(result.deleted, 0);
  assert.equal(result.retained, 3);
  // Nothing was lost, and everything is still restorable.
  assert.deepEqual((await c.history("proj", registry)).map((e) => e.revision), [1, 2, 3]);
});

test("the default retention limit is a documented number, not an accident", () => {
  assert.equal(DEFAULT_HISTORY_LIMIT, 20);
});
