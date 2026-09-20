# Operations Guide

The MVP is a **manual** workflow: each step is an explicit operator action
(IPC/UI trigger). This guide documents the lifecycle, Kopia repository
setup, conflict behavior, failure caveats, orphan snapshots, recovery, and
Kopia licensing.

## The manual workflow

The canonical single-writer lifecycle is:

```
Acquire → Restore → Launch → Close → Backup & Publish → Release
```

Mapped to IPC handlers (`apps/desktop/src/main/sync/registerSyncIpc.ts`) and
`SyncController` methods (`apps/desktop/src/main/sync/SyncController.ts`):

| Step | IPC | Controller method | What it does |
| --- | --- | --- | --- |
| **Acquire** | `sync:acquire` | `acquire()` | `POST /acquire`; installs an in-memory lease with an auto-renew timer (renews at the backend's `recommendedRenewalMs`, min 3 s). |
| **Restore** | `sync:restore` | `restoreLatest(profileId, { keepLocalAsConflict })` | Refuses if browser running. Fetches remote revision; connects Kopia; restores the latest snapshot into **same-volume staging**; atomically swaps into the live data dir with rollback on failure. |
| **Launch** | (browser launch path) | `beforeLaunch()` | For synced profiles, fetches remote state and applies `decideLaunch`: `launch`, `restore-then-launch`, `conflict` (refuse), or `blocked`. Marks the profile **dirty** on a writable launch. |
| **Close** | — | (browser driver exit) | The profile must fully exit before any snapshot; the quiescence guard enforces this. |
| **Backup & Publish** | `sync:backup` | `backupAndPublish()` | Refuses if browser running or lease missing/expired. Writes the sanitized manifest, creates a Kopia snapshot, then `POST /publish` with `expectedRevision = baseRevision` (CAS) + fencing token. Clears `dirty` **only after** the backend accepts. |
| **Release** | `sync:release` | `release()` | Refuses if browser still running. `POST /release` and drops the local lease. |

Supporting operations:

- **Enable/disable per profile** — `sync:enable` → `enable()`. Unsynced profiles
  behave exactly as before (no remote coupling); `beforeLaunch` is a no-op for
  them.
- **Connect existing** — `sync:connectExisting` → `connectExisting()`. Restores
  the latest snapshot for a profile id into a fresh local profile using the
  sanitized manifest (see below).
- **Status / diagnostics / backend check** — `sync:status`,
  `sync:diagnostics`, `sync:checkBackend`.

### Ordering rules enforced in code

- **Never snapshot a running browser.** `backupAndPublish`, `restoreLatest`, and
  `release` all throw `BrowserStillRunning` if the profile's Chromium is
  running; the Kopia adapter additionally calls `assertQuiescent` before
  snapshot/restore (`packages/kopia-adapter/src/adapter.ts`).
- **Publish requires an owned, unexpired lease.** Missing/expired lease →
  `LeaseHeldByOther`.
- **`dirty` clears only after a successful publish** — a failed or rejected
  publish leaves the profile dirty so nothing is silently lost.

## Kopia repository: initialize on first Mac vs connect on second

The Kopia repository is created **once** and then connected to from every other
Mac. Both flows target the same S3/R2 bucket + prefix and use the **same shared
repository password**.

| | First Mac (repository does not exist yet) | Second (and subsequent) Mac |
| --- | --- | --- |
| Kopia command | `kopia repository create s3 …` (`buildCreateArgs`) | `kopia repository connect s3 …` (`buildConnectArgs`) |
| Adapter method | `KopiaAdapter.createRepository(target)` | `KopiaAdapter.connect(target)` |
| Password | Sets the repository password (encryption root) | Must supply the **same** password |
| Result | New encrypted repository initialized in the bucket | Local Kopia config connected to the existing repository |

> **MVP note.** In **Settings → Cloud Sync**, use **First-run: initialize
> repository** exactly once on the primary Mac. That action calls
> `SyncController.initializeRepository()` and `KopiaAdapter.createRepository()`.
> Backup, restore, and Connect Existing use `kopia.connect(...)` automatically.
> Do not initialize again on Mac B; connecting before Mac A initializes the
> repository fails safely at the Kopia layer.

Every Kopia invocation carries `--no-persist-credentials`
(`packages/kopia-adapter/src/commands.ts`), which is supported and exercised
against the pinned 0.23.1 binary. Kopia 0.23.1 does not expose the newer
`use-keyring` or `auto-maintenance` global flags, so MultiZen does not emit
unsupported options. Repository-wide maintenance and retention remain explicit
operator tasks for the multi-client MVP.

### Shared repository password provisioning

The repository password is the encryption root and must be **identical on every
Mac** connecting to the repository.

1. Choose a strong repository password **once**, out of band (e.g. a shared
   password manager entry the operators control).
2. On each Mac, store it in the Keychain vault via `sync:saveSecret` with
   `kind = "kopiaPassword"`. It is injected as `KOPIA_PASSWORD` for Kopia and
   never written to argv, settings, or the Kopia config file.
3. If the password is missing, `loadKopiaSecrets()` throws
   `"Kopia repository password is not set"` before any Kopia call runs.

## Conflict-copy behavior

MultiZen **never merges** Chromium state. On divergence it **keeps both**.

- The launch gate (`decideLaunch`) and the direct Backup & Publish path both use
  the same pure policy (`packages/sync-core/src/decisions.ts`). A true
  divergence — local `dirty` **and** remote advanced past this device's
  `baseRevision` — is reported as `conflict` / `ConflictDetected` and the
  operation is refused.
- Resolution is **Restore with keep-local-as-conflict**:
  `restoreLatest(profileId, { keepLocalAsConflict: true })`. Before the canonical
  restore overwrites the live data, the current dirty local data is copied into a
  new **unsynced conflict-copy profile** (`preserveConflictCopy`), rolled back on
  failure so no orphaned directory is left.
- Conflict copies are named deterministically, e.g.
  `"Amazon US" → "Amazon US - Conflict - Mac Studio"` (`conflictCopyName`,
  using the device display name).
- Neither copy is ever automatically destroyed. The operator inspects, renames,
  or deletes copies afterward.

## Failure caveats: lease loss, sleep, crash

- **Lease renewal failure / loss.** If a renewal fails, `onLeaseLost` drops the
  local lease and, if a synced browser is open under it, **closes that browser**
  and emits a redacted error. This prevents a stale owner from later publishing
  over a newer revision.
- **OS sleep / power suspend.** `onPowerSuspend` drops **all** leases and closes
  owned synced browsers, since a suspended Mac cannot renew within the 45 s
  lease TTL.
- **App or Chromium crash.** The in-memory lease is lost on process exit; the
  backend lease expires after its TTL (default 45 s), after which another Mac can
  acquire. On restart, `beforeLaunch` re-fetches remote state and applies the
  decision policy. Because `dirty` only clears after a successful publish, a crash
  mid-workflow leaves the profile marked dirty and safe.
- **Stale-owner protection.** Even if a device's clock or connectivity recovers,
  its fencing token is stale after another device took over; the backend rejects
  the publish (`FENCING_TOKEN_INVALID`) and CAS rejects a mismatched
  `expectedRevision` (`REVISION_CONFLICT`).

## Orphan snapshots

Because Backup & Publish is two phases — (1) create the Kopia snapshot in
R2/S3, then (2) publish the revision to the backend — a failure **between** the
two phases can leave an **orphan snapshot**: bytes exist in the repository but no
revision references them.

- This is safe: an orphan snapshot is never selected for restore (restore uses
  `latestSnapshotId` from the **published** backend state), and it does not
  corrupt local state (`dirty` stays set, so a later publish retries cleanly).
- Orphans consume storage until cleaned up. The MVP disables Kopia
  auto-maintenance, so orphan cleanup / retention pruning is an **operator task**
  (run Kopia maintenance/snapshot management out of band against the repository).
  Automated retention is a [deferred feature](./acceptance.md#deferred-features).
- Idempotency reduces duplicate orphans: mutating backend calls are keyed by
  `operationId` and replay the stored result on retry.

## Recovery & rollback

- **Restore is atomic with rollback.** `restoreLatest` restores into a
  **same-volume** staging dir, verifies same-volume before swapping, then uses
  `atomicSwap` (staging → live, previous live → backup). On any failure the swap
  rolls back; on success the backup dir is discarded best-effort
  (`apps/desktop/src/main/sync/SyncController.ts`, `packages/kopia-adapter/swap.ts`).
- **Failed publish.** Leaves `dirty` set and the profile at its previous
  revision; re-run Backup & Publish once the cause (auth, network, conflict) is
  resolved.
- **Rebuild a device from scratch.** Use **Connect existing** to restore a
  profile's latest published snapshot into a fresh local profile; proxy
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
  independent from the browser engine and keeps Kopia replaceable — consistent
  with the plan's licensing due-diligence.
- Kopia v0.23.1 is **downloaded and bundled by macOS build scripts**, but the
  binary itself is not committed. `apps/desktop/scripts/kopia/prepare-kopia.mjs`
  selects the arm64 or x64 release archive, verifies the official pinned
  SHA-256 before extraction, verifies `kopia --version`, and places the
  executable plus Apache-2.0 license/provenance notice under
  `resources/kopia/`. Electron Builder copies that directory to packaged
  `<resourcesPath>/kopia`, and the after-pack hook signs the nested executable.
  Development resolution remains: explicit `settings.sync.kopiaBinPath` →
  `MULTIZEN_KOPIA_BIN` → packaged `<resourcesPath>/kopia/kopia` → `kopia` on
  `PATH` (`apps/desktop/src/main/sync/kopiaFactory.ts`).
- The reproducible pin lives in
  `apps/desktop/scripts/kopia/kopiaAssets.mjs`: version 0.23.1, official asset
  names, and separate arm64/x64 checksums. Updating Kopia requires changing all
  pin metadata together and re-running packaging tests; a checksum mismatch
  aborts before extraction.

## Diagnostics

`sync:diagnostics` (`SyncController.diagnostics()`) returns a **secret-free**
snapshot for support: `enabled`, `configured` (worker URL + client id present),
per-secret **presence booleans**, last backend health, `deviceId`,
`deviceDisplayName`, and the resolved Kopia binary path. Combine with
`sync:status` per profile (`syncEnabled`, `dirty`, `localRevision`,
`baseRevision`, `remoteRevision`, `latestSnapshotId`, `hasLease`,
`leaseExpiresAt`, `running`) when triaging.
