import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncErrorCode, isSyncError } from "@multizen/sync-core";
import { SyncController, extractSnapshotId, assertSafePathSegment } from "../SyncController.ts";
import { FakeCredentialVault } from "../CredentialVault.ts";

// ── extractSnapshotId (pure) ─────────────────────────────────────────────

test("extractSnapshotId probes common Kopia shapes", () => {
  assert.equal(extractSnapshotId({ id: "abc" }), "abc");
  assert.equal(extractSnapshotId([{ id: "arr1" }]), "arr1");
  assert.equal(extractSnapshotId({ rootEntry: { obj: "k123" } }), "k123");
  assert.equal(extractSnapshotId({ manifestId: "m1" }), "m1");
  assert.equal(extractSnapshotId({ nothing: true }), null);
  assert.equal(extractSnapshotId(null), null);
});

// ── Fakes ────────────────────────────────────────────────────────────────

type SyncStateRow = {
  profileId: string;
  syncEnabled: boolean;
  localRevision: number;
  baseRevision: number;
  remoteRevision: number;
  dirty: boolean;
  latestSnapshotId: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
};

class FakeProfileManager {
  profiles = new Map<string, { id: string; name: string; dataDir: string; tags?: string[] }>();
  states = new Map<string, SyncStateRow>();
  ops: Array<{ id: string; profileId: string; kind: string; status: string; message?: string | null }> = [];
  /** Toggle to force insertImported to throw (fault injection). */
  failInsertImported = false;
  /** Toggle to force upsertSyncState to throw once after insert (fault injection). */
  failNextUpsert = false;

  get(id: string) {
    return this.profiles.get(id) ?? null;
  }
  getSyncState(id: string) {
    return this.states.get(id) ?? null;
  }
  upsertSyncState(input: { profileId: string } & Partial<SyncStateRow>) {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("injected upsertSyncState failure");
    }
    const prev = this.states.get(input.profileId);
    const row: SyncStateRow = {
      profileId: input.profileId,
      syncEnabled: input.syncEnabled ?? prev?.syncEnabled ?? false,
      localRevision: input.localRevision ?? prev?.localRevision ?? 0,
      baseRevision: input.baseRevision ?? prev?.baseRevision ?? 0,
      remoteRevision: input.remoteRevision ?? prev?.remoteRevision ?? 0,
      dirty: input.dirty ?? prev?.dirty ?? false,
      latestSnapshotId:
        input.latestSnapshotId !== undefined ? input.latestSnapshotId : (prev?.latestSnapshotId ?? null),
      lastSyncedAt: input.lastSyncedAt !== undefined ? input.lastSyncedAt : (prev?.lastSyncedAt ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.states.set(input.profileId, row);
    return row;
  }
  updateSyncState(id: string, patch: Partial<SyncStateRow>) {
    return this.upsertSyncState({ profileId: id, ...patch });
  }
  markSyncDirty(id: string, dirty = true) {
    return this.updateSyncState(id, { dirty });
  }
  // Mirrors ProfileManager.insertImported: inserting the row is what enables a
  // subsequent sync-operation journal write (FK to profiles(id)).
  insertImported(profile: { id: string; name: string; dataDir: string; tags?: string[] }) {
    if (this.failInsertImported) throw new Error("injected insertImported failure");
    if (this.profiles.has(profile.id)) throw new Error(`Profile ${profile.id} already exists`);
    this.profiles.set(profile.id, { id: profile.id, name: profile.name, dataDir: profile.dataDir, tags: profile.tags });
    return profile;
  }
  insertConflictProfile(input: {
    source: { id: string; name: string; dataDir: string };
    conflictId: string;
    conflictName: string;
    dataDir: string;
    baseRevision: number;
    remoteRevision: number;
  }) {
    if (this.profiles.has(input.conflictId)) {
      throw new Error(`Profile ${input.conflictId} already exists`);
    }
    this.profiles.set(input.conflictId, {
      id: input.conflictId,
      name: input.conflictName,
      dataDir: input.dataDir,
    });
    this.upsertSyncState({
      profileId: input.conflictId,
      syncEnabled: false,
      localRevision: input.remoteRevision,
      baseRevision: input.baseRevision,
      remoteRevision: input.remoteRevision,
      dirty: false,
    });
    return this.profiles.get(input.conflictId)!;
  }
  delete(id: string) {
    this.profiles.delete(id);
    this.states.delete(id);
    // Cascade delete journal entries (mirrors ON DELETE CASCADE).
    this.ops = this.ops.filter((o) => o.profileId !== id);
  }
  recordSyncOperation(input: { profileId: string; kind: string; status: string; message?: string | null }) {
    // Enforce the real FK: a journal row cannot exist without its profile row.
    if (!this.profiles.has(input.profileId)) {
      throw new Error(
        `FOREIGN KEY constraint failed: sync_operations.profile_id -> profiles(${input.profileId})`,
      );
    }
    const op = {
      id: `op${this.ops.length}`,
      profileId: input.profileId,
      kind: input.kind,
      status: input.status,
      message: input.message ?? null,
    };
    this.ops.push(op);
    return op;
  }
  updateSyncOperation(opId: string, patch: { status?: string; message?: string | null }) {
    const op = this.ops.find((o) => o.id === opId);
    if (op && patch.status) op.status = patch.status;
    if (op && patch.message !== undefined) op.message = patch.message;
  }
}

class FakeDriver {
  private runningSet = new Set<string>();
  closed: string[] = [];
  setRunning(id: string, running: boolean) {
    if (running) this.runningSet.add(id);
    else this.runningSet.delete(id);
  }
  isRunning(id: string) {
    return this.runningSet.has(id);
  }
  async countProcessesUsingDataDir() {
    return 0;
  }
  async close(id: string) {
    this.closed.push(id);
    this.runningSet.delete(id);
  }
}

function makeSettings() {
  return {
    sync: {
      enabled: true,
      workerUrl: "https://sync.example.com",
      accessClientId: "cid.access",
      s3Endpoint: "endpoint",
      s3Region: "auto",
      s3Bucket: "bucket",
      s3Prefix: "",
      deviceId: "device_test",
      deviceDisplayName: "Test Mac",
      kopiaPasswordRef: "kopiaPassword",
      s3AccessKeyIdRef: "s3AccessKeyId",
      s3SecretAccessKeyRef: "s3SecretAccessKey",
      accessClientSecretRef: "accessClientSecret",
      kopiaConfigPath: "",
      kopiaBinPath: "",
    },
  };
}

class FakeSettingsStore {
  constructor(private settings: ReturnType<typeof makeSettings>) {}
  async update(patch: { sync?: Record<string, unknown> }) {
    if (patch.sync) Object.assign(this.settings.sync, patch.sync);
    return this.settings;
  }
}

class FakeClient {
  state = { currentRevision: 0, latestSnapshotId: null as string | null };
  publishCalls = 0;
  lastPublishArgs: { expectedRevision: number } | null = null;
  releaseCalls = 0;
  acquireCalls = 0;
  renewCalls = 0;
  /** When set, acquire rejects with this error (fault injection). */
  acquireError: Error | null = null;
  updateConfig() {}
  async health() {
    return true;
  }
  async getState() {
    if (this.state.currentRevision === 0 && !this.state.latestSnapshotId) {
      return { kind: "not-found" as const };
    }
    return {
      kind: "state" as const,
      state: {
        profileId: "p",
        currentRevision: this.state.currentRevision,
        latestSnapshotId: this.state.latestSnapshotId,
        ownerDeviceId: "device_test",
        leaseExpiresAt: Date.now() + 60000,
        fencingToken: 1,
      },
    };
  }
  async acquire() {
    this.acquireCalls += 1;
    if (this.acquireError) throw this.acquireError;
    return {
      state: { profileId: "p", currentRevision: this.state.currentRevision, latestSnapshotId: this.state.latestSnapshotId, ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 },
      lease: { leaseId: "lease0123456789ab", fencingToken: 1, leaseExpiresAt: Date.now() + 60000, leaseTtlMs: 60000, recommendedRenewalMs: 30000 },
    };
  }
  async renew() {
    this.renewCalls += 1;
    return {
      state: { profileId: "p", currentRevision: this.state.currentRevision, latestSnapshotId: this.state.latestSnapshotId, ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 },
      lease: { leaseId: "lease0123456789ab", fencingToken: 1, leaseExpiresAt: Date.now() + 60000, leaseTtlMs: 60000, recommendedRenewalMs: 30000 },
    };
  }
  async publish(_profileId: string, args: { expectedRevision: number }) {
    this.publishCalls += 1;
    this.lastPublishArgs = { expectedRevision: args.expectedRevision };
    const revision = this.state.currentRevision + 1;
    this.state.currentRevision = revision;
    return { state: { profileId: "p", currentRevision: revision, latestSnapshotId: "snapX", ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 }, revision };
  }
  async release() {
    this.releaseCalls += 1;
    return { state: {}, released: true };
  }
}

class FakeKopia {
  connected = false;
  restoreCalls = 0;
  /** When set, restore rejects (fault injection). */
  restoreError: Error | null = null;
  /** Manifest object written into the restore staging dir; null = write none. */
  manifest: Record<string, unknown> | null = null;
  /** Optional payload files written alongside the manifest to prove byte-identity. */
  payload: Record<string, string> = {};
  constructor(init?: { manifest?: Record<string, unknown> | null; payload?: Record<string, string> }) {
    if (init && "manifest" in init) this.manifest = init.manifest ?? null;
    if (init?.payload) this.payload = init.payload;
  }
  async connect() {
    this.connected = true;
  }
  async snapshot() {
    return { id: "snapX" };
  }
  async restore(_profileId: string, _snapshotId: string, targetDir: string) {
    this.restoreCalls += 1;
    if (this.restoreError) throw this.restoreError;
    // Write payload files (default: a marker) so tests can assert the live dir
    // is byte-identical to the original after a rollback.
    const files = Object.keys(this.payload).length > 0 ? this.payload : { "restored.txt": "restored" };
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(targetDir, rel), content);
    }
    if (this.manifest !== null) {
      const dir = join(targetDir, ".multizen-sync");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "profile-manifest.json"), JSON.stringify(this.manifest));
    }
  }
}

/** Build a structurally-valid manifest for a given profile id. */
function validManifest(id: string, name = "Restored"): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name,
    tags: ["a", "b"],
    fingerprint: { ua: "x" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
  };
}

function makeController(overrides: {
  pm: FakeProfileManager;
  driver: FakeDriver;
  client: FakeClient;
  kopia?: FakeKopia;
  vault?: FakeCredentialVault;
  root?: string;
}): { ctl: SyncController; root: string } {
  const settings = makeSettings();
  const vault = overrides.vault ?? new FakeCredentialVault();
  const root = overrides.root ?? mkdtempSync(join(tmpdir(), "mz-ctl-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    profileManager: overrides.pm,
    vault,
    driver: overrides.driver,
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    client: overrides.client,
    makeKopia: () => overrides.kopia ?? new FakeKopia(),
    sameVolume: () => true,
  };
  return { ctl: new SyncController(deps), root };
}

/** A vault preloaded with a Kopia password so makeKopiaFor won't reject. */
async function vaultWithPassword(): Promise<FakeCredentialVault> {
  const v = new FakeCredentialVault();
  await v.set("kopiaPassword", "pw-secret-1234");
  return v;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("beforeLaunch is a no-op for unsynced profiles", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  // no sync state row → unsynced
  const client = new FakeClient();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client });
  await ctl.beforeLaunch("p"); // must not throw, must not create state
  assert.equal(pm.getSyncState("p"), null);
});

test("markDirty only affects sync-enabled profiles", () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: false });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeClient() });
  ctl.markDirty("p");
  assert.equal(pm.getSyncState("p")!.dirty, false);

  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  ctl.markDirty("p");
  assert.equal(pm.getSyncState("p")!.dirty, true);
});

test("beforeLaunch REFUSES a synced profile without a lease (LeaseHeldByOther)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeClient();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client });
  await assert.rejects(
    () => ctl.beforeLaunch("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseHeldByOther,
  );
  // Must not have marked the profile dirty (no writable launch happened).
  assert.equal(pm.getSyncState("p")!.dirty, false);
});

test("beforeLaunch on synced clean profile WITH a lease marks dirty (writable launch)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeClient(); // NOT_FOUND → remote revision 0
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  await ctl.acquire("p"); // own an unexpired lease first
  await ctl.beforeLaunch("p");
  const s = pm.getSyncState("p")!;
  assert.equal(s.dirty, true);
  assert.equal(s.remoteRevision, 0, "NOT_FOUND treated as revision 0");
  await ctl.shutdown();
});

test("beforeLaunch drops an expired lease and refuses with LeaseExpired", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeClient();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  // Force the in-memory lease to be expired.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const held = (ctl as any).leases.get("p");
  held.expiresAtMs = Date.now() - 1;
  await assert.rejects(
    () => ctl.beforeLaunch("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseExpired,
  );
  // The stale lease must be dropped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("p"), false, "expired lease dropped");
  assert.equal(pm.getSyncState("p")!.dirty, false);
  await ctl.shutdown();
});

test("release refuses while Chromium is running", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const driver = new FakeDriver();
  driver.setRunning("p", true);
  const { ctl } = makeController({ pm, driver, client: new FakeClient() });
  await assert.rejects(
    () => ctl.release("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BrowserStillRunning,
  );
});

test("backup refuses while Chromium is running", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const driver = new FakeDriver();
  driver.setRunning("p", true);
  const { ctl } = makeController({ pm, driver, client: new FakeClient() });
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BrowserStillRunning,
  );
});

test("backup without a lease is refused", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeClient() });
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseHeldByOther,
  );
});

test("acquire → backup clears dirty ONLY after publish accepted", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeClient();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  // still dirty right after acquire
  assert.equal(pm.getSyncState("p")!.dirty, true);

  const status = await ctl.backupAndPublish("p");
  assert.equal(client.publishCalls, 1);
  assert.equal(status.dirty, false, "dirty cleared after accepted publish");
  assert.equal(status.localRevision, 1);
  assert.equal(status.latestSnapshotId, "snapX");
  await ctl.shutdown();
});

test("backupAndPublish REFUSES when remote advanced past base (conflict preservation)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  // Local diverged: base=1, dirty local edits, but remote already advanced to 2.
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 1,
    baseRevision: 1,
    remoteRevision: 1,
  });
  const client = new FakeClient();
  client.state = { currentRevision: 2, latestSnapshotId: "snapRemote" }; // remote > base
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.ConflictDetected,
  );
  // The invariant: no publish issued, and dirty is preserved for the user to resolve.
  assert.equal(client.publishCalls, 0, "must NOT fast-forward over a newer peer revision");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty preserved until conflict resolved");
  await ctl.shutdown();
});

test("backupAndPublish uses baseRevision as the CAS anchor (not fetched remote)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  // base=3, remote also at 3 (in sync), dirty local edits to push as rev 4.
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 3,
    baseRevision: 3,
    remoteRevision: 3,
  });
  const client = new FakeClient();
  client.state = { currentRevision: 3, latestSnapshotId: "snap3" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  await ctl.backupAndPublish("p");
  assert.equal(client.publishCalls, 1);
  assert.equal(
    client.lastPublishArgs!.expectedRevision,
    3,
    "expectedRevision must be the device baseRevision (CAS anchor)",
  );
  await ctl.shutdown();
});

test("enable toggles per-profile sync flag", () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeClient() });
  const s = ctl.enable("p", true);
  assert.equal(s.syncEnabled, true);
  const s2 = ctl.enable("p", false);
  assert.equal(s2.syncEnabled, false);
});

// ── restoreLatest: lease + dirty guards (req 2) ─────────────────────────────

test("restoreLatest without a lease is refused (LeaseHeldByOther)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia({ manifest: validManifest("p") }), vault: await vaultWithPassword() });
  await assert.rejects(
    () => ctl.restoreLatest("p", { keepLocalAsConflict: false }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseHeldByOther,
  );
});

test("restoreLatest REFUSES to overwrite dirty local with keepLocalAsConflict=false", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true, baseRevision: 1, localRevision: 1 });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await assert.rejects(
    () => ctl.restoreLatest("p", { keepLocalAsConflict: false }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.ConflictDetected,
  );
  // Nothing was restored; original data untouched, still dirty.
  assert.equal(kopia.restoreCalls, 0);
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.equal(pm.getSyncState("p")!.dirty, true);
  await ctl.shutdown();
});

test("restoreLatest happy path swaps in remote and clears dirty", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1 });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p"), payload: { "new.txt": "NEW" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  const status = await ctl.restoreLatest("p", { keepLocalAsConflict: false });
  assert.equal(status.localRevision, 5);
  assert.equal(status.dirty, false);
  assert.equal(readFileSync(join(dataDir, "new.txt"), "utf8"), "NEW");
  assert.equal(existsSync(join(dataDir, "orig.txt")), false, "old live content replaced");
  await ctl.shutdown();
});

// ── restoreLatest atomic rollback (req 5) ───────────────────────────────────

test("restoreLatest: restore failure leaves original data + DB unchanged", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  kopia.restoreError = new Error("kopia restore blew up");
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: false }));
  // Original live dir intact; DB row unchanged.
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  const s = pm.getSyncState("p")!;
  assert.equal(s.localRevision, 1, "revision not advanced on failed restore");
  assert.equal(s.baseRevision, 1);
  // No leftover staging/backup dirs in parent.
  assert.deepEqual(readdirSync(parent).filter((n: string) => n.startsWith(".")), []);
  await ctl.shutdown();
});

test("restoreLatest: DB-update failure AFTER swap restores original from backup", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p"), payload: { "new.txt": "NEW" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  // Fail the post-swap DB update.
  pm.failNextUpsert = true;
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: false }));
  // Original live dir must be restored byte-identically from the backup.
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.equal(existsSync(join(dataDir, "new.txt")), false, "restored content rolled back");
  const s = pm.getSyncState("p")!;
  assert.equal(s.localRevision, 1, "revision reverted after rollback");
  assert.equal(s.baseRevision, 1);
  // No leftover staging/backup dirs.
  assert.deepEqual(readdirSync(parent).filter((n: string) => n.startsWith(".")), []);
  await ctl.shutdown();
});

test("restoreLatest: conflict rollback deletes conflict profile when restore fails", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeClient();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  kopia.restoreError = new Error("kopia restore blew up");
  const { ctl, root } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await ctl.acquire("p");
  const before = pm.profiles.size;
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: true }));
  // Conflict profile created then rolled back → profile set unchanged.
  assert.equal(pm.profiles.size, before, "conflict profile row deleted on rollback");
  assert.equal(pm.getSyncState("p")!.dirty, true, "original still dirty (nothing restored)");
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.ok(root);
  await ctl.shutdown();
});

// ── connectExisting: path safety, lease-first, FK, rollback (req 3/4/6) ──────

test("connectExisting rejects unsafe profile ids (path traversal)", async () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", "with space"]) {
    const pm = new FakeProfileManager();
    const client = new FakeClient();
    client.state = { currentRevision: 3, latestSnapshotId: "snap3" };
    const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
    await assert.rejects(
      () => ctl.connectExisting(bad),
      (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput,
      `expected reject for ${JSON.stringify(bad)}`,
    );
    // Never acquired a lease for an invalid id.
    assert.equal(client.acquireCalls, 0);
    await ctl.shutdown();
  }
});

test("assertSafePathSegment accepts normal ids and rejects unsafe ones", () => {
  assertSafePathSegment("profile_123");
  assertSafePathSegment("A-b.C");
  for (const bad of ["", "..", ".", "a/b", "a\\b", "x\u0000y", "spa ce"]) {
    assert.throws(() => assertSafePathSegment(bad), (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput);
  }
});

test("connectExisting: acquires lease BEFORE restore and succeeds (no FK violation)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeClient();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const kopia = new FakeKopia({ manifest: validManifest("prof1", "Imported"), payload: { "data.txt": "D" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  const res = await ctl.connectExisting("prof1");
  assert.equal(res.profileId, "prof1");
  // Lease acquired before restore.
  assert.equal(client.acquireCalls, 1);
  assert.ok(client.acquireCalls === 1);
  // Profile + sync state inserted; a SUCCESS op journalled after the row exists.
  assert.ok(pm.get("prof1"));
  assert.equal(pm.getSyncState("prof1")!.localRevision, 7);
  assert.equal(pm.ops.length, 1);
  assert.equal(pm.ops[0]!.status, "succeeded");
  assert.equal(pm.ops[0]!.profileId, "prof1");
  // Lease still owned (auto-renewal installed).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok((ctl as any).leases.has("prof1"), "lease retained after successful connect");
  assert.equal(readFileSync(join(parent, "prof1", "data.txt"), "utf8"), "D");
  await ctl.shutdown();
});

test("connectExisting rollback: DB insert failure removes installed dir + releases lease (repro of prior FK failure)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeClient();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const kopia = new FakeKopia({ manifest: validManifest("prof1") });
  pm.failInsertImported = true; // final rename ok, DB insert fails
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(() => ctl.connectExisting("prof1"));
  // The newly-installed data dir must be removed.
  assert.equal(existsSync(join(parent, "prof1")), false, "installed dir removed on rollback");
  // No profile row, no orphaned journal entry (FK would have failed if journalled early).
  assert.equal(pm.get("prof1"), null);
  assert.equal(pm.ops.length, 0, "no journal entry written before the profile row existed");
  // Lease released + dropped.
  assert.equal(client.releaseCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("prof1"), false, "acquired lease released and dropped");
  await ctl.shutdown();
});

test("connectExisting rejects a manifest whose id mismatches the requested id", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeClient();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  // Manifest claims a different id → structural validation must reject.
  const kopia = new FakeKopia({ manifest: validManifest("someone-else") });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(
    () => ctl.connectExisting("prof1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LocalStateCorrupt,
  );
  assert.equal(existsSync(join(parent, "prof1")), false);
  assert.equal(pm.get("prof1"), null);
  assert.equal(client.releaseCalls, 1, "lease released after manifest rejection");
  await ctl.shutdown();
});

test("connectExisting refuses when the final data dir already exists (never rm)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const existing = join(parent, "prof1");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep.txt"), "KEEP");
  const client = new FakeClient();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia({ manifest: validManifest("prof1") }), vault: await vaultWithPassword(), root: parent });
  await assert.rejects(
    () => ctl.connectExisting("prof1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LocalStateCorrupt,
  );
  // Pre-existing dir untouched; no lease acquired.
  assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "KEEP");
  assert.equal(client.acquireCalls, 0);
  await ctl.shutdown();
});

test("connectExisting rejects a manifest carrying a forbidden secret field", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeClient();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const tampered = validManifest("prof1") as Record<string, unknown>;
  (tampered.proxy as unknown) = { type: "http", host: "h", port: 1, password: "leak" };
  const kopia = new FakeKopia({ manifest: tampered });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(() => ctl.connectExisting("prof1"));
  assert.equal(existsSync(join(parent, "prof1")), false);
  assert.equal(pm.get("prof1"), null);
  await ctl.shutdown();
});
