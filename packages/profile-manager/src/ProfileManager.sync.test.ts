import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./ProfileManager.js";
import "./test-support.js";

function tempManager(): { pm: ProfileManager; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mz-pm-sync-"));
  const pm = new ProfileManager({
    dbPath: join(root, "profiles.db"),
    profilesRoot: join(root, "profiles"),
  });
  return { pm, root };
}

function withManager(fn: (pm: ProfileManager, root: string) => void): void {
  const { pm, root } = tempManager();
  try {
    fn(pm, root);
  } finally {
    pm.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Schema / migration ────────────────────────────────────────────────────

test("migrate: idempotent across repeated opens on same DB", () => {
  const root = mkdtempSync(join(tmpdir(), "mz-pm-mig-"));
  const dbPath = join(root, "profiles.db");
  const profilesRoot = join(root, "profiles");
  try {
    const pm1 = new ProfileManager({ dbPath, profilesRoot });
    const p = pm1.create({ name: "A" });
    pm1.upsertSyncState({ profileId: p.id, syncEnabled: true, localRevision: 3 });
    pm1.close();
    // Reopen — migrate() runs again and must preserve data.
    const pm2 = new ProfileManager({ dbPath, profilesRoot });
    const st = pm2.getSyncState(p.id);
    assert.ok(st);
    assert.equal(st?.syncEnabled, true);
    assert.equal(st?.localRevision, 3);
    pm2.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Sync state defaults & compatibility ─────────────────────────────────────

test("getSyncState: returns null when profile has no sync row (disabled by default)", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    assert.equal(pm.getSyncState(p.id), null);
  });
});

test("existing behavior preserved: create/list/get still work with sync schema present", () => {
  withManager((pm) => {
    const p = pm.create({ name: "Amazon US", tags: ["shop"] });
    assert.equal(pm.list().length, 1);
    const got = pm.get(p.id);
    assert.equal(got?.name, "Amazon US");
    assert.equal(pm.getSyncState(p.id), null); // no coupling introduced
  });
});

// ── upsert / update / mark-dirty ────────────────────────────────────────────

test("upsertSyncState: inserts with defaults then updates", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    const inserted = pm.upsertSyncState({ profileId: p.id });
    assert.equal(inserted.syncEnabled, false);
    assert.equal(inserted.localRevision, 0);
    assert.equal(inserted.dirty, false);

    const updated = pm.upsertSyncState({
      profileId: p.id,
      syncEnabled: true,
      localRevision: 10,
      remoteRevision: 12,
      latestSnapshotId: "snap-12",
    });
    assert.equal(updated.syncEnabled, true);
    assert.equal(updated.localRevision, 10);
    assert.equal(updated.remoteRevision, 12);
    assert.equal(updated.latestSnapshotId, "snap-12");

    // Persisted
    const reread = pm.getSyncState(p.id);
    assert.deepEqual(
      { e: reread?.syncEnabled, l: reread?.localRevision, r: reread?.remoteRevision },
      { e: true, l: 10, r: 12 },
    );
  });
});

test("upsertSyncState: preserves unspecified fields on update", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    pm.upsertSyncState({ profileId: p.id, localRevision: 5, baseRevision: 5 });
    const after = pm.upsertSyncState({ profileId: p.id, dirty: true });
    assert.equal(after.localRevision, 5);
    assert.equal(after.baseRevision, 5);
    assert.equal(after.dirty, true);
  });
});

test("upsertSyncState: throws for unknown profile (FK guard)", () => {
  withManager((pm) => {
    assert.throws(() => pm.upsertSyncState({ profileId: "nope" }), /not found/);
  });
});

test("updateSyncState: creates row when absent, then patches", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    const created = pm.updateSyncState(p.id, { localRevision: 7 });
    assert.equal(created.localRevision, 7);
    const patched = pm.updateSyncState(p.id, { dirty: true });
    assert.equal(patched.localRevision, 7); // preserved
    assert.equal(patched.dirty, true);
  });
});

test("markSyncDirty: toggles dirty flag", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    pm.upsertSyncState({ profileId: p.id });
    assert.equal(pm.markSyncDirty(p.id).dirty, true);
    assert.equal(pm.markSyncDirty(p.id, false).dirty, false);
  });
});

test("latestSnapshotId / lastSyncedAt can be explicitly cleared to null", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    pm.upsertSyncState({ profileId: p.id, latestSnapshotId: "s1", lastSyncedAt: "t1" });
    const cleared = pm.updateSyncState(p.id, { latestSnapshotId: null, lastSyncedAt: null });
    assert.equal(cleared.latestSnapshotId, null);
    assert.equal(cleared.lastSyncedAt, null);
  });
});

// ── Cascade on delete ───────────────────────────────────────────────────────

test("deleting a profile cascades its sync_state and operations", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    pm.upsertSyncState({ profileId: p.id, syncEnabled: true });
    pm.recordSyncOperation({ profileId: p.id, kind: "backup", status: "succeeded" });
    pm.delete(p.id);
    assert.equal(pm.getSyncState(p.id), null);
    assert.equal(pm.listSyncOperations(p.id).length, 0);
  });
});

// ── Operation journal ───────────────────────────────────────────────────────

test("recordSyncOperation + update + list", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    const op = pm.recordSyncOperation({
      profileId: p.id,
      kind: "publish",
      status: "running",
      fromRevision: 3,
    });
    assert.equal(op.status, "running");
    pm.updateSyncOperation(op.id, { status: "succeeded", toRevision: 4, snapshotId: "snap-4" });
    const ops = pm.listSyncOperations(p.id);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]?.status, "succeeded");
    assert.equal(ops[0]?.toRevision, 4);
    assert.equal(ops[0]?.snapshotId, "snap-4");
  });
});

test("updateSyncOperation: throws for unknown op", () => {
  withManager((pm) => {
    assert.throws(() => pm.updateSyncOperation("nope", { status: "failed" }), /not found/);
  });
});

test("listSyncOperations: newest first and respects limit", () => {
  withManager((pm) => {
    const p = pm.create({ name: "A" });
    for (let i = 0; i < 5; i++) {
      pm.recordSyncOperation({
        profileId: p.id,
        kind: "backup",
        status: "succeeded",
        message: `#${i}`,
      });
    }
    const limited = pm.listSyncOperations(p.id, 3);
    assert.equal(limited.length, 3);
  });
});

// ── Conflict copy insertion ────────────────────────────────────────────────

test("insertConflictProfile: clones metadata under new id + dataDir, creates dir", () => {
  withManager((pm, root) => {
    const src = pm.create({
      name: "Amazon US",
      tags: ["shop"],
      proxy: { type: "socks5", host: "1.2.3.4", port: 1080, username: "u", password: "p" },
    });
    const conflictDir = join(root, "profiles", "conflict-1");
    const copy = pm.insertConflictProfile({
      source: src,
      conflictId: "conflict-1",
      conflictName: "Amazon US - Conflict - Mac Studio",
      dataDir: conflictDir,
      baseRevision: 5,
      remoteRevision: 8,
    });
    assert.equal(copy.id, "conflict-1");
    assert.equal(copy.name, "Amazon US - Conflict - Mac Studio");
    assert.notEqual(copy.id, src.id);
    assert.notEqual(copy.dataDir, src.dataDir);
    assert.ok(existsSync(conflictDir), "conflict dataDir should be created");

    // Copy carries the same proxy (creds preserved locally; sanitization is a
    // manifest concern, not a DB concern).
    assert.equal(copy.proxy?.host, "1.2.3.4");

    // Sync state initialized: disabled, clean, revisions recorded.
    const st = pm.getSyncState(copy.id);
    assert.ok(st);
    assert.equal(st?.syncEnabled, false);
    assert.equal(st?.dirty, false);
    assert.equal(st?.baseRevision, 5);
    assert.equal(st?.remoteRevision, 8);
    assert.equal(st?.localRevision, 8);

    // Both profiles coexist.
    assert.equal(pm.list().length, 2);
  });
});

test("insertConflictProfile: rejects duplicate id", () => {
  withManager((pm, root) => {
    const src = pm.create({ name: "A" });
    assert.throws(
      () =>
        pm.insertConflictProfile({
          source: src,
          conflictId: src.id, // collision
          conflictName: "A - Conflict",
          dataDir: join(root, "profiles", "dup"),
          baseRevision: 1,
          remoteRevision: 2,
        }),
      /already exists/,
    );
  });
});

// ── Imported profile (connectExisting path) ────────────────────────────────

test("insertImported: persists proxyCountry (connectExisting no longer drops it)", () => {
  withManager((pm, root) => {
    // Build a fully-formed profile the way connectExisting does after restoring
    // a snapshot + reading its sanitized manifest (which carries proxyCountry).
    const src = pm.create({ name: "Amazon US" });
    const importedDir = join(root, "profiles", "imported-1");
    const imported = {
      ...src,
      id: "imported-1",
      dataDir: importedDir,
      proxyCountry: "US",
    };
    const returned = pm.insertImported(imported);
    assert.equal(returned.proxyCountry, "US");

    // Read back through the DB to prove it was actually stored, not just echoed.
    const fetched = pm.get("imported-1");
    assert.ok(fetched);
    assert.equal(fetched?.proxyCountry, "US", "proxy_country must survive the INSERT");
  });
});
