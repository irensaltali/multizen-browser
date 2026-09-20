# Operations Guide

The MVP is a **manual** workflow: each step is an explicit operator action
(IPC/UI trigger). Coordination is storage-native — there is **no backend**; the
desktop drives an in-process `S3Coordinator` that reads and CAS-writes a single
`state.json` per profile in the bucket (see [architecture.md](./architecture.md)).
This guide documents the lifecycle, Kopia repository setup, conflict behavior,
failure caveats, orphan snapshots, recovery, and Kopia licensing.

## The manual workflow

The canonical single-writer lifecycle is:

```
Acquire → Restore → Launch → Close → Backup & Publish → Release
```

Mapped to IPC handlers (`apps/desktop/src/main/sync/registerSyncIpc.ts`) and
`SyncController` methods (`apps/desktop/src/main/sync/SyncController.ts`):

| Step | IPC | Controller method | What it does |
| --- | --- | --- | --- |
| **Acquire** | `sync:acquire` | `acquire()` | Coordinator `acquire` (CAS on `state.json`); installs an in-memory lease with an auto-renew timer (renews at the recommended interval, min 3 s). |
| **Restore** | `sync:restore` | `restoreLatest(profileId, { keepLocalAsConflict })` | Refuses if browser running. Reads remote state; connects Kopia; restores the latest snapshot into **same-volume staging**; atomically swaps into the live data dir with rollback on failure. |
| **Launch** | (browser launch path) | `beforeLaunch()` | For synced profiles, reads remote state and applies `decideLaunch`: `launch`, `restore-then-launch`, `conflict` (refuse), or `blocked`. Marks the profile **dirty** on a writable launch. |
| **Close** | — | (browser driver exit) | The profile must fully exit before any snapshot; the quiescence guard enforces this. |
| **Backup & Publish** | `sync:backup` | `backupAndPublish()` | Refuses if browser running or lease missing/expired. Writes the sanitized manifest, creates a Kopia snapshot, then coordinator `publish` with `expectedRevision = baseRevision` (CAS) + fencing token. Clears `dirty` **only after** the publish CAS commits. |
| **Release** | `sync:release` | `release()` | Refuses if browser still running. Coordinator `release` (clears ownership in `state.json`, never deletes it) and drops the local lease. |

Supporting operations:

- **Enable/disable per profile** — `sync:enable` → `enable()`. Unsynced profiles
  behave exactly as before; `beforeLaunch` is a no-op for them.
- **Connect existing** — `sync:connectExisting` → `connectExisting()`. Restores
  the latest snapshot for a profile id into a fresh local profile using the
  sanitized manifest (see below).
- **Test storage coordination** — `sync:testCoordination` →
  `testStorageCoordination()`. Store reachability **plus a forced
  conditional-write capability probe**; must pass before writable operations run.
- **First-run repository init** — `sync:initializeRepository` →
  `initializeRepository()`. Primary-Mac-only Kopia repository creation.
- **Status / diagnostics** — `sync:status`, `sync:diagnostics`,
  `sync:exportDiagnostics`.

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

## Kopia repository: initialize on first Mac vs connect on second

The Kopia repository is created **once** and then connected to from every other
Mac. Both flows target the same S3/R2 bucket + Kopia prefix and use the **same
shared repository password**.

| | First Mac (repository does not exist yet) | Second (and subsequent) Mac |
| --- | --- | --- |
| Kopia command | `kopia repository create s3 …` (`buildCreateArgs`) | `kopia repository connect s3 …` (`buildConnectArgs`) |
| Adapter method | `KopiaAdapter.createRepository(target)` | `KopiaAdapter.connect(target)` |
| Password | Sets the repository password (encryption root) | Must supply the **same** password |
| Result | New encrypted repository initialized in the bucket | Local Kopia config connected to the existing repository |

> **MVP note.** In **Settings → Cloud Sync**, use **First-run: initialize
> repository** exactly once on the primary Mac. That action calls
> `SyncController.initializeRepository()` → `KopiaAdapter.createRepository()`.
> Backup, restore, and Connect Existing use `kopia.connect(...)` automatically.
> Do not initialize again on Mac B; connecting before Mac A initializes the
> repository fails safely at the Kopia layer.

Every Kopia invocation carries `--no-persist-credentials`
(`packages/kopia-adapter/src/commands.ts`), the **only** credential-hardening
flag emitted, exercised against the pinned 0.23.1 binary. Kopia 0.23.1 does not
expose the newer `use-keyring` or `auto-maintenance` global flags, so MultiZen
does not emit them. **Auto-maintenance is therefore left at Kopia's default —
MultiZen does not programmatically disable it.** Repository-wide maintenance and
retention are explicit operator responsibilities for the multi-client MVP.

### Shared repository password provisioning

The repository password is the encryption root and must be **identical on every
Mac** connecting to the repository.

1. Choose a strong repository password **once**, out of band (e.g. a shared
   password manager entry the operators control).
2. On each Mac, store it in the Keychain vault via `sync:saveSecret` with
   `kind = "kopiaPassword"`. It is injected as `KOPIA_PASSWORD` for Kopia and
   never written to argv, settings, or the Kopia config file.
3. If the password is missing, `loadKopiaSecrets()` throws before any Kopia call
   runs.

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
