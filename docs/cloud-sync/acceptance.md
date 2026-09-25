# Acceptance & Failure Matrix

This is the exact acceptance checklist for the two-Mac Cloud Sync feature, the
failure matrix operators should verify, and the explicit list of deferred
features. Coordination is storage-native — there is **no backend to stand up**.
Sync is **whole-library and automatic**: once Cloud Sync is ready, the library
bootstrap restores missing profiles and uploads local changes, launches
auto-acquire leases, and closes publish + auto-release (see the workflow in
[operations.md](./operations.md)). The Acquire / Restore / Back up now / Release
buttons and single-profile connect remain as **advanced retry fallbacks**.

> **Live acceptance requires operator credentials and hardware.** The two-Mac
> checklist below needs two physical/logical Macs, a **private R2/S3 bucket**,
> and **per-device S3 credentials**. There is **no Worker, no Durable Object,
> and no cloud compute** to deploy. It has **not** been executed while authoring
> this documentation. Run it in your own environment and record results.

## Prerequisites for acceptance

- A private R2/S3 (or capability-verified generic S3) bucket; see
  [deployment.md](./deployment.md).
- **Per-device** least-privilege S3 API credentials — one credential per Mac,
  scoped to the bucket/prefixes. The **same** credential authenticates both the
  Kopia data plane and the coordination control plane.
- **Test S3 connection passes on each Mac**: store reachable **and** the
  forced conditional-write capability probe succeeds
  (`StorageTestResult.conditionalWritesSupported == true`).
- Separate Kopia object prefix (`s3Prefix`, shown as **Backup data prefix** in
  the UI) and coordination control prefix (`controlPrefix`) — the app rejects a
  control prefix that nests inside the Kopia prefix.
- The same **encryption password** (shown as **Encryption password** in the UI)
  saved on every Mac. The encrypted storage is created **automatically** by the
  first Backup & Publish — there is **no separate initialize step**.
- On each Mac: sync config filled in and all three secrets present in the vault
  (`sync:diagnostics.secretsPresent` all `true`).

## Two-Mac acceptance checklist

Label the machines **Mac A** and **Mac B**. Use one shared test profile with a
site that persists a login/cookie.

1. **Storage bring-up**
   - [ ] Each Mac: **Test S3 connection** passes (health + conditional
         writes). Confirm `conditionalWritesSupported == true`.
   - [ ] Each Mac: save the **same encryption password** and its **own** S3
         credentials. No manual "initialize repository" step exists.

2. **First publish from Mac A** (verifies **automatic creation** on Mac A)
   - [ ] Mac A: with Cloud Sync ready, the profile is sync-enabled by default
         (new profiles seed `syncEnabled=true`; existing ones are backfilled by
         the library bootstrap). Confirm `sync:status.syncEnabled == true`.
   - [ ] Mac A: **Launch** the profile — `beforeLaunch` **auto-acquires** the
         lease (no manual Acquire); `sync:status.hasLease` is true and a
         `state.json` now exists under `<controlPrefix>/profiles/<id>/`.
   - [ ] Mac A: log in to the test site, then **Close** the browser fully.
         Closing triggers **Backup & Publish automatically**, and on success the
         lease is **auto-released** — no button press is needed in the normal
         flow. The first backup **automatically creates the encrypted
         repository** via `KopiaAdapter.ensureRepository`. Confirm objects appear
         under the Kopia prefix, and status shows `dirty=false`,
         `localRevision == baseRevision == remoteRevision` bumped, a non-null
         `latestSnapshotId`, and `hasLease=false` after the auto-release.

3. **Move to Mac B** (verifies the **library bootstrap** — no manual connect)
   - [ ] Mac B: once Cloud Sync is ready, the **library bootstrap** runs at
         startup / on readiness and **automatically restores** the profile that
         exists only remotely (equivalently press **Sync all**, or use the
         advanced single-profile connect). It **connects** to Mac A's repository;
         it never creates an empty one, and never overwrites same-id local data.
   - [ ] Mac B: after the bootstrap, the profile is present locally with the same
         revision as Mac A and `dirty=false`.
   - [ ] Mac B: **Launch** — the test site is **still logged in** (cookies/session
         survived the round-trip); the lease auto-acquires for the writable
         session.

4. **Round-trip back to Mac A**
   - [ ] Mac B: modify state, then **Close** the browser — the automatic backup
         publishes on close and auto-releases. Revision increments again.
   - [ ] Mac A: **Launch** (auto-acquire + conflict-checked restore); Mac B's
         change is present.

4b. **Destructive per-profile remote-disable (delete)**
   - [ ] Mac A (browser closed): uncheck **"Sync this profile"**. The renderer
         requires a **strong typed confirmation** — type the exact profile name
         (or id). No exact match → no IPC call.
   - [ ] Confirm the deletion: a durable **tombstone** is written first, then the
         profile's **Kopia snapshot manifests are deleted**, then local
         `syncEnabled` flips to `false`. The **local profile and its data stay**.
   - [ ] Mac B: the next **Sync all** / bootstrap no longer discovers the deleted
         profile (`listProfiles` excludes tombstoned ids); already-restored local
         copies are untouched.
   - [ ] Re-check **"Sync this profile"** on Mac A: it **revives a fresh
         generation**, marks the profile dirty, and re-uploads it as a new backup
         line.
   - [ ] **Fail-closed check**: simulate a delete failure (e.g. storage
         unreachable mid-delete). Local sync must stay **enabled** (no local
         disable) so a retry re-runs the whole flow.

5. **Single-writer enforcement**
   - [ ] Mac A holds the lease. Mac B **Acquire** returns `LeaseHeldByOther`. Mac
         B cannot publish while Mac A owns the lease.

6. **Global Enable Cloud Sync switch**
   - [ ] With **Enable Cloud Sync** off, coordinated ops (enable, Acquire,
         Restore, Backup, Release, Connect Existing) are refused, but a
         **local browser launch of a synced profile is still allowed** and the
         profile is marked `dirty` (`sync:status.dirty == true`).
   - [ ] Turning the switch **off while a synced browser is running under a held
         lease** closes that browser and releases the lease (ownership cleared in
         `state.json`); no stale owner remains.

7. **Conflict — keep both**
   - [ ] Create a divergence: Mac A publishes revision N+1 while Mac B still has
         a **dirty** profile based on revision N.
   - [ ] Mac B **Launch**/**Backup** is refused with `ConflictDetected`.
   - [ ] Mac B **Restore with keep-local-as-conflict** (`sync:restore` with
         `keepLocalAsConflict = true`) creates an unsynced conflict copy named
         `"<name> - Conflict - <Mac B display name>"` and restores the canonical
         revision. **Both** states exist afterward.

8. **Diagnostics hygiene**
   - [ ] `sync:diagnostics` shows secret **presence booleans** only — no secret
         values, no SDK credentials. Progress/error messages contain no secrets
         (redaction).

Acceptance passes when every box is checked and no secret value ever appears in
diagnostics, status, or logs.

## MCP configuration sync — two-machine checklist

Covers the gateway configuration channel (projects, trust, settings, bindings,
credentials, history) rather than browser profiles. See
[mcp-sync.md](./mcp-sync.md) for the design.

**This checklist has not been executed.** It requires two physical machines, a
real bucket, and operator credentials, none of which were available when this was
written. Every step is a procedure to run, not a recorded result.

Call the machines **A** (already set up) and **B** (blank install).

### Trust and first contact

- [ ] On A with Cloud Sync ready, open Projects. The sync row reports cloud sync
      on with a recent pass.
- [ ] On B, complete Settings → Cloud Sync with the same bucket, S3 key pair and
      **the same encryption password**.
- [ ] On A, open **Devices**. B appears as **pending** with the display name B
      announced. Confirm it did not appear before B was configured.
- [ ] Before approving, make an edit on B (rename a project). Confirm on A that
      the edit does **not** arrive, and that A's Sync issues pane records a refusal
      naming B's device id with reason `unknown-signer`.
- [ ] Approve B on A. Re-run sync on A. The previously refused record is now
      accepted with **no republish from B** — approval is retroactive.
- [ ] Revoke B on A, edit on B, sync on A: the new record is refused with
      `revoked-signer`. Re-approve B before continuing.

### Projects, conflicts, deletion

- [ ] Create a project on A with one stdio server. It appears on B after a sync.
- [ ] Disable Cloud Sync connectivity on both (e.g. pull the network), edit the
      **same** project differently on each, restore connectivity, sync both.
      Exactly one edit wins; the other device shows a conflict in **Sync issues**
      with both sides described, and **neither edit is silently lost**.
- [ ] Resolve as "keep mine" on the losing device. Confirm its version becomes
      current on both machines.
- [ ] Delete the project on A. After a sync on B it is gone from B too — confirm
      it does **not** reappear on the next sync (the tombstone must win over B's
      cached head).
- [ ] Recreate a project with the **same id** on B. It publishes successfully and
      reaches A. (This is the `max(head, tombstone)` contiguity case.)

### Settings and bindings

- [ ] Change the theme on A. After a sync it changes on B.
- [ ] Confirm B's **browser engine**, **MCP HTTP port**, device display name and
      bucket settings are **unchanged** by that sync.
- [ ] On B, link a project to a local folder with an agent (e.g. Cursor). Confirm
      the agent config file is written.
- [ ] On A, confirm B's folder does **not** appear as an active binding. If a
      proposals view is surfaced, it must be labelled as another device's layout
      and must not have written anything to A's disk.

### Credentials (opt-in)

- [ ] With credential backup **off** on both, confirm a server on B that
      references `${NAME}` sits inactive with an env error, and that no credential
      value appears anywhere in the bucket (inspect the objects directly).
- [ ] On A, switch credential backup on with a passphrase. Read the on-screen
      statement and confirm it names both costs.
- [ ] On B, restore credentials with that passphrase. The previously inactive
      server **starts without any manual restart**.
- [ ] Attempt the restore on B with a **wrong** passphrase first: it must report a
      wrong passphrase and write nothing.
- [ ] On a third device (or B with a fresh keychain), set a **different**
      passphrase and attempt to enable. It must refuse with a
      wrong-passphrase-style message and leave A's bundle intact and still
      openable from A.
- [ ] Switch backup off on A. Confirm a restore attempt then reports nothing
      stored, and that A's **local** credentials still work.
- [ ] If your bucket has **object versioning** enabled, confirm for yourself
      whether a non-current version of the bundle remains, and apply a lifecycle
      rule if that is not acceptable. MultiZen cannot remove it.

### Configuration history

- [ ] Make three edits to a project on A. Open **History**: three revisions,
      newest first, the current one marked, each with a timestamp.
- [ ] Restore the oldest. Confirm it becomes current as a **new, higher** revision
      and that the intervening revisions are still listed.
- [ ] Sync B. The rolled-back configuration arrives as an ordinary edit — **not**
      quarantined as a rollback.
- [ ] Make more than 20 edits to one project. Confirm History caps at 20 entries,
      the newest is still current and correct, and the project still works.

### Set up this device from a backup

- [ ] On a genuinely blank install **C**, run Settings → Cloud Sync → *Set up this
      device from a backup* with bucket, S3 keys, encryption password and the
      credential passphrase.
- [ ] All seven stages report: storage, trust, settings, projects, bindings,
      credentials, profiles. Stages with nothing to do report **skipped**, not
      failed.
- [ ] C reports **awaiting approval**, and the message explains it can read but
      not publish. Approve C on A and re-run: it now reports publishing allowed.
- [ ] Re-run the whole setup a second time unchanged. It completes again with no
      duplicated projects, folders, or profiles.
- [ ] Run it once with a deliberately wrong bucket: the storage stage fails and
      every later stage stays **pending** rather than repeating the same error.
- [ ] Run it once omitting the credential passphrase: the credentials stage is
      **skipped**, the run still succeeds, and the affected servers are visibly
      waiting for their secrets.
- [ ] Throughout, confirm no supplied secret appears in any stage message, log, or
      exported diagnostics.

## Failure matrix

Verify each row behaves as documented. Store errors normalize to
`StoreErrorKind` (`packages/s3-coordinator/src/store.ts`); coordinator/desktop
codes are `SyncErrorCode` (`packages/sync-core/src/errors.ts`).

| Scenario | Expected behavior | Signal |
| --- | --- | --- |
| Acquire while another Mac owns a valid lease | Refused; other Mac unaffected | `LeaseHeldByOther` |
| Acquire an expired lease within the clock-skew margin | Refused until margin elapses | `LeaseHeldByOther` ("within skew margin") |
| Publish with stale fencing token (after takeover) | Rejected; no overwrite | `LeaseFenced` |
| Publish with wrong `expectedRevision` (concurrent peer publish) | Rejected; no fast-forward | `PublishRejected` |
| Losing CAS on `state.json` (concurrent writer) | Retried from a fresh read; deterministic outcome | internal CAS retry (`runCas`) |
| Publish/restore/release while browser still running | Refused before any Kopia call | `BrowserStillRunning` |
| Publish without an owned/unexpired lease | Refused | `LeaseHeldByOther` / `LeaseExpired` |
| Local dirty + remote advanced past base | Refused; resolve via keep-local conflict | `ConflictDetected` |
| S3 credentials rejected (bad/missing key) | Distinguished from unreachability | `StorageAuthFailed` (401/403) |
| Store unreachable (network/DNS/TLS/5xx down) | Distinguished from auth failure | `StorageUnreachable` |
| Store ignores `If-Match` / `If-None-Match` (capability probe fails) | Writable ops refused up front | `StorageUnreachable` with failing check (`create` / `duplicate-create-precondition` / `cas` / `stale-cas-precondition`) |
| Restore when no committed snapshot exists | Refused | `RevisionNotFound` |
| Corrupt / oversized `state.json` in the bucket | Rejected, not trusted | `Malformed` → `LocalStateCorrupt` |
| Immutable history record write fails after commit | Non-fatal; state remains authoritative | `PublishResult.historyWarning` |
| Encryption password not set | S3 connection test may pass; backup/restore is refused before spawning the backup process | `InvalidInput` ("Set an encryption password before backing up/restoring") |
| First Backup & Publish, repository absent | `ensureRepository` connect reports the pinned "not initialized in the provided storage" → repository created automatically | `EnsureRepositoryResult.created == true` |
| Backup/Restore/Connect Existing, repository exists | `ensureRepository`/connect connects; no creation | `EnsureRepositoryResult.created == false` |
| Connect fails with auth/network/corruption/wrong-password | Propagated unchanged; **never** creates a repository | non-missing-repo `KopiaCommandError` re-thrown |
| Concurrent create race (peer created between connect & create) | One safe reconnect; treated as existing | `EnsureRepositoryResult.created == false` |
| Global **Enable Cloud Sync** off — launch synced profile | Local launch allowed; no lease/storage; profile marked `dirty` | `beforeLaunch` short-circuit, `status.dirty == true` |
| Global **Enable Cloud Sync** off — coordinated op attempted | Refused | `requireGlobalEnabled` throws (`SyncDisabled`) |
| Global **Enable Cloud Sync** turned off with running synced browser | Owned browsers closed; held leases released before disable commits | `stopCoordination` (no stale owner) |
| Lease renewal fails mid-session | Lease dropped; owned synced browser closed | `onLeaseLost` (redacted error emitted) |
| OS sleep / power suspend | All leases dropped; owned browsers closed | `onPowerSuspend` |
| App/Chromium crash mid-workflow | Lease in `state.json` expires (~60 s + skew); profile stays `dirty`; no silent loss | Next `beforeLaunch` re-decides |
| Restore swap fails partway | Atomic rollback; live data intact | `atomicSwap` rollback |
| Snapshot created but publish fails (orphan) | Safe; orphan not restored; `dirty` retained | Orphan snapshot (operator cleanup) |
| Automatic backup on close — dirty profile, unexpired lease held | Publishes automatically; `dirty` cleared, revision advanced; lease **not** released | `onBrowserClosed` → `backupAndPublish` |
| Automatic backup on close — clean / unsynced / global-off / no lease / expired lease | Strict no-op; **never** contacts Kopia/storage | `onBrowserClosed` guard short-circuit |
| Automatic backup on close fails (storage down / conflict) | Profile stays `dirty`; failure journaled + logged (secret-redacted); lease kept; retry via "Back up now" | `runAutoBackup` catch (no unhandled rejection) |
| Duplicate close events for one profile | Deduped to a single snapshot + publish | `onBrowserClosed` joins in-flight `autoBackups` entry |
| Global-disable forced close | Auto backup suppressed while leases are released | `stopCoordination` sets `suppressAutoBackup` |
| App shutdown with an in-flight auto backup | `shutdown()` awaits it before clearing leases/exiting | `before-quit` closeAll → shutdown await |
| Copied R2 endpoint with a `/bucket` path (or query) | Normalized to origin everywhere (coordinator, Kopia `--endpoint`, diagnostics); Kopia no longer errors on a fully-qualified path | `normalizeEndpoint` (single effective-endpoint rule) |
| Malformed / non-http(s) endpoint | Rejected with an actionable error; never silently coerced | `SyncErrorCode.InvalidInput` |
| Idempotent retry of a mutating call | Same result replayed; no duplicate side effects | `operationId` idempotency in `lastOperation` |
| OS secure storage unavailable | Vault construction refuses; no plaintext secrets | `CredentialVault` throws |

## Deferred features

Explicitly **not** in this MVP:

- **Live device presence** — no online/offline indicators; state is read on
  demand from `state.json`.
- **One-click "Move profile here" handoff** — handoff is the manual
  Acquire→Restore sequence.
- **Automatic pull-before-open orchestration** — the launch gate advises and
  can restore-then-launch, but the operator still drives Acquire and Restore.
  (Push-after-close is **no longer deferred**: backups run automatically when
  the browser closes.)
- **Retention policies & automatic orphan/snapshot pruning** — MultiZen does not
  disable or run Kopia maintenance; cleanup/retention is an operator task.
- **First-class version history / point-in-time restore of BROWSER PROFILES in
  the app** — the app restores the latest committed profile snapshot; older
  profile snapshots are reachable only via the Kopia CLI. (MCP **configuration**
  history is no longer deferred: per-project revisions are archived with signed
  timestamps and restorable in-app — see [mcp-sync.md](./mcp-sync.md).)
- **In-app Kopia repository password rotation** — treated as a repository
  migration, not a field change.
- **Credential sync for Cloud Sync's own secrets** — the S3 key pair and the
  encryption password stay device-local, permanently and by design. (Credential
  transfer for **MCP server secrets** is no longer deferred: it is implemented as
  an opt-in, separately-passphrased bundle, off by default — see
  [credential-backup.md](./credential-backup.md).)
- **Live merging of browser databases, simultaneous writable sessions, CRDTs** —
  never; the design keeps both copies on divergence.
- **Windows/Linux acceptance** — the MVP targets macOS first (Keychain-backed
  vault); other platforms are out of scope for this acceptance.
- **MCP registry / local MCP router / folder & agent integrations** — separate
  milestones.

## What was and was not verified for this document

- **Verified against source:** the single-`state.json` model, conditional-write
  semantics (`If-None-Match` create + `If-Match` CAS), capability-probe
  invariants, `StoreErrorKind` → `SyncErrorCode` mapping, lease/fencing/revision
  decision logic, idempotency records, secret handling, and the workflow IPC
  surface — all quoted from files in this repo.
- **Not executed (requires operator credentials/hardware):** live R2/S3
  read/write, the forced capability probe against a real store, and the two-Mac
  end-to-end round-trip. There is **no backend deployment** to verify. Run the
  checklist above in your environment to certify these.
