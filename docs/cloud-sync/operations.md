# Operations Guide

Cloud Sync is **automatic and whole-library**. The operator does not press lease
buttons in the normal workflow. Coordination is storage-native — there is **no
backend**; the desktop drives an in-process `S3Coordinator` that reads and
CAS-writes a single `state.json` per profile in the bucket (see
[architecture.md](./architecture.md)). This guide documents the automatic
library bootstrap, the normal per-profile lifecycle, the destructive per-profile
remote-disable (delete), Kopia repository setup, conflict behavior, failure
caveats, recovery, and Kopia licensing.

## Automatic whole-library sync

**Readiness.** Cloud Sync becomes ready when the global switch is on and the
bucket, S3 key pair, and encryption password are present. At startup—and when
the final required setting or secret is saved—the desktop automatically runs a
single-flight S3 health/conditional-write capability probe. If it succeeds,
whole-library synchronization starts immediately; pressing **Test S3
connection** is optional diagnostics, not a prerequisite. **Sync all** repeats
the probe and bootstrap on demand.

**Library bootstrap (single-flight).** At app startup and whenever configuration
becomes complete, the desktop runs `SyncController.autoBootstrap()`: one shared
probe followed by `maybeBootstrap()`. Concurrent triggers join the same work,
and an unchanged readiness fingerprint is a no-op (an explicit **Sync all**
forces a re-run). The bootstrap:

1. Lists committed, non-tombstoned remote profiles (`coordinator.listProfiles`).
2. Sequentially **restores every remote profile that is missing locally** into a
   fresh local profile, using a **temporary lease acquired then released** after
   each restore (bulk restore never holds every profile's lease, and never
   steals an active peer lease). It never overwrites a dirty same-id local
   profile. For profiles already present locally, a clean copy behind remote is
   restored, a dirty copy is published only when its base still matches remote,
   and divergence is reported as a conflict. Per-profile failures are recorded
   and the run continues (idempotent retry).
3. **Backfills** sync-state so every local profile is `syncEnabled` (a profile a
   user explicitly disabled is preserved — backfill only fills a missing row).
4. Synchronizes every non-running local profile: local-only/never-published and
   dirty existing profiles upload through temporary acquire → backup → release;
   clean existing profiles behind remote restore the latest committed snapshot.
   **Running profiles defer** until browser close. No dirty local state is
   overwritten and no publish can bypass revision/fencing checks.

The renderer's **Sync Settings → Whole-library sync** panel shows the summary
(discovered / restored / uploaded / deferred / reconciled / failed, plus a
truncation warning) and a **Sync all** button to re-run on demand.

## The normal per-profile lifecycle (no manual lease buttons)

Once the library is bootstrapped, each profile follows this automatic lifecycle:

```
Launch (auto-acquire + conflict-checked restore) → Close → (automatic Backup & Publish) → auto-Release
```

Mapped to IPC handlers (`apps/desktop/src/main/sync/registerSyncIpc.ts`) and
`SyncController` methods (`apps/desktop/src/main/sync/SyncController.ts`):

| Step | IPC | Controller method | What it does |
| --- | --- | --- | --- |
| **Launch** | (browser launch path) | `beforeLaunch()` | For a synced profile: awaits any in-flight close-triggered backup, then **auto-acquires** an owned lease if one is not already held (`ensureLeaseForLaunch`; `acquire` fails closed against an active peer lease — never steals it), reads remote state, and applies `decideLaunch` (`launch`, `restore-then-launch`, `conflict` refuse, or `blocked`). Marks the profile **dirty** on a writable launch. Global-off launches skip all of this and just mark dirty locally. |
| **Close** | — | (browser driver `running-changed` → `closed`) | The profile must fully exit before any snapshot (quiescence guard). On close, `onBrowserClosed()` fires and starts the automatic backup when its preconditions hold. Only the `closed` event triggers this — transitional `closing` does not. |
| **Backup & Publish + auto-Release** | `sync:backup` (manual retry) | `onBrowserClosed()` → `runAutoBackup()` → `backupAndPublishInternal()` | Runs automatically after close when: not disposed/suppressed, global sync on, profile sync on, profile **dirty**, an unexpired lease held, and the browser gone. Writes the sanitized manifest, creates a Kopia snapshot, then coordinator `publish` with `expectedRevision = baseRevision` (CAS) + fencing token; clears `dirty` **only after** the CAS commits. **On success the lease is auto-released.** On failure the profile stays **dirty**, the failure is journaled + logged (secret-redacted), and the **lease is kept** for a retry on the next launch/close. A manual "Back up now" (`sync:backup`) joins any in-flight auto backup rather than double-publishing. |

**Advanced / retry tools (fallbacks, not the normal path).** `sync:acquire`,
`sync:restore`, `sync:backup`, `sync:release`, and single-profile
`sync:connectExisting` remain available (tucked behind an "Advanced" disclosure
in the UI) purely to retry after a failure.

Close events that intentionally **skip** the automatic backup (strict no-op,
never contacting Kopia/storage):

- **Clean profile** (nothing to publish) or **unsynced/global-off** profiles.
- **No lease / expired lease** on this device — including **lease-loss** and
  **power-suspend** closes, which drop the lease *before* closing the browser.
- **Global-disable forced closes** — `stopCoordination` suppresses auto backup
  while it releases the leases itself.

At **app shutdown**, `before-quit` runs `closeAll()` (which fires the `closed`
events and starts any auto backups) *before* `controller.shutdown()`;
`shutdown()` awaits all in-flight auto backups before clearing leases and
exiting, so a close-triggered publish is never truncated.

## Destructive per-profile remote-disable (delete the cloud backup)

Unchecking **"Sync this profile"** is **not** a local flag flip — it deletes the
profile's cloud backup. The renderer requires a **strong typed confirmation**:
the operator must type the profile's exact **name** (or its exact **id** when the
name is empty or ambiguous) before any IPC call is made. No exact match → no
call.

`SyncController.disableProfileSyncAndDeleteRemote(profileId)`
(`sync:disableAndDeleteRemote`) then, serialized per profile and fail-closed:

1. Requires global sync on, the profile present + currently sync-enabled, and the
   **browser closed**; waits for any in-flight close backup.
2. Acquires + validates ownership of the coordination lease (never steals an
   active peer lease).
3. Writes the **durable tombstone first** (`coordinator.tombstoneProfile`) —
   the authoritative logical deletion that fences all peers of the current
   generation and hides the profile from `listProfiles`. Best-effort strict
   cleanup of that profile's revision-history control objects.
4. Deletes **only that profile's Kopia snapshot manifests** through the adapter
   (`kopia.deleteProfileSnapshots`; list-once-then-delete-exact-ids, idempotent
   no-op when none exist).
5. **Only after** the logical deletion sufficiently succeeds, sets local
   `syncEnabled = false`. The **local profile and its data dir are kept**.
6. Releases the lease (always, even on failure).

**Fail-closed + idempotent.** If any step fails, local sync stays **enabled**
(no local disable) so a retry re-runs the whole flow; progress is journaled and
logged secret-redacted. Re-checking the profile calls
`reEnableProfileSync` (`sync:reEnable`) which **revives a fresh generation**
(`coordinator.reviveProfile`), marks the profile dirty, and resets its revision
line so it uploads as a brand-new backup.

**Erasure semantics (important).** This is an **immediate logical deletion**: the
tombstone + snapshot-manifest removal make the profile unrecoverable through
normal sync and invisible to discovery. Physical reclamation of shared,
deduplicated storage chunks is **eventual** — it happens during Kopia
maintenance GC (`kopia.runMaintenance`, never auto-invoked here). There is **no
claim of immediate byte-level erasure**.

Supporting operations:

- **Test S3 connection** — `sync:testCoordination` →
  `testStorageCoordination()`. Store reachability **plus a forced
  conditional-write capability probe**; must pass before writable operations run.
  A successful probe can flip readiness and trigger the library bootstrap.
- **Sync all** — `sync:syncAll` → `syncAll()`. Runs a fresh probe, then a forced
  library bootstrap.
- **Bootstrap status** — `sync:bootstrapStatus` → `bootstrapStatus()`.
- **Status / diagnostics** — `sync:status`, `sync:diagnostics`,
  `sync:exportDiagnostics`.

> **No manual first-run step.** There is no separate "initialize repository"
> action or IPC. The encrypted storage is created automatically the first time a
> device runs **Backup & Publish** (see below). Every other flow — restore,
> connect-existing, subsequent backups — only ever *connects* to the existing
> encrypted storage and never creates an empty one.

### Ordering rules enforced in code

- **Never snapshot a running browser.** `backupAndPublish`, `restoreLatest`, and
  `release` throw `BrowserStillRunning` if the profile's Chromium is running; the
  Kopia adapter additionally calls `assertQuiescent` before snapshot/restore
  (`packages/kopia-adapter/src/adapter.ts`).
- **Publish requires an owned, unexpired lease.** Missing/expired/mismatched
  lease → `LeaseHeldByOther` / `LeaseExpired` / `LeaseFenced`
  (`coordinator.ts::requireOwner`).
- **`dirty` clears only after a successful publish** — a failed or rejected
  publish leaves the profile dirty so nothing is silently lost.

## Automatic encrypted storage setup: create on first Backup, connect thereafter

There is **no manual initialization step**. The encrypted storage is set up
automatically by the **first Backup & Publish**, which calls
`KopiaAdapter.ensureRepository(target)`
(`apps/desktop/src/main/sync/SyncController.ts`,
`packages/kopia-adapter/src/adapter.ts`) before creating the first snapshot. All
devices use the **same encryption password** (the encryption root) and target
the same S3/R2 bucket + backup-data prefix.

`ensureRepository` is **connect-first and create-only-when-provably-empty**:

1. It first attempts `kopia repository connect`. If an existing encrypted
   repository is found, it returns `{ created: false }` — **nothing is
   initialized**.
2. It creates a new repository **only** when connect fails with *exactly* the
   pinned Kopia 0.23.1 `repository not initialized in the provided storage`
   condition, matched by the tight predicate `isRepositoryNotInitialized`
   (`packages/kopia-adapter/src/ensure-repository.ts`). On successful create it
   returns `{ created: true }` and the device stays connected.
3. **Auth, network, corruption, and wrong-password errors never trigger
   creation.** Any error other than the exact missing-repository condition
   propagates unchanged, so a transient or credential failure can never cause an
   empty repository to be created over real data.
4. A **concurrent creation race** (another device created the repository between
   this device's connect and create) is resolved by **one safe reconnect**: if
   the create fails because the repository now already exists, `ensureRepository`
   reconnects once and returns `{ created: false }`.

| | First device to Backup & Publish | Every subsequent device / backup |
| --- | --- | --- |
| Trigger | First `sync:backup` → `ensureRepository` | Backup, Restore, Connect Existing → `ensureRepository` / `connect` |
| Underlying Kopia | connect fails "not initialized" → `kopia repository create s3 …` (`buildCreateArgs`) | `kopia repository connect s3 …` (`buildConnectArgs`) |
| Encryption password | Sets the encryption root | Must supply the **same** encryption password |
| Result | New encrypted repository created, device left connected | Connected to the existing repository; never creates an empty one |

**Restore and Connect Existing only ever connect** — they never create an empty
repository. If they run before any device has published, the connect fails
safely at the Kopia layer (the repository does not yet exist) rather than
silently initializing empty storage.

> **Product UI naming.** The normal UI has **no Kopia branding**. The Settings
> screen exposes an **Encryption password** and a **Backup data prefix**, and
> the storage is described as **automatic encrypted storage setup** on first
> backup. The Kopia-level details in this doc are internal implementation notes
> for operators/developers.

Every Kopia invocation carries `--no-persist-credentials`
(`packages/kopia-adapter/src/commands.ts`), the **only** credential-hardening
flag emitted, exercised against the pinned 0.23.1 binary. Kopia 0.23.1 does not
expose the newer `use-keyring` or `auto-maintenance` global flags, so MultiZen
does not emit them. **Auto-maintenance is therefore left at Kopia's default —
MultiZen does not programmatically disable it.** Repository-wide maintenance and
retention are explicit operator responsibilities for the multi-client MVP.

### Shared encryption password provisioning

The encryption password is the encryption root and must be **identical on every
Mac** connecting to the repository.

1. Choose a strong encryption password **once**, out of band (e.g. a shared
   password manager entry the operators control).
2. On each Mac, store it in the Keychain vault via `sync:saveSecret` with
   `kind = "kopiaPassword"`. It is injected as `KOPIA_PASSWORD` for Kopia and
   never written to argv, settings, or the Kopia config file.
3. The **Test S3 connection** action does not load or require this password; it
   validates only S3 reachability, authorization, and conditional writes. Save
   the password before the first Backup & Publish or before any restore. If it
   is missing, `loadKopiaSecrets()` throws before any backup process runs.

### S3 connection-test troubleshooting

A failed test shows both `failedCheck` and its redacted reason in Settings. The
main-process terminal also logs a `[Cloud Sync] S3 connection test failed`
record containing only the sanitized endpoint origin, region, bucket, control
prefix, health result, failed check, and redacted message. It never logs S3
keys, the encryption password, URL userinfo/query data, request headers, or SDK
configuration.

Common categories are:

- `unconfigured`: bucket or S3 key pair is missing;
- `unreachable` with `AuthFailed`: credentials or bucket permissions were rejected;
- `unreachable` with `Unreachable`: DNS, TCP/TLS, timeout, or provider 5xx failure;
- `create` with `NotFound: bucket not found`: the configured bucket does not exist;
- `duplicate-create-precondition`, `cas`, or `stale-cas-precondition`: the endpoint
  does not implement the conditional-write semantics required for safe leases.

A successful S3 test does not exercise encrypted backup storage and therefore
does not validate the encryption password.

## Global Enable Cloud Sync switch

A single **Enable Cloud Sync** master switch (`SyncConfig.enabled`, toggled via
`sync:updateConfig`) gates all coordinated operations:

- **When off**, the coordinated operations refuse: enabling a profile,
  Acquire/Restore/Backup/Release, and Connect Existing all require the global
  switch (`SyncController.requireGlobalEnabled`). A **local browser launch is
  still allowed** — `beforeLaunch` short-circuits without contacting storage or
  requiring a lease — but any **sync-enabled profile is conservatively marked
  `dirty`** so re-enabling later can never silently overwrite the local changes
  made while the feature was off.
- **When turned off** (true→false transition), the controller safely winds down
  coordination **before** committing the disabled state: it closes any running
  profiles whose leases this controller holds and best-effort **releases those
  leases** (`stopCoordination`), so disabling never leaves a stale owner holding
  a lease (split brain).
- **When on**, a writable launch of a synced profile still requires an owned,
  unexpired lease (`requireOwnedLease`) before any remote fetch or restore
  decision.



## Conflict-copy behavior

MultiZen **never merges** Chromium state. On divergence it **keeps both**.

- The launch gate (`decideLaunch`) and the Backup & Publish path use the same
  pure policy (`packages/sync-core/src/decisions.ts`). A true divergence — local
  `dirty` **and** remote advanced past this device's `baseRevision` — is reported
  as `conflict` / `ConflictDetected` and the operation is refused.
- Resolution is **Restore with keep-local-as-conflict**:
  `restoreLatest(profileId, { keepLocalAsConflict: true })`. Before the canonical
  restore overwrites the live data, the current dirty local data is copied into a
  new **unsynced conflict-copy profile** (`preserveConflictCopy`), rolled back on
  failure so no orphaned directory is left.
- Conflict copies are named deterministically, e.g.
  `"Amazon US" → "Amazon US - Conflict - Mac Studio"` (`conflictCopyName`, using
  the device display name).
- Neither copy is ever automatically destroyed. The operator inspects, renames,
  or deletes copies afterward.

## Failure caveats: lease loss, sleep, crash

- **Lease renewal failure / loss.** If a renewal fails, `onLeaseLost` drops the
  local lease and, if a synced browser is open under it, **closes that browser**
  and emits a redacted error. This prevents a stale owner from later publishing
  over a newer revision.
- **OS sleep / power suspend.** `onPowerSuspend` drops **all** leases and closes
  owned synced browsers, since a suspended Mac cannot renew within the lease TTL.
- **App or Chromium crash.** The in-memory lease is lost on process exit; the
  lease in `state.json` expires after its TTL (default 60 s), after which another
  Mac can acquire — but only past the clock-skew safety margin (default 10 s) so
  a slightly-skewed peer cannot take over too early
  (`coordinator.ts::takeoverAllowed`). On restart, `beforeLaunch` re-reads remote
  state and applies the decision policy. Because `dirty` only clears after a
  successful publish, a crash mid-workflow leaves the profile marked dirty and
  safe.
- **Stale-owner protection.** Even if a device's clock or connectivity recovers,
  its fencing token is stale after another device took over; `publish` is
  rejected (`LeaseFenced`) and expected-revision CAS rejects a mismatched
  revision (`PublishRejected`).

## Orphan snapshots

Because Backup & Publish is two phases — (1) create the Kopia snapshot in R2/S3,
then (2) commit the revision via CAS on `state.json` — a failure **between** the
two phases can leave an **orphan snapshot**: bytes exist in the repository but no
revision references them.

- This is safe: an orphan snapshot is never selected for restore (restore uses
  `latestSnapshotId` from the **committed** `state.json`), and it does not corrupt
  local state (`dirty` stays set, so a later publish retries cleanly).
- Orphans consume storage until cleaned up. MultiZen does **not** disable Kopia
  auto-maintenance and does not run maintenance for you, so orphan cleanup /
  retention pruning is an **operator task** — run Kopia maintenance / snapshot
  management out of band against the repository. Automated retention is a
  [deferred feature](./acceptance.md#deferred-features).
- Idempotency reduces duplicate side effects: mutating coordinator calls are keyed
  by `operationId` in `state.json`'s `lastOperation`, and a replay reconstructs
  the accepted result without a second revision/fencing increment.

## Recovery & rollback

- **Restore is atomic with rollback.** `restoreLatest` restores into a
  **same-volume** staging dir, verifies same-volume before swapping, then uses
  `atomicSwap` (staging → live, previous live → backup). On any failure the swap
  rolls back; on success the backup dir is discarded best-effort
  (`SyncController.ts`, `packages/kopia-adapter/swap.ts`).
- **Failed publish.** Leaves `dirty` set and the profile at its previous
  revision; re-run Backup & Publish once the cause (auth, storage reachability,
  conflict) is resolved.
- **Rebuild a device from scratch.** Use **Connect existing** to restore a
  profile's latest committed snapshot into a fresh local profile; proxy
  credentials are re-entered by the operator (they are excluded from the
  manifest).
- **Point-in-time restore** to an older revision is **not** a first-class MVP
  action (the app restores `latestSnapshotId`). Older snapshots remain in the
  Kopia repository and can be restored with the Kopia CLI directly by an
  operator. First-class version history is [deferred](./acceptance.md#deferred-features).

## Pinned Kopia licensing

- Kopia is licensed under **Apache-2.0**. MultiZen **invokes the Kopia CLI as a
  separate process** (never links it in-process) and injects secrets via the
  environment only (`packages/kopia-adapter/`), which keeps the sync subsystem
  independent from the browser engine and keeps Kopia replaceable.
- Kopia v0.23.1 is **downloaded and bundled by macOS build scripts**, but the
  binary itself is not committed. `apps/desktop/scripts/kopia/prepare-kopia.mjs`
  selects the arm64 or x64 release archive, verifies the official pinned SHA-256
  before extraction, verifies `kopia --version`, and places the executable plus
  Apache-2.0 license/provenance notice under `resources/kopia/`. Electron Builder
  copies that directory to packaged `<resourcesPath>/kopia`, and the after-pack
  hook signs the nested executable. Development resolution:
  `settings.sync.kopiaBinPath` → `MULTIZEN_KOPIA_BIN` → packaged
  `<resourcesPath>/kopia/kopia` → `kopia` on `PATH`
  (`apps/desktop/src/main/sync/kopiaFactory.ts`).
- The reproducible pin lives in `apps/desktop/scripts/kopia/kopiaAssets.mjs`:
  version 0.23.1, official asset names, and separate arm64/x64 checksums.
  Updating Kopia requires changing all pin metadata together and re-running
  packaging tests; a checksum mismatch aborts before extraction.

## Diagnostics

`sync:diagnostics` (`SyncController.diagnostics()`) returns a **secret-free**
snapshot for support: `enabled`, `configured` (a storage bucket is present),
per-secret **presence booleans**, last store-health probe, last conditional-write
capability result, the bucket + control prefix, `deviceId`, `deviceDisplayName`,
and the resolved Kopia binary path. `sync:exportDiagnostics` adds a non-secret
storage summary (endpoint/region/bucket/control/Kopia prefixes, credentials-present
boolean, last error) and per-profile slices. Combine with `sync:status` per
profile (`syncEnabled`, `dirty`, `localRevision`, `baseRevision`,
`remoteRevision`, `latestSnapshotId`, `hasLease`, `leaseExpiresAt`, `running`)
when triaging. None of these ever contain a secret value or SDK credentials.
