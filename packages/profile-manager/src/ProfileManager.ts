import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Profile,
  ProfileId,
  ProfileSummary,
  CreateProfileInput,
  UpdateProfileInput,
  ProxyConfig,
  FingerprintConfig,
  ExtensionConfig,
} from "@multizen/types";
import { defaultFingerprint } from "./fingerprint.js";

interface ProfileRow {
  id: string;
  name: string;
  notes: string | null;
  tags: string;
  proxy: string | null;
  fingerprint: string;
  data_dir: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  proxy_country: string | null;
  extensions: string | null;
  icon: string | null;
  start_url: string | null;
  search_provider: string | null;
}

interface ProfileSyncStateRow {
  profile_id: string;
  sync_enabled: number;
  local_revision: number;
  base_revision: number;
  remote_revision: number;
  dirty: number;
  latest_snapshot_id: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

interface SyncOperationRow {
  id: string;
  profile_id: string;
  kind: string;
  status: string;
  from_revision: number | null;
  to_revision: number | null;
  snapshot_id: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Local sync bookkeeping for one profile. Mirrors the `profile_sync_state`
 * row. `syncEnabled` defaults to `false` so existing behavior is unchanged
 * until a caller explicitly opts a profile into sync.
 */
export interface ProfileSyncState {
  profileId: string;
  syncEnabled: boolean;
  localRevision: number;
  baseRevision: number;
  remoteRevision: number;
  dirty: boolean;
  latestSnapshotId: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
}

/** Fields a caller may set when upserting sync state. All optional except id. */
export interface UpsertProfileSyncStateInput {
  profileId: string;
  syncEnabled?: boolean;
  localRevision?: number;
  baseRevision?: number;
  remoteRevision?: number;
  dirty?: boolean;
  latestSnapshotId?: string | null;
  lastSyncedAt?: string | null;
}

/** Partial update to an existing sync-state row. */
export interface UpdateProfileSyncStateInput {
  syncEnabled?: boolean;
  localRevision?: number;
  baseRevision?: number;
  remoteRevision?: number;
  dirty?: boolean;
  latestSnapshotId?: string | null;
  lastSyncedAt?: string | null;
}

export type SyncOperationKind = "backup" | "restore" | "publish" | "handoff";
export type SyncOperationStatus = "pending" | "running" | "succeeded" | "failed";

/** A row in the append-only sync journal. */
export interface SyncOperation {
  id: string;
  profileId: string;
  kind: SyncOperationKind;
  status: SyncOperationStatus;
  fromRevision: number | null;
  toRevision: number | null;
  snapshotId: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSyncOperationInput {
  profileId: string;
  kind: SyncOperationKind;
  status: SyncOperationStatus;
  fromRevision?: number | null;
  toRevision?: number | null;
  snapshotId?: string | null;
  message?: string | null;
}

/**
 * Input to insert a conflict-copy profile. The caller (a later sync
 * orchestrator) supplies a freshly-minted id and its own on-disk dataDir; this
 * mirrors {@link Profile} but is expressed structurally so the profile-manager
 * owns the insert + the initial sync-state row atomically.
 */
export interface InsertConflictProfileInput {
  /** The source profile to clone metadata from. */
  source: Profile;
  /** New unique profile id for the conflict copy. */
  conflictId: string;
  /** Display name for the copy (e.g. "Amazon US - Conflict - Mac Studio"). */
  conflictName: string;
  /** Absolute dataDir the caller will populate from the conflicting snapshot. */
  dataDir: string;
  /** Base revision the conflict diverged from (recorded on its sync state). */
  baseRevision: number;
  /** Remote revision that was in conflict (recorded as remote/local). */
  remoteRevision: number;
}

export interface ProfileManagerOptions {
  dbPath: string;
  profilesRoot: string;
}

export class ProfileManager {
  private readonly db: Database.Database;
  private readonly profilesRoot: string;

  constructor(opts: ProfileManagerOptions) {
    mkdirSync(opts.profilesRoot, { recursive: true });
    this.profilesRoot = opts.profilesRoot;
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        proxy TEXT,
        fingerprint TEXT NOT NULL,
        data_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
    `);
    // Idempotent column add — existing DBs predate proxy_country.
    const cols = this.db.prepare(`PRAGMA table_info(profiles)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "proxy_country")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN proxy_country TEXT`);
    }
    if (!cols.some((c) => c.name === "extensions")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN extensions TEXT`);
    }
    if (!cols.some((c) => c.name === "icon")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN icon TEXT`);
    }
    if (!cols.some((c) => c.name === "start_url")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN start_url TEXT`);
    }
    if (!cols.some((c) => c.name === "search_provider")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN search_provider TEXT`);
    }

    this.migrateSync();
  }

  /**
   * Idempotent schema for the Cloud Sync foundation (product plan §7/§29).
   *
   * Two additive tables, created only if absent, so this is safe to run on
   * every open and on DBs that predate sync. Nothing here alters the existing
   * `profiles` table or changes default behavior: sync is OFF unless a row in
   * `profile_sync_state` explicitly sets `sync_enabled = 1`. A profile with no
   * sync-state row behaves exactly as before.
   *
   *  - profile_sync_state : per-profile local revision bookkeeping (one row per
   *    profile). Mirrors {@link ProfileSyncState}. `ON DELETE CASCADE` keeps it
   *    tidy when a profile is deleted.
   *  - sync_operations : an append-only journal of sync attempts (backup /
   *    restore / publish / handoff) for diagnostics and retry. Never stores
   *    secrets — only ids, revisions, status, and a sanitized message.
   */
  private migrateSync(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile_sync_state (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        local_revision INTEGER NOT NULL DEFAULT 0,
        base_revision INTEGER NOT NULL DEFAULT 0,
        remote_revision INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        latest_snapshot_id TEXT,
        last_synced_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_operations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        from_revision INTEGER,
        to_revision INTEGER,
        snapshot_id TEXT,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_ops_profile ON sync_operations(profile_id, created_at);
    `);
  }

  list(): ProfileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, tags, last_opened_at, proxy, fingerprint, proxy_country, icon
         FROM profiles ORDER BY updated_at DESC`,
      )
      .all() as Pick<
      ProfileRow,
      "id" | "name" | "tags" | "last_opened_at" | "proxy" | "fingerprint" | "proxy_country" | "icon"
    >[];
    return rows.map((r) => {
      const fingerprint = JSON.parse(r.fingerprint) as FingerprintConfig;
      return {
        id: r.id,
        name: r.name,
        tags: JSON.parse(r.tags) as string[],
        lastOpenedAt: r.last_opened_at ?? undefined,
        isRunning: false,
        icon: r.icon ?? undefined,
        proxy: r.proxy ? (JSON.parse(r.proxy) as ProxyConfig) : undefined,
        timezone: fingerprint.timezone,
        proxyCountry: r.proxy_country ?? undefined,
        device: fingerprint.device,
      };
    });
  }

  get(id: ProfileId): Profile | null {
    const row = this.db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as
      | ProfileRow
      | undefined;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  create(input: CreateProfileInput): Profile {
    const id = uuidv4();
    const now = new Date().toISOString();
    const dataDir = join(this.profilesRoot, id);
    mkdirSync(dataDir, { recursive: true });

    const fingerprint: FingerprintConfig = {
      ...defaultFingerprint(id),
      ...input.fingerprint,
    };

    const profile: Profile = {
      id,
      name: input.name,
      notes: input.notes,
      tags: input.tags ?? [],
      proxy: input.proxy,
      fingerprint,
      extensions: input.extensions ?? [],
      icon: input.icon,
      startUrl: input.startUrl,
      searchProvider: input.searchProvider,
      dataDir,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO profiles
         (id, name, notes, tags, proxy, fingerprint, extensions, icon, start_url, search_provider, data_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.notes ?? null,
        JSON.stringify(profile.tags),
        profile.proxy ? JSON.stringify(profile.proxy) : null,
        JSON.stringify(profile.fingerprint),
        JSON.stringify(profile.extensions ?? []),
        profile.icon ?? null,
        profile.startUrl ?? null,
        profile.searchProvider ?? null,
        profile.dataDir,
        profile.createdAt,
        profile.updatedAt,
      );

    return profile;
  }

  /**
   * Insert an already-fully-formed profile verbatim — id, dataDir, extensions,
   * icon, startUrl, searchProvider, and timestamps all preserved. Used by
   * import, where the id + on-disk dataDir were established by
   * {@link importProfile} and must NOT be regenerated (that was the old bug: the
   * handler called create(), which minted a new id/dataDir and orphaned the
   * restored user-data-dir). Throws on id collision — the caller resolves that
   * before extracting files.
   */
  insertImported(profile: Profile): Profile {
    if (this.get(profile.id)) {
      throw new Error(`Profile ${profile.id} already exists`);
    }
    mkdirSync(profile.dataDir, { recursive: true });
    this.db
      .prepare(
        `INSERT INTO profiles
         (id, name, notes, tags, proxy, fingerprint, extensions, icon, start_url, search_provider, data_dir, created_at, updated_at, proxy_country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.notes ?? null,
        JSON.stringify(profile.tags),
        profile.proxy ? JSON.stringify(profile.proxy) : null,
        JSON.stringify(profile.fingerprint),
        JSON.stringify(profile.extensions ?? []),
        profile.icon ?? null,
        profile.startUrl ?? null,
        profile.searchProvider ?? null,
        profile.dataDir,
        profile.createdAt,
        profile.updatedAt,
        profile.proxyCountry ?? null,
      );
    return profile;
  }

  update(id: ProfileId, patch: UpdateProfileInput): Profile {
    const existing = this.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);

    const now = new Date().toISOString();
    const proxyChanged =
      patch.proxy !== undefined &&
      JSON.stringify(patch.proxy ?? null) !== JSON.stringify(existing.proxy ?? null);

    const merged: Profile = {
      ...existing,
      name: patch.name ?? existing.name,
      notes: patch.notes ?? existing.notes,
      tags: patch.tags ?? existing.tags,
      proxy: patch.proxy === null ? undefined : (patch.proxy ?? existing.proxy),
      fingerprint: { ...existing.fingerprint, ...patch.fingerprint },
      extensions: patch.extensions ?? existing.extensions,
      // null clears a custom icon (revert to the derived default); undefined keeps it.
      icon: patch.icon === null ? undefined : (patch.icon ?? existing.icon),
      // null clears → app default start page; undefined keeps existing.
      startUrl: patch.startUrl === null ? undefined : (patch.startUrl ?? existing.startUrl),
      // null clears → no search seeding; undefined keeps existing.
      searchProvider:
        patch.searchProvider === null
          ? undefined
          : (patch.searchProvider ?? existing.searchProvider),
      updatedAt: now,
      // Stale country if proxy changed — next launch / Test re-probes.
      proxyCountry: proxyChanged ? undefined : existing.proxyCountry,
    };

    this.db
      .prepare(
        `UPDATE profiles SET
           name = ?, notes = ?, tags = ?, proxy = ?, fingerprint = ?, extensions = ?,
           icon = ?, start_url = ?, search_provider = ?, updated_at = ?, proxy_country = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.notes ?? null,
        JSON.stringify(merged.tags),
        merged.proxy ? JSON.stringify(merged.proxy) : null,
        JSON.stringify(merged.fingerprint),
        JSON.stringify(merged.extensions ?? []),
        merged.icon ?? null,
        merged.startUrl ?? null,
        merged.searchProvider ?? null,
        merged.updatedAt,
        merged.proxyCountry ?? null,
        id,
      );

    return merged;
  }

  /** Persist the country code resolved from the proxy's egress IP. */
  setProxyCountry(id: ProfileId, country: string | null): void {
    this.db.prepare(`UPDATE profiles SET proxy_country = ? WHERE id = ?`).run(country, id);
  }

  delete(id: ProfileId): void {
    // Remove the on-disk profile directory (cookies, Chromium state, and any
    // installed extensions under dataDir/extensions/) so deleting a profile
    // doesn't orphan its data. Best-effort — a locked dir shouldn't block the
    // DB delete.
    const existing = this.get(id);
    this.db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
    if (existing) {
      try {
        rmSync(existing.dataDir, { recursive: true, force: true });
      } catch {
        // ignore — directory may be in use; DB row is already gone.
      }
    }
  }

  markOpened(id: ProfileId): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE profiles SET last_opened_at = ? WHERE id = ?`).run(now, id);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Every extension reference across all profiles, used by the shared-store GC
   * to decide whether a store entry is still referenced (derived refcount — no
   * separate counter to drift out of sync).
   */
  allExtensionRefs(): Array<{ profileId: string; dataDir: string; ext: ExtensionConfig }> {
    const rows = this.db.prepare(`SELECT id, data_dir, extensions FROM profiles`).all() as Array<
      Pick<ProfileRow, "id" | "data_dir" | "extensions">
    >;
    const out: Array<{ profileId: string; dataDir: string; ext: ExtensionConfig }> = [];
    for (const r of rows) {
      for (const ext of normalizeExtensions(r.extensions)) {
        out.push({ profileId: r.id, dataDir: r.data_dir, ext });
      }
    }
    return out;
  }

  // ── Cloud Sync: per-profile state ──────────────────────────────────────────

  /**
   * Get the sync state for a profile, or `null` if none exists yet. A missing
   * row means "sync never configured" → callers treat it as disabled.
   */
  getSyncState(id: ProfileId): ProfileSyncState | null {
    const row = this.db.prepare(`SELECT * FROM profile_sync_state WHERE profile_id = ?`).get(id) as
      | ProfileSyncStateRow
      | undefined;
    return row ? rowToSyncState(row) : null;
  }

  /**
   * Insert-or-update a profile's sync state. Absent fields default (on insert)
   * or are preserved (on update). Idempotent for a given input. Throws if the
   * referenced profile does not exist (FK).
   */
  upsertSyncState(input: UpsertProfileSyncStateInput): ProfileSyncState {
    if (!this.get(input.profileId)) {
      throw new Error(`Profile ${input.profileId} not found`);
    }
    const now = new Date().toISOString();
    const existing = this.getSyncState(input.profileId);
    const merged: ProfileSyncState = {
      profileId: input.profileId,
      syncEnabled: input.syncEnabled ?? existing?.syncEnabled ?? false,
      localRevision: input.localRevision ?? existing?.localRevision ?? 0,
      baseRevision: input.baseRevision ?? existing?.baseRevision ?? 0,
      remoteRevision: input.remoteRevision ?? existing?.remoteRevision ?? 0,
      dirty: input.dirty ?? existing?.dirty ?? false,
      latestSnapshotId:
        input.latestSnapshotId !== undefined
          ? input.latestSnapshotId
          : (existing?.latestSnapshotId ?? null),
      lastSyncedAt:
        input.lastSyncedAt !== undefined ? input.lastSyncedAt : (existing?.lastSyncedAt ?? null),
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO profile_sync_state
           (profile_id, sync_enabled, local_revision, base_revision, remote_revision,
            dirty, latest_snapshot_id, last_synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           sync_enabled = excluded.sync_enabled,
           local_revision = excluded.local_revision,
           base_revision = excluded.base_revision,
           remote_revision = excluded.remote_revision,
           dirty = excluded.dirty,
           latest_snapshot_id = excluded.latest_snapshot_id,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        merged.profileId,
        merged.syncEnabled ? 1 : 0,
        merged.localRevision,
        merged.baseRevision,
        merged.remoteRevision,
        merged.dirty ? 1 : 0,
        merged.latestSnapshotId,
        merged.lastSyncedAt,
        merged.updatedAt,
      );
    return merged;
  }

  /**
   * Patch selected fields on an existing sync-state row. Creates the row (with
   * defaults) first if it does not exist, so callers never have to branch.
   */
  updateSyncState(id: ProfileId, patch: UpdateProfileSyncStateInput): ProfileSyncState {
    const existing = this.getSyncState(id);
    if (!existing) {
      return this.upsertSyncState({ profileId: id, ...patch });
    }
    const { profileId: _pid, updatedAt: _u, ...rest } = existing;
    void _pid;
    void _u;
    return this.upsertSyncState({ profileId: id, ...rest, ...patch });
  }

  /**
   * Mark a profile's local state dirty (or clean). Convenience wrapper used
   * when the browser has written state that has not yet been published.
   */
  markSyncDirty(id: ProfileId, dirty = true): ProfileSyncState {
    return this.updateSyncState(id, { dirty });
  }

  // ── Cloud Sync: operation journal ──────────────────────────────────────────

  /** Append a sync operation record. Returns the generated operation id. */
  recordSyncOperation(input: RecordSyncOperationInput): SyncOperation {
    const id = uuidv4();
    const now = new Date().toISOString();
    const op: SyncOperation = {
      id,
      profileId: input.profileId,
      kind: input.kind,
      status: input.status,
      fromRevision: input.fromRevision ?? null,
      toRevision: input.toRevision ?? null,
      snapshotId: input.snapshotId ?? null,
      message: input.message ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO sync_operations
           (id, profile_id, kind, status, from_revision, to_revision, snapshot_id, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.profileId,
        op.kind,
        op.status,
        op.fromRevision,
        op.toRevision,
        op.snapshotId,
        op.message,
        op.createdAt,
        op.updatedAt,
      );
    return op;
  }

  /** Update the status/message/revisions of an existing operation. */
  updateSyncOperation(
    opId: string,
    patch: {
      status?: SyncOperationStatus;
      toRevision?: number | null;
      snapshotId?: string | null;
      message?: string | null;
    },
  ): void {
    const row = this.db.prepare(`SELECT * FROM sync_operations WHERE id = ?`).get(opId) as
      | SyncOperationRow
      | undefined;
    if (!row) throw new Error(`Sync operation ${opId} not found`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sync_operations SET status = ?, to_revision = ?, snapshot_id = ?, message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? row.status,
        patch.toRevision !== undefined ? patch.toRevision : row.to_revision,
        patch.snapshotId !== undefined ? patch.snapshotId : row.snapshot_id,
        patch.message !== undefined ? patch.message : row.message,
        now,
        opId,
      );
  }

  /** List recent operations for a profile, newest first. */
  listSyncOperations(id: ProfileId, limit = 50): SyncOperation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sync_operations WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(id, limit) as SyncOperationRow[];
    return rows.map(rowToSyncOperation);
  }

  // ── Cloud Sync: conflict copies ───────────────────────────────────────────

  /**
   * Atomically insert a conflict-copy profile plus its initial sync-state row.
   * Clones the source's metadata (proxy, fingerprint, tags, extensions, icon,
   * startUrl, searchProvider) under a fresh id + dataDir supplied by the caller
   * — the caller is responsible for populating `dataDir` from the conflicting
   * snapshot afterwards (atomic directory orchestration lives above this
   * layer). The copy is created with `dirty = false` and `sync_enabled = false`
   * so it never re-uploads on its own until the user opts in.
   *
   * Runs in a transaction so a failure leaves no half-inserted profile.
   */
  insertConflictProfile(input: InsertConflictProfileInput): Profile {
    if (this.get(input.conflictId)) {
      throw new Error(`Profile ${input.conflictId} already exists`);
    }
    const now = new Date().toISOString();
    const copy: Profile = {
      id: input.conflictId,
      name: input.conflictName,
      notes: input.source.notes,
      tags: [...input.source.tags],
      proxy: input.source.proxy,
      fingerprint: input.source.fingerprint,
      extensions: input.source.extensions ? [...input.source.extensions] : [],
      icon: input.source.icon,
      startUrl: input.source.startUrl,
      searchProvider: input.source.searchProvider,
      dataDir: input.dataDir,
      createdAt: now,
      updatedAt: now,
      proxyCountry: input.source.proxyCountry,
    };

    const tx = this.db.transaction(() => {
      mkdirSync(copy.dataDir, { recursive: true });
      this.db
        .prepare(
          `INSERT INTO profiles
             (id, name, notes, tags, proxy, fingerprint, extensions, icon, start_url, search_provider, data_dir, created_at, updated_at, proxy_country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          copy.id,
          copy.name,
          copy.notes ?? null,
          JSON.stringify(copy.tags),
          copy.proxy ? JSON.stringify(copy.proxy) : null,
          JSON.stringify(copy.fingerprint),
          JSON.stringify(copy.extensions ?? []),
          copy.icon ?? null,
          copy.startUrl ?? null,
          copy.searchProvider ?? null,
          copy.dataDir,
          copy.createdAt,
          copy.updatedAt,
          copy.proxyCountry ?? null,
        );
      this.upsertSyncState({
        profileId: copy.id,
        syncEnabled: false,
        localRevision: input.remoteRevision,
        baseRevision: input.baseRevision,
        remoteRevision: input.remoteRevision,
        dirty: false,
      });
    });
    tx();
    return copy;
  }

  private rowToProfile(row: ProfileRow): Profile {
    return {
      id: row.id,
      name: row.name,
      notes: row.notes ?? undefined,
      tags: JSON.parse(row.tags) as string[],
      proxy: row.proxy ? (JSON.parse(row.proxy) as ProxyConfig) : undefined,
      fingerprint: JSON.parse(row.fingerprint) as FingerprintConfig,
      extensions: normalizeExtensions(row.extensions),
      icon: row.icon ?? undefined,
      startUrl: row.start_url ?? undefined,
      searchProvider: row.search_provider ?? undefined,
      dataDir: row.data_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at ?? undefined,
      proxyCountry: row.proxy_country ?? undefined,
    };
  }
}

/**
 * Parse + normalize the JSON `extensions` column. Back-compat: rows written
 * before the dedup feature lack `scope`/`version`, so default them (legacy
 * per-profile copies → scope "profile", unknown version → ""). This is why the
 * new fields need no SQL migration — the column is additive JSON.
 */
function normalizeExtensions(raw: string | null): ExtensionConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Partial<ExtensionConfig>>).map((e) => ({
    id: e.id ?? "",
    name: e.name ?? "Extension",
    version: e.version ?? "",
    scope: e.scope ?? "profile",
    enabled: e.enabled ?? true,
    dir: e.dir ?? "",
    source: e.source ?? "file",
  }));
}

/** Map a `profile_sync_state` row to the public {@link ProfileSyncState}. */
function rowToSyncState(row: ProfileSyncStateRow): ProfileSyncState {
  return {
    profileId: row.profile_id,
    syncEnabled: row.sync_enabled !== 0,
    localRevision: row.local_revision,
    baseRevision: row.base_revision,
    remoteRevision: row.remote_revision,
    dirty: row.dirty !== 0,
    latestSnapshotId: row.latest_snapshot_id,
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

/** Map a `sync_operations` row to the public {@link SyncOperation}. */
function rowToSyncOperation(row: SyncOperationRow): SyncOperation {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind as SyncOperationKind,
    status: row.status as SyncOperationStatus,
    fromRevision: row.from_revision,
    toRevision: row.to_revision,
    snapshotId: row.snapshot_id,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
