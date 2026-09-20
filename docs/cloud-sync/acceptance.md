# Acceptance & Failure Matrix

This is the exact acceptance checklist for the manual two-Mac Cloud Sync MVP,
the failure matrix operators should verify, and the explicit list of deferred
features. Coordination is storage-native — there is **no backend to stand up**.

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
- **Test storage coordination passes on each Mac**: store reachable **and** the
  forced conditional-write capability probe succeeds
  (`StorageTestResult.conditionalWritesSupported == true`).
- Separate Kopia object prefix (`s3Prefix`) and coordination control prefix
  (`controlPrefix`) — the app rejects a control prefix that nests inside the
  Kopia prefix.
- Kopia repository **initialized once** (first Mac) and **connectable** by the
  second Mac with the **shared repository password**.
- On each Mac: sync config filled in and all three secrets present in the vault
  (`sync:diagnostics.secretsPresent` all `true`).

## Two-Mac acceptance checklist

Label the machines **Mac A** and **Mac B**. Use one shared test profile with a
site that persists a login/cookie.

1. **Storage bring-up**
   - [ ] Each Mac: **Test storage coordination** passes (health + conditional
         writes). Confirm `conditionalWritesSupported == true`.
   - [ ] Mac A: initialize the Kopia repository (`sync:initializeRepository` →
         `KopiaAdapter.createRepository`). Confirm objects appear under the Kopia
         prefix.
   - [ ] Mac B: connect to the same repository with the same password. Confirm
         success without re-creating.

2. **First publish from Mac A**
   - [ ] Mac A: enable sync for the profile (`sync:enable`).
   - [ ] Mac A: **Acquire** the lease (`sync:acquire`); `sync:status.hasLease` is
         true and `leaseExpiresAt` is ~60 s out. A `state.json` now exists under
         `<controlPrefix>/profiles/<id>/`.
   - [ ] Mac A: **Launch**, log in to the test site, then **Close** the browser
         fully.
   - [ ] Mac A: **Backup & Publish** (`sync:backup`); status shows
         `dirty=false`, `localRevision == baseRevision == remoteRevision` bumped,
         and a non-null `latestSnapshotId`.
   - [ ] Mac A: **Release** (`sync:release`); `hasLease` false. The `state.json`
         object still exists (ownership cleared, revision retained).

3. **Move to Mac B**
   - [ ] Mac B: **Connect existing** the profile by id (`sync:connectExisting`),
         or enable + **Acquire** + **Restore** if the profile already exists
         locally.
   - [ ] Mac B: **Restore** pulls `latestSnapshotId`; the atomic swap completes;
         status shows the same revision as Mac A and `dirty=false`.
   - [ ] Mac B: **Launch** — the test site is **still logged in** (cookies/session
         survived the round-trip).

4. **Round-trip back to Mac A**
   - [ ] Mac B: modify state, **Close**, **Acquire** (if not held), **Backup &
         Publish**, **Release**. Revision increments again.
   - [ ] Mac A: **Acquire** + **Restore**; **Launch**; Mac B's change is present.

5. **Single-writer enforcement**
   - [ ] Mac A holds the lease. Mac B **Acquire** returns `LeaseHeldByOther`. Mac
         B cannot publish while Mac A owns the lease.

6. **Conflict — keep both**
   - [ ] Create a divergence: Mac A publishes revision N+1 while Mac B still has
         a **dirty** profile based on revision N.
   - [ ] Mac B **Launch**/**Backup** is refused with `ConflictDetected`.
   - [ ] Mac B **Restore with keep-local-as-conflict** (`sync:restore` with
         `keepLocalAsConflict = true`) creates an unsynced conflict copy named
         `"<name> - Conflict - <Mac B display name>"` and restores the canonical
         revision. **Both** states exist afterward.

7. **Diagnostics hygiene**
   - [ ] `sync:diagnostics` shows secret **presence booleans** only — no secret
         values, no SDK credentials. Progress/error messages contain no secrets
         (redaction).

Acceptance passes when every box is checked and no secret value ever appears in
diagnostics, status, or logs.

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
| Kopia repository password not set | Refused before spawning Kopia | `InvalidInput` ("password is not set") |
| Lease renewal fails mid-session | Lease dropped; owned synced browser closed | `onLeaseLost` (redacted error emitted) |
| OS sleep / power suspend | All leases dropped; owned browsers closed | `onPowerSuspend` |
| App/Chromium crash mid-workflow | Lease in `state.json` expires (~60 s + skew); profile stays `dirty`; no silent loss | Next `beforeLaunch` re-decides |
| Restore swap fails partway | Atomic rollback; live data intact | `atomicSwap` rollback |
| Snapshot created but publish fails (orphan) | Safe; orphan not restored; `dirty` retained | Orphan snapshot (operator cleanup) |
| Idempotent retry of a mutating call | Same result replayed; no duplicate side effects | `operationId` idempotency in `lastOperation` |
| OS secure storage unavailable | Vault construction refuses; no plaintext secrets | `CredentialVault` throws |

## Deferred features

Explicitly **not** in this manual MVP:

- **Automatic backup on clean browser exit** — MVP requires manual Backup &
  Publish.
- **Live device presence** — no online/offline indicators; state is read on
  demand from `state.json`.
- **One-click "Move profile here" handoff** — handoff is the manual
  Acquire→Restore sequence.
- **Automatic pull-before-open / push-after-close orchestration** — the launch
  gate advises, but the operator drives the steps.
- **Retention policies & automatic orphan/snapshot pruning** — MultiZen does not
  disable or run Kopia maintenance; cleanup/retention is an operator task.
- **First-class version history / point-in-time restore in the app** — the app
  restores the latest committed snapshot; older snapshots are reachable only via
  the Kopia CLI.
- **In-app Kopia repository password rotation** — treated as a repository
  migration, not a field change.
- **Encrypted credential sync / device-to-device credential transfer** — secrets
  stay device-local in the Keychain vault.
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
